using System.Collections.Immutable;

namespace FsusBlog.Core.Services.Articles;

public sealed partial class RevisionSourceDiffEngine
{
    private static ImmutableArray<RevisionDiffHeading> ProjectHeadings(
        RevisionMarkdownStructureSnapshot? structure)
        => structure is null
            ? []
            : structure.Headings
                .Select(static heading => new RevisionDiffHeading(
                    heading.Level,
                    heading.LineIndex,
                    heading.Source,
                    heading.IdentityDigest))
                .ToImmutableArray();

    private static bool ValidStructureCoordinates(
        RevisionMarkdownStructureSnapshot? structure,
        ImmutableArray<SourceLine> lines,
        int sourceLength)
    {
        if (structure is null)
        {
            return true;
        }
        foreach (RevisionMarkdownHeadingNode heading in structure.Headings)
        {
            if (heading.LineIndex < 0
                || heading.LineIndex >= lines.Length
                || heading.Source.Offset != lines[heading.LineIndex].Offset
                || heading.Source.Length > sourceLength - heading.Source.Offset)
            {
                return false;
            }
        }
        return true;
    }

    private static ImmutableArray<RevisionDiffContextGroup> CreateContextGroups(
        IReadOnlyList<RevisionDiffHunk> hunks,
        ImmutableArray<SourceLine> baseLines,
        ImmutableArray<SourceLine> compareLines,
        int baseSourceLength,
        int compareSourceLength,
        int contextLineCount,
        CancellationToken cancellationToken)
    {
        var groups = ImmutableArray.CreateBuilder<RevisionDiffContextGroup>();
        for (int index = 0; index < hunks.Count; index++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            RevisionDiffHunk hunk = hunks[index];
            if (hunk.Kind != RevisionDiffKind.Equal)
            {
                continue;
            }

            bool followsChange = index > 0 && hunks[index - 1].Kind != RevisionDiffKind.Equal;
            bool precedesChange = index + 1 < hunks.Count && hunks[index + 1].Kind != RevisionDiffKind.Equal;
            int leadingVisible = followsChange ? Math.Min(contextLineCount, hunk.BaseLineCount) : 0;
            int trailingVisible = precedesChange
                ? Math.Min(contextLineCount, hunk.BaseLineCount - leadingVisible)
                : 0;
            AddContextGroup(groups, false, hunk.BaseStartLine, leadingVisible, hunk.CompareStartLine, leadingVisible,
                baseLines, compareLines, baseSourceLength, compareSourceLength);
            int collapsedCount = hunk.BaseLineCount - leadingVisible - trailingVisible;
            AddContextGroup(
                groups,
                true,
                hunk.BaseStartLine + leadingVisible,
                collapsedCount,
                hunk.CompareStartLine + leadingVisible,
                collapsedCount,
                baseLines,
                compareLines,
                baseSourceLength,
                compareSourceLength);
            AddContextGroup(
                groups,
                false,
                hunk.BaseStartLine + leadingVisible + collapsedCount,
                trailingVisible,
                hunk.CompareStartLine + leadingVisible + collapsedCount,
                trailingVisible,
                baseLines,
                compareLines,
                baseSourceLength,
                compareSourceLength);
        }
        return groups.ToImmutable();
    }

    private static void AddContextGroup(
        ImmutableArray<RevisionDiffContextGroup>.Builder groups,
        bool collapsed,
        int baseStart,
        int baseCount,
        int compareStart,
        int compareCount,
        ImmutableArray<SourceLine> baseLines,
        ImmutableArray<SourceLine> compareLines,
        int baseSourceLength,
        int compareSourceLength)
    {
        if (baseCount == 0 && compareCount == 0)
        {
            return;
        }
        RevisionByteRange baseRange = Range(baseLines, baseStart, baseCount, baseSourceLength);
        RevisionByteRange compareRange = Range(compareLines, compareStart, compareCount, compareSourceLength);
        int index = groups.Count;
        groups.Add(new RevisionDiffContextGroup(
            index,
            collapsed,
            baseStart,
            baseCount,
            compareStart,
            compareCount,
            baseRange,
            compareRange,
            CreateContextGroupDigest(index, collapsed, baseStart, baseCount, compareStart, compareCount, baseRange, compareRange)));
    }

