using System.Collections.Immutable;
using System.Security.Cryptography;

namespace FsusBlog.Core.Services.Articles;

public enum RevisionMarkdownStructureReadStatus
{
    Available = 0,
    Unavailable = 1,
    Invalid = 2
}

public sealed record RevisionMarkdownHeadingNode(
    int Level,
    int LineIndex,
    RevisionByteRange Source,
    string IdentityDigest);

public sealed record RevisionMarkdownStructureRequest(
    string SourceDigest,
    ImmutableArray<byte> RawMarkdown);

public sealed record RevisionMarkdownStructureSnapshot(
    int SchemaVersion,
    string ParserVersion,
    string SourceDigest,
    ImmutableArray<RevisionMarkdownHeadingNode> Headings,
    string ContentDigest);

public sealed record RevisionMarkdownStructureReadResult(
    RevisionMarkdownStructureReadStatus Status,
    RevisionMarkdownStructureSnapshot? Snapshot)
{
    public static RevisionMarkdownStructureReadResult Unavailable()
        => new(RevisionMarkdownStructureReadStatus.Unavailable, null);

    public static RevisionMarkdownStructureReadResult Invalid()
        => new(RevisionMarkdownStructureReadStatus.Invalid, null);

    public static RevisionMarkdownStructureReadResult Available(RevisionMarkdownStructureSnapshot snapshot)
        => new(RevisionMarkdownStructureReadStatus.Available, snapshot);
}

public interface IRevisionMarkdownStructureProvider
{
    Task<RevisionMarkdownStructureReadResult> ReadAsync(
        RevisionMarkdownStructureRequest request,
        CancellationToken cancellationToken = default);
}

public interface IRevisionMarkdownStructureAuthority
{
    Task<RevisionMarkdownStructureReadResult> ReadAsync(
        RevisionMarkdownStructureRequest request,
        CancellationToken cancellationToken = default);
}

public sealed class RevisionMarkdownStructureAuthority(
    IEnumerable<IRevisionMarkdownStructureProvider> providers) : IRevisionMarkdownStructureAuthority
{
    private readonly IRevisionMarkdownStructureProvider[] _providers = [.. providers];

    public async Task<RevisionMarkdownStructureReadResult> ReadAsync(
        RevisionMarkdownStructureRequest request,
        CancellationToken cancellationToken = default)
    {
        if (_providers.Length == 0)
        {
            return RevisionMarkdownStructureReadResult.Unavailable();
        }
        if (_providers.Length != 1)
        {
            return RevisionMarkdownStructureReadResult.Invalid();
        }

        RevisionMarkdownStructureReadResult result = await _providers[0]
            .ReadAsync(request, cancellationToken)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (result.Status != RevisionMarkdownStructureReadStatus.Available
            || result.Snapshot is null)
        {
            return new RevisionMarkdownStructureReadResult(result.Status, null);
        }
        return RevisionMarkdownStructureSnapshotSeal.Verify(request, result.Snapshot)
            ? result
            : RevisionMarkdownStructureReadResult.Invalid();
    }
}

public static class RevisionMarkdownStructureSnapshotSeal
{
    public const int SchemaVersion = 1;

    public static RevisionMarkdownStructureSnapshot Create(
        RevisionMarkdownStructureRequest request,
        string parserVersion,
        IEnumerable<RevisionMarkdownHeadingNode> headings)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (string.IsNullOrWhiteSpace(parserVersion)
            || !string.Equals(
                request.SourceDigest,
                RevisionCompareCanonical.Sha256(request.RawMarkdown.AsSpan()),
                StringComparison.Ordinal))
        {
            throw new RevisionCompareContractException("revision_diff_structure_invalid");
        }
        ImmutableArray<RevisionMarkdownHeadingNode> materialized = [.. headings];
        if (!ValidHeadings(materialized, request.RawMarkdown))
        {
            throw new RevisionCompareContractException("revision_diff_structure_invalid");
        }
        return new RevisionMarkdownStructureSnapshot(
            SchemaVersion,
            parserVersion,
            request.SourceDigest,
            materialized,
            Digest(parserVersion, request.SourceDigest, materialized));
    }

    public static bool Verify(
        RevisionMarkdownStructureRequest request,
        RevisionMarkdownStructureSnapshot snapshot)
        => snapshot.SchemaVersion == SchemaVersion
            && !string.IsNullOrWhiteSpace(snapshot.ParserVersion)
            && string.Equals(snapshot.SourceDigest, request.SourceDigest, StringComparison.Ordinal)
            && string.Equals(
                request.SourceDigest,
                RevisionCompareCanonical.Sha256(request.RawMarkdown.AsSpan()),
                StringComparison.Ordinal)
            && ValidHeadings(snapshot.Headings, request.RawMarkdown)
            && string.Equals(
                snapshot.ContentDigest,
                Digest(snapshot.ParserVersion, snapshot.SourceDigest, snapshot.Headings),
                StringComparison.Ordinal);

    private static bool ValidHeadings(
        ImmutableArray<RevisionMarkdownHeadingNode> headings,
        ImmutableArray<byte> source)
    {
        int previousLine = -1;
        int previousEnd = 0;
        foreach (RevisionMarkdownHeadingNode heading in headings)
        {
            if (heading.Level is < 1 or > 6
                || heading.LineIndex <= previousLine
                || heading.Source.Offset < previousEnd
                || heading.Source.Offset < 0
                || heading.Source.Length <= 0
                || heading.Source.Offset > source.Length
                || heading.Source.Length > source.Length - heading.Source.Offset
                || !string.Equals(
                    heading.IdentityDigest,
                    RevisionCompareCanonical.Sha256(source.AsSpan(heading.Source.Offset, heading.Source.Length)),
                    StringComparison.Ordinal))
            {
                return false;
            }
            previousLine = heading.LineIndex;
            previousEnd = heading.Source.Offset + heading.Source.Length;
        }
        return true;
    }

    private static string Digest(
        string parserVersion,
        string sourceDigest,
        ImmutableArray<RevisionMarkdownHeadingNode> headings)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        RevisionCompareCanonical.Append(hash, SchemaVersion);
        RevisionCompareCanonical.Append(hash, parserVersion);
        RevisionCompareCanonical.Append(hash, sourceDigest);
        RevisionCompareCanonical.Append(hash, headings.Length);
        foreach (RevisionMarkdownHeadingNode heading in headings)
        {
            RevisionCompareCanonical.Append(hash, heading.Level);
            RevisionCompareCanonical.Append(hash, heading.LineIndex);
            RevisionCompareCanonical.Append(hash, heading.Source.Offset);
            RevisionCompareCanonical.Append(hash, heading.Source.Length);
            RevisionCompareCanonical.Append(hash, heading.IdentityDigest);
        }
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }
}
