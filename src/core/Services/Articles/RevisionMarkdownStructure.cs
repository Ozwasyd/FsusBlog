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
