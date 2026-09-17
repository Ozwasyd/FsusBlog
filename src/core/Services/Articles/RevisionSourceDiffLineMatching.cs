using System.Collections.Immutable;

namespace FsusBlog.Core.Services.Articles;

public sealed partial class RevisionSourceDiffEngine
{
    private static ImmutableArray<SourceLine> SplitLines(
        ReadOnlySpan<byte> source,
        CancellationToken cancellationToken)
    {
        if (source.IsEmpty)
        {
            return [];
        }

        var lines = ImmutableArray.CreateBuilder<SourceLine>();
        int start = 0;
        for (int index = 0; index < source.Length; index++)
        {
            if ((index & 4095) == 0)
            {
                cancellationToken.ThrowIfCancellationRequested();
            }
            RevisionLineTerminator terminator;
            int terminatorLength;
            if (source[index] == (byte)'\n')
            {
                terminator = RevisionLineTerminator.LineFeed;
                terminatorLength = 1;
            }
            else if (source[index] == (byte)'\r')
            {
                bool crlf = index + 1 < source.Length && source[index + 1] == (byte)'\n';
                terminator = crlf ? RevisionLineTerminator.CarriageReturnLineFeed : RevisionLineTerminator.CarriageReturn;
                terminatorLength = crlf ? 2 : 1;
            }
            else
            {
                continue;
            }

            int contentLength = index - start;
            lines.Add(new SourceLine(start, contentLength, terminatorLength, terminator));
            index += terminatorLength - 1;
            start = index + 1;
        }
        if (start < source.Length)
        {
            lines.Add(new SourceLine(start, source.Length - start, 0, RevisionLineTerminator.None));
        }
        return lines.ToImmutable();
    }

    private static List<LineEdit> CreateLineEdits(
        ReadOnlySpan<byte> baseSource,
        ImmutableArray<SourceLine> baseLines,
        ReadOnlySpan<byte> compareSource,
        ImmutableArray<SourceLine> compareLines,
        CancellationToken cancellationToken)
    {
        int prefix = 0;
        while (prefix < baseLines.Length
            && prefix < compareLines.Length
            && LineEquals(baseSource, baseLines[prefix], compareSource, compareLines[prefix]))
        {
            prefix++;
        }
        int suffix = 0;
        while (suffix < baseLines.Length - prefix
            && suffix < compareLines.Length - prefix
            && LineEquals(
                baseSource,
                baseLines[baseLines.Length - suffix - 1],
                compareSource,
                compareLines[compareLines.Length - suffix - 1]))
        {
            suffix++;
        }

        var edits = new List<LineEdit>();
        AddEdit(edits, RevisionDiffKind.Equal, 0, prefix, 0, prefix);
        int baseEnd = baseLines.Length - suffix;
        int compareEnd = compareLines.Length - suffix;
        List<(int Base, int Compare)> anchors = UniqueAnchors(
            baseSource,
            baseLines,
            prefix,
            baseEnd,
            compareSource,
            compareLines,
            prefix,
            compareEnd,
            cancellationToken);
        int baseCursor = prefix;
        int compareCursor = prefix;
        foreach ((int baseAnchor, int compareAnchor) in anchors)
        {
            AddChange(edits, baseCursor, baseAnchor - baseCursor, compareCursor, compareAnchor - compareCursor);
            AddEdit(edits, RevisionDiffKind.Equal, baseAnchor, 1, compareAnchor, 1);
            baseCursor = baseAnchor + 1;
            compareCursor = compareAnchor + 1;
        }
        AddChange(edits, baseCursor, baseEnd - baseCursor, compareCursor, compareEnd - compareCursor);
        AddEdit(edits, RevisionDiffKind.Equal, baseEnd, suffix, compareEnd, suffix);
        return edits;
    }

    private static List<(int Base, int Compare)> UniqueAnchors(
        ReadOnlySpan<byte> baseSource,
        ImmutableArray<SourceLine> baseLines,
        int baseStart,
        int baseEnd,
        ReadOnlySpan<byte> compareSource,
        ImmutableArray<SourceLine> compareLines,
        int compareStart,
        int compareEnd,
        CancellationToken cancellationToken)
    {
        var baseKeys = CountLineKeys(baseSource, baseLines, baseStart, baseEnd, cancellationToken);
        var compareKeys = CountLineKeys(compareSource, compareLines, compareStart, compareEnd, cancellationToken);
        var candidates = new List<(int Base, int Compare)>();
        foreach ((ulong key, LineOccurrence left) in baseKeys)
        {
            if (left.Count == 1
                && compareKeys.TryGetValue(key, out LineOccurrence right)
                && right.Count == 1
                && LineEquals(baseSource, baseLines[left.Index], compareSource, compareLines[right.Index]))
            {
                candidates.Add((left.Index, right.Index));
            }
        }
        candidates.Sort(static (left, right) => left.Base.CompareTo(right.Base));
        return LongestIncreasingSubsequence(candidates);
    }

    private static Dictionary<ulong, LineOccurrence> CountLineKeys(
        ReadOnlySpan<byte> source,
        ImmutableArray<SourceLine> lines,
        int start,
        int end,
        CancellationToken cancellationToken)
    {
        var result = new Dictionary<ulong, LineOccurrence>();
        for (int index = start; index < end; index++)
        {
            if ((index & 1023) == 0)
            {
                cancellationToken.ThrowIfCancellationRequested();
            }
            SourceLine line = lines[index];
            ulong key = Fnv1a(source.Slice(line.Offset, line.FullLength));
            result[key] = result.TryGetValue(key, out LineOccurrence existing)
                ? existing with
                {
                    Count = existing.Count + 1
                }
                : new LineOccurrence(index, 1);
        }
        return result;
    }

    private static List<(int Base, int Compare)> LongestIncreasingSubsequence(
        List<(int Base, int Compare)> candidates)
    {
        if (candidates.Count == 0)
        {
            return [];
        }
        int[] tails = new int[candidates.Count];
        int[] previous = Enumerable.Repeat(-1, candidates.Count).ToArray();
        int length = 0;
        for (int index = 0; index < candidates.Count; index++)
        {
            int low = 0;
            int high = length;
            while (low < high)
            {
                int middle = (low + high) / 2;
                if (candidates[tails[middle]].Compare < candidates[index].Compare)
                {
                    low = middle + 1;
                }
                else
                {
                    high = middle;
                }
            }
            if (low > 0)
            {
                previous[index] = tails[low - 1];
            }
            tails[low] = index;
            if (low == length)
            {
                length++;
            }
        }
        var result = new (int Base, int Compare)[length];
        for (int cursor = tails[length - 1], output = length - 1; output >= 0; output--)
        {
            result[output] = candidates[cursor];
            cursor = previous[cursor];
        }
        return [.. result];
    }

}
