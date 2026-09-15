namespace FsusBlog.Core.Services.Articles;

public sealed partial class RevisionSourceDiffEngine
{
    private readonly record struct SourceLine(
        int Offset,
        int ContentLength,
        int TerminatorLength,
        RevisionLineTerminator Terminator)
    {
        public int FullLength => ContentLength + TerminatorLength;
    }

    private readonly record struct LineOccurrence(int Index, int Count);

    private sealed record LineEdit(
        RevisionDiffKind Kind,
        int BaseStart,
        int BaseCount,
        int CompareStart,
        int CompareCount);

}
