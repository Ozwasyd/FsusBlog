using System.Collections.Immutable;

namespace FsusBlog.Core.Services.Articles;

public static partial class RevisionSourceDiffVerifier
{
    private static bool ValidContextGroups(
        RevisionComparePlanBundle bundle,
        RevisionSourceDiffResult result)
    {
        RevisionDiffHunk[] hunks = [.. result.Chunks.SelectMany(static chunk => chunk.Hunks)];
        int groupIndex = 0;
        for (int index = 0; index < hunks.Length; index++)
        {
            RevisionDiffHunk hunk = hunks[index];
            if (hunk.Kind != RevisionDiffKind.Equal)
            {
                continue;
            }
            bool followsChange = index > 0 && hunks[index - 1].Kind != RevisionDiffKind.Equal;
            bool precedesChange = index + 1 < hunks.Length && hunks[index + 1].Kind != RevisionDiffKind.Equal;
            int leadingVisible = followsChange
                ? Math.Min(bundle.Plan.Options.ContextLineCount, hunk.BaseLineCount)
                : 0;
            int trailingVisible = precedesChange
                ? Math.Min(bundle.Plan.Options.ContextLineCount, hunk.BaseLineCount - leadingVisible)
                : 0;
            int collapsedCount = hunk.BaseLineCount - leadingVisible - trailingVisible;
            if (!MatchContextGroup(result, ref groupIndex, false,
                    hunk.BaseStartLine, leadingVisible, hunk.CompareStartLine, leadingVisible)
                || !MatchContextGroup(result, ref groupIndex, true,
                    hunk.BaseStartLine + leadingVisible,
                    collapsedCount,
                    hunk.CompareStartLine + leadingVisible,
                    collapsedCount)
                || !MatchContextGroup(result, ref groupIndex, false,
                    hunk.BaseStartLine + leadingVisible + collapsedCount,
                    trailingVisible,
                    hunk.CompareStartLine + leadingVisible + collapsedCount,
                    trailingVisible))
            {
                return false;
            }
        }
        return groupIndex == result.ContextGroups.Length;
    }

    private static bool MatchContextGroup(
        RevisionSourceDiffResult result,
        ref int groupIndex,
        bool collapsed,
        int baseStart,
        int baseCount,
        int compareStart,
        int compareCount)
    {
        if (baseCount == 0 && compareCount == 0)
        {
            return true;
        }
        if (groupIndex >= result.ContextGroups.Length)
        {
            return false;
        }
        RevisionDiffContextGroup group = result.ContextGroups[groupIndex];
        RevisionByteRange baseRange = RangeFromLines(
            result.BaseLines,
            baseStart,
            baseCount,
            result.Receipt.BaseSourceByteCount);
        RevisionByteRange compareRange = RangeFromLines(
            result.CompareLines,
            compareStart,
            compareCount,
            result.Receipt.CompareSourceByteCount);
        string digest = RevisionSourceDiffEngine.CreateContextGroupDigest(
            groupIndex,
            collapsed,
            baseStart,
            baseCount,
            compareStart,
            compareCount,
            baseRange,
            compareRange);
        bool matches = group.Index == groupIndex
            && group.Collapsed == collapsed
            && group.BaseStartLine == baseStart
            && group.BaseLineCount == baseCount
            && group.CompareStartLine == compareStart
            && group.CompareLineCount == compareCount
            && group.Base == baseRange
            && group.Compare == compareRange
            && string.Equals(group.ContentDigest, digest, StringComparison.Ordinal);
        groupIndex++;
        return matches;
    }

    private static RevisionByteRange RangeFromLines(
        ImmutableArray<RevisionDiffLine> lines,
        int start,
        int count,
        int sourceLength)
    {
        if (start < 0 || count < 0 || start > lines.Length || count > lines.Length - start)
        {
            return new RevisionByteRange(-1, -1);
        }
        int offset = start < lines.Length ? lines[start].Content.Offset : sourceLength;
        if (offset < 0 || offset > sourceLength)
        {
            return new RevisionByteRange(-1, -1);
        }
        if (count == 0)
        {
            return new RevisionByteRange(offset, 0);
        }
        RevisionDiffLine last = lines[start + count - 1];
        long end = (long)last.Terminator.Offset + last.Terminator.Length;
        return last.Terminator.Offset < 0
            || last.Terminator.Length < 0
            || end < offset
            || end > sourceLength
                ? new RevisionByteRange(-1, -1)
                : new RevisionByteRange(offset, checked((int)end - offset));
    }

    private static bool ValidLines(ImmutableArray<RevisionDiffLine> lines, ImmutableArray<byte> source)
    {
        int cursor = 0;
        for (int index = 0; index < lines.Length; index++)
        {
            RevisionDiffLine line = lines[index];
            int expectedTerminatorLength = line.TerminatorKind switch
            {
                RevisionLineTerminator.None => 0,
                RevisionLineTerminator.CarriageReturnLineFeed => 2,
                RevisionLineTerminator.LineFeed or RevisionLineTerminator.CarriageReturn => 1,
                _ => -1
            };
            if (line.Index != index
                || expectedTerminatorLength < 0
                || line.Content.Offset != cursor
                || line.Content.Length < 0
                || line.Content.Length > source.Length - cursor
                || line.Terminator.Offset != cursor + line.Content.Length
                || line.Terminator.Length < 0
                || line.Terminator.Length != expectedTerminatorLength
                || line.Terminator.Offset < 0
                || line.Terminator.Offset > source.Length
                || line.Terminator.Length > source.Length - line.Terminator.Offset)
            {
                return false;
            }
            ReadOnlySpan<byte> terminator = source.AsSpan(line.Terminator.Offset, line.Terminator.Length);
            bool terminatorMatches = line.TerminatorKind switch
            {
                RevisionLineTerminator.None => terminator.IsEmpty,
                RevisionLineTerminator.LineFeed => terminator.SequenceEqual([(byte)'\n']),
                RevisionLineTerminator.CarriageReturn => terminator.SequenceEqual([(byte)'\r']),
                RevisionLineTerminator.CarriageReturnLineFeed => terminator.SequenceEqual([(byte)'\r', (byte)'\n']),
                _ => false
            };
            if (!terminatorMatches)
            {
                return false;
            }
            cursor = line.Terminator.Offset + line.Terminator.Length;
        }
        return cursor == source.Length;
    }

    private static bool ValidHeadings(
        ImmutableArray<RevisionDiffHeading> headings,
        ImmutableArray<byte> source,
        ImmutableArray<RevisionDiffLine> lines)
    {
        int previousLine = -1;
        foreach (RevisionDiffHeading heading in headings)
        {
            if (heading.Level is < 1 or > 6
                || heading.LineIndex <= previousLine
                || heading.LineIndex >= lines.Length
                || heading.Source.Offset < 0
                || heading.Source.Length <= 0
                || heading.Source.Offset != lines[heading.LineIndex].Content.Offset
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
        }
        return true;
    }

}
