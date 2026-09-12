using System.Collections.Immutable;
using System.Security.Cryptography;

namespace FsusBlog.Core.Services.Articles;

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
