using System.Collections.Immutable;

namespace FsusBlog.Core.Services.Articles;

public enum RevisionDiffKind
{
    Equal = 0,
    Insert = 1,
    Delete = 2,
    Replace = 3
}

public enum RevisionLineTerminator
{
    None = 0,
    LineFeed = 1,
    CarriageReturnLineFeed = 2,
    CarriageReturn = 3
}

public sealed record RevisionByteRange(int Offset, int Length)
{
    public int End => checked(Offset + Length);
}

public sealed record RevisionDiffWordEdit(
    RevisionDiffKind Kind,
    RevisionByteRange Base,
    RevisionByteRange Compare);

public sealed record RevisionDiffLine(
    int Index,
    RevisionByteRange Content,
    RevisionByteRange Terminator,
    RevisionLineTerminator TerminatorKind);

public sealed record RevisionDiffHeading(
    int Level,
    int LineIndex,
    RevisionByteRange Source,
    string IdentityDigest);