    private static RevisionByteRange Range(
        ImmutableArray<SourceLine> lines,
        int start,
        int count,
        int sourceLength)
    {
        int offset = start < lines.Length ? lines[start].Offset : sourceLength;
        if (count == 0)
        {
            return new RevisionByteRange(offset, 0);
        }
        SourceLine last = lines[start + count - 1];
        return new RevisionByteRange(offset, last.Offset + last.FullLength - offset);
    }

    private static ImmutableArray<RevisionDiffLine> ProjectLines(ImmutableArray<SourceLine> lines)
        => lines.Select(static (line, index) => new RevisionDiffLine(
                index,
                new RevisionByteRange(line.Offset, line.ContentLength),
                new RevisionByteRange(line.Offset + line.ContentLength, line.TerminatorLength),
                line.Terminator))
            .ToImmutableArray();

    private static RevisionByteRange TokenRange(
        List<TextToken> tokens,
        int start,
        int count,
        int sourceEnd)
    {
        int offset = start < tokens.Count ? tokens[start].Offset : sourceEnd;
        if (count == 0)
        {
            return new RevisionByteRange(offset, 0);
        }
        TextToken last = tokens[start + count - 1];
        return new RevisionByteRange(offset, last.Offset + last.Length - offset);
    }

    private static void AddChange(List<LineEdit> edits, int baseStart, int baseCount, int compareStart, int compareCount)
    {
        RevisionDiffKind kind = baseCount == 0
            ? RevisionDiffKind.Insert
            : compareCount == 0
                ? RevisionDiffKind.Delete
                : RevisionDiffKind.Replace;
        AddEdit(edits, kind, baseStart, baseCount, compareStart, compareCount);
    }

    private static void AddEdit(
        List<LineEdit> edits,
        RevisionDiffKind kind,
        int baseStart,
        int baseCount,
        int compareStart,
        int compareCount)
    {
        if (baseCount == 0 && compareCount == 0)
        {
            return;
        }
        if (edits.Count > 0)
        {
            LineEdit previous = edits[^1];
            if (previous.Kind == kind
                && previous.BaseStart + previous.BaseCount == baseStart
                && previous.CompareStart + previous.CompareCount == compareStart)
            {
                edits[^1] = previous with
                {
                    BaseCount = previous.BaseCount + baseCount,
                    CompareCount = previous.CompareCount + compareCount
                };
                return;
            }
        }
        edits.Add(new LineEdit(kind, baseStart, baseCount, compareStart, compareCount));
    }

    private static bool LineEquals(
        ReadOnlySpan<byte> leftSource,
        SourceLine left,
        ReadOnlySpan<byte> rightSource,
        SourceLine right)
        => leftSource.Slice(left.Offset, left.FullLength)
            .SequenceEqual(rightSource.Slice(right.Offset, right.FullLength));

    private static bool Overlaps(RevisionByteRange left, RevisionByteRange right)
        => left.Length > 0 && right.Length > 0 && left.Offset < right.End && right.Offset < left.End;

    private static IEnumerable<string> EnclosingHeading(
        ImmutableArray<RevisionDiffHeading> headings,
        int lineIndex)
    {
        for (int index = headings.Length - 1; index >= 0; index--)
        {
            if (headings[index].LineIndex <= lineIndex)
            {
                return [headings[index].IdentityDigest];
            }
        }
        return [];
    }

    private static ulong Fnv1a(ReadOnlySpan<byte> bytes)
    {
        const ulong Offset = 14695981039346656037UL;
        const ulong Prime = 1099511628211UL;
        ulong hash = Offset;
        foreach (byte value in bytes)
        {
            hash ^= value;
            hash *= Prime;
        }
        return hash;
    }

}
