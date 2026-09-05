using System.Collections.Immutable;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

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

public sealed record RevisionDiffHunk(
    RevisionDiffKind Kind,
    int BaseStartLine,
    int BaseLineCount,
    int CompareStartLine,
    int CompareLineCount,
    RevisionByteRange Base,
    RevisionByteRange Compare,
    ImmutableArray<RevisionDiffWordEdit> WordEdits,
    ImmutableArray<string> HeadingIdentities);

public sealed record RevisionDiffChunk(
    int Index,
    ImmutableArray<RevisionDiffHunk> Hunks,
    string ContentDigest);

public sealed record RevisionSourceDiffReceipt(
    int SchemaVersion,
    string EngineVersion,
    RevisionComparePlanStatus Status,
    string ReasonCode,
    string PlanDigest,
    string BaseSourceDigest,
    string CompareSourceDigest,
    int TokenCount,
    int HunkCount,
    int ChunkCount,
    string ContentDigest);

public sealed record RevisionSourceDiffResult(
    RevisionComparePlanStatus Status,
    ImmutableArray<RevisionDiffChunk> Chunks,
    ImmutableArray<RevisionDiffLine> BaseLines,
    ImmutableArray<RevisionDiffLine> CompareLines,
    ImmutableArray<RevisionDiffHeading> BaseHeadings,
    ImmutableArray<RevisionDiffHeading> CompareHeadings,
    RevisionSourceDiffReceipt Receipt)
{
    public bool IsSuccess => Status == RevisionComparePlanStatus.Accepted;
}

public sealed class RevisionSourceDiffEngine(RevisionComparePlanVerifier planVerifier)
{
    public async Task<RevisionSourceDiffResult> ComputeAsync(
        RevisionComparePlanBundle bundle,
        DateTimeOffset observedAtUtc,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(bundle);
        RevisionComparePlanVerification verification = await planVerifier.VerifyAsync(
                bundle,
                observedAtUtc,
                cancellationToken)
            .ConfigureAwait(false);
        if (!verification.Valid)
        {
            return Failure(bundle, verification.Status, verification.ReasonCode);
        }

        using var timeout = new CancellationTokenSource(bundle.Plan.Budgets.TimeoutMilliseconds);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeout.Token);
        try
        {
            RevisionSourceDiffResult result = await Task.Run(
                    () => ComputeVerified(bundle, linked.Token),
                    linked.Token)
                .ConfigureAwait(false);
            linked.Token.ThrowIfCancellationRequested();
            if (DateTimeOffset.UtcNow > bundle.Plan.ExpiresAtUtc)
            {
                return Failure(bundle, RevisionComparePlanStatus.Stale, "revision_compare_plan_expired");
            }
            return result;
        }
        catch (OperationCanceledException)
        {
            string reason = timeout.IsCancellationRequested && !cancellationToken.IsCancellationRequested
                ? "revision_diff_timeout"
                : "revision_diff_cancelled";
            return Failure(bundle, RevisionComparePlanStatus.Cancelled, reason);
        }
    }

    private static RevisionSourceDiffResult ComputeVerified(
        RevisionComparePlanBundle bundle,
        CancellationToken cancellationToken)
    {
        RevisionCompareBudgets budgets = bundle.Plan.Budgets;
        ImmutableArray<SourceLine> baseLines = SplitLines(bundle.BasePackage.RawMarkdown.AsSpan(), cancellationToken);
        ImmutableArray<SourceLine> compareLines = SplitLines(bundle.ComparePackage.RawMarkdown.AsSpan(), cancellationToken);
        long estimatedMemory = ((long)bundle.BasePackage.RawMarkdown.Length + bundle.ComparePackage.RawMarkdown.Length) * 3L
            + ((long)baseLines.Length + compareLines.Length) * 96L;
        if (estimatedMemory > budgets.MaxMemoryBytes)
        {
            return Failure(bundle, RevisionComparePlanStatus.BudgetExceeded, "revision_diff_memory_budget_exceeded");
        }

        List<LineEdit> edits = CreateLineEdits(
            bundle.BasePackage.RawMarkdown.AsSpan(),
            baseLines,
            bundle.ComparePackage.RawMarkdown.AsSpan(),
            compareLines,
            cancellationToken);
        ImmutableArray<RevisionDiffHeading> baseHeadings = bundle.Plan.Options.HeadingNavigation
            ? ParseHeadings(bundle.BasePackage.RawMarkdown.AsSpan(), baseLines, cancellationToken)
            : [];
        ImmutableArray<RevisionDiffHeading> compareHeadings = bundle.Plan.Options.HeadingNavigation
            ? ParseHeadings(bundle.ComparePackage.RawMarkdown.AsSpan(), compareLines, cancellationToken)
            : [];

        var hunks = ImmutableArray.CreateBuilder<RevisionDiffHunk>(edits.Count);
        int tokenCount = 0;
        foreach (LineEdit edit in edits)
        {
            cancellationToken.ThrowIfCancellationRequested();
            RevisionByteRange baseRange = Range(baseLines, edit.BaseStart, edit.BaseCount, bundle.BasePackage.RawMarkdown.Length);
            RevisionByteRange compareRange = Range(compareLines, edit.CompareStart, edit.CompareCount, bundle.ComparePackage.RawMarkdown.Length);
            ImmutableArray<RevisionDiffWordEdit> words = [];
            if (edit.Kind == RevisionDiffKind.Replace)
            {
                WordDiffResult wordDiff = CreateWordEdits(
                    bundle.BasePackage.RawMarkdown.AsSpan(baseRange.Offset, baseRange.Length),
                    baseRange.Offset,
                    bundle.ComparePackage.RawMarkdown.AsSpan(compareRange.Offset, compareRange.Length),
                    compareRange.Offset,
                    budgets.MaxTokenCount - tokenCount,
                    cancellationToken);
                if (wordDiff.BudgetExceeded)
                {
                    return Failure(bundle, RevisionComparePlanStatus.BudgetExceeded, "revision_diff_token_budget_exceeded");
                }
                tokenCount += wordDiff.TokenCount;
                words = wordDiff.Edits;
            }

            IEnumerable<string> enclosingHeadings = EnclosingHeading(baseHeadings, edit.BaseStart)
                .Concat(EnclosingHeading(compareHeadings, edit.CompareStart));
            ImmutableArray<string> headingIds = enclosingHeadings
                .Concat(baseHeadings
                .Where(heading => Overlaps(baseRange, heading.Source))
                .Select(static heading => heading.IdentityDigest)
                .Concat(compareHeadings
                    .Where(heading => Overlaps(compareRange, heading.Source))
                    .Select(static heading => heading.IdentityDigest)))
                .Distinct(StringComparer.Ordinal)
                .ToImmutableArray();
            hunks.Add(new RevisionDiffHunk(
                edit.Kind,
                edit.BaseStart,
                edit.BaseCount,
                edit.CompareStart,
                edit.CompareCount,
                baseRange,
                compareRange,
                words,
                headingIds));
        }

        long estimatedOutput = hunks.Count * 192L
            + hunks.Sum(static hunk => (long)hunk.WordEdits.Length * 80L + hunk.HeadingIdentities.Length * 72L)
            + (baseHeadings.Length + compareHeadings.Length) * 96L;
        int chunkCount = hunks.Count == 0 ? 0 : (hunks.Count + budgets.MaxHunksPerChunk - 1) / budgets.MaxHunksPerChunk;
        if (estimatedOutput > budgets.MaxOutputBytes || chunkCount > budgets.MaxChunks)
        {
            return Failure(bundle, RevisionComparePlanStatus.BudgetExceeded, "revision_diff_output_budget_exceeded");
        }

        var chunks = ImmutableArray.CreateBuilder<RevisionDiffChunk>(chunkCount);
        for (int offset = 0, index = 0; offset < hunks.Count; offset += budgets.MaxHunksPerChunk, index++)
        {
            ImmutableArray<RevisionDiffHunk> items = hunks
                .Skip(offset)
                .Take(budgets.MaxHunksPerChunk)
                .ToImmutableArray();
            chunks.Add(new RevisionDiffChunk(index, items, DigestChunk(index, items)));
        }

        RevisionSourceDiffReceipt receipt = Receipt(
            bundle,
            RevisionComparePlanStatus.Accepted,
            "accepted",
            tokenCount,
            hunks.Count,
            chunks.Count,
            chunks.Select(static chunk => chunk.ContentDigest));
        return new RevisionSourceDiffResult(
            RevisionComparePlanStatus.Accepted,
            chunks.MoveToImmutable(),
            ProjectLines(baseLines),
            ProjectLines(compareLines),
            baseHeadings,
            compareHeadings,
            receipt);
    }

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

    private static WordDiffResult CreateWordEdits(
        ReadOnlySpan<byte> baseBytes,
        int baseOffset,
        ReadOnlySpan<byte> compareBytes,
        int compareOffset,
        int remainingTokenBudget,
        CancellationToken cancellationToken)
    {
        if (!TryTokenize(baseBytes, baseOffset, out List<TextToken>? baseTokens)
            || !TryTokenize(compareBytes, compareOffset, out List<TextToken>? compareTokens))
        {
            return new WordDiffResult([], 0, false);
        }
        int tokenCount = baseTokens.Count + compareTokens.Count;
        if (tokenCount > remainingTokenBudget)
        {
            return new WordDiffResult([], tokenCount, true);
        }

        int prefix = 0;
        while (prefix < baseTokens.Count
            && prefix < compareTokens.Count
            && string.Equals(baseTokens[prefix].Value, compareTokens[prefix].Value, StringComparison.Ordinal))
        {
            prefix++;
        }
        int suffix = 0;
        while (suffix < baseTokens.Count - prefix
            && suffix < compareTokens.Count - prefix
            && string.Equals(
                baseTokens[baseTokens.Count - suffix - 1].Value,
                compareTokens[compareTokens.Count - suffix - 1].Value,
                StringComparison.Ordinal))
        {
            suffix++;
        }
        int baseCount = baseTokens.Count - prefix - suffix;
        int compareCount = compareTokens.Count - prefix - suffix;
        if (baseCount == 0 && compareCount == 0)
        {
            return new WordDiffResult([], tokenCount, false);
        }
        RevisionDiffKind kind = baseCount == 0
            ? RevisionDiffKind.Insert
            : compareCount == 0
                ? RevisionDiffKind.Delete
                : RevisionDiffKind.Replace;
        return new WordDiffResult(
            [new RevisionDiffWordEdit(
                kind,
                TokenRange(baseTokens, prefix, baseCount, baseOffset + baseBytes.Length),
                TokenRange(compareTokens, prefix, compareCount, compareOffset + compareBytes.Length))],
            tokenCount,
            false);
    }

    private static bool TryTokenize(ReadOnlySpan<byte> bytes, int absoluteOffset, out List<TextToken> tokens)
    {
        tokens = [];
        string text;
        try
        {
            text = new UTF8Encoding(false, true).GetString(bytes);
        }
        catch (DecoderFallbackException)
        {
            return false;
        }
        TextElementEnumerator enumerator = StringInfo.GetTextElementEnumerator(text);
        int byteOffset = absoluteOffset;
        while (enumerator.MoveNext())
        {
            string value = enumerator.GetTextElement();
            int byteLength = Encoding.UTF8.GetByteCount(value);
            TextTokenClass tokenClass = Classify(value);
            if (tokens.Count > 0
                && tokenClass is TextTokenClass.Word or TextTokenClass.Whitespace
                && tokens[^1].Class == tokenClass)
            {
                TextToken previous = tokens[^1];
                tokens[^1] = previous with
                {
                    Value = string.Concat(previous.Value, value),
                    Length = previous.Length + byteLength
                };
            }
            else
            {
                tokens.Add(new TextToken(value, byteOffset, byteLength, tokenClass));
            }
            byteOffset += byteLength;
        }
        return true;
    }

    private static TextTokenClass Classify(string textElement)
    {
        if (textElement.All(char.IsWhiteSpace))
        {
            return TextTokenClass.Whitespace;
        }
        UnicodeCategory category = char.GetUnicodeCategory(textElement, 0);
        return category is UnicodeCategory.UppercaseLetter
            or UnicodeCategory.LowercaseLetter
            or UnicodeCategory.TitlecaseLetter
            or UnicodeCategory.ModifierLetter
            or UnicodeCategory.OtherLetter
            or UnicodeCategory.DecimalDigitNumber
            or UnicodeCategory.LetterNumber
            or UnicodeCategory.OtherNumber
            or UnicodeCategory.NonSpacingMark
            or UnicodeCategory.SpacingCombiningMark
            ? TextTokenClass.Word
            : TextTokenClass.Symbol;
    }

    private static ImmutableArray<RevisionDiffHeading> ParseHeadings(
        ReadOnlySpan<byte> source,
        ImmutableArray<SourceLine> lines,
        CancellationToken cancellationToken)
    {
        var headings = ImmutableArray.CreateBuilder<RevisionDiffHeading>();
        byte fenceMarker = 0;
        int fenceLength = 0;
        for (int index = 0; index < lines.Length; index++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            SourceLine line = lines[index];
            ReadOnlySpan<byte> content = source.Slice(line.Offset, line.ContentLength);
            int indent = LeadingSpaces(content, 3);
            if (TryFence(content[indent..], out byte marker, out int markerLength))
            {
                if (fenceMarker == 0)
                {
                    fenceMarker = marker;
                    fenceLength = markerLength;
                }
                else if (marker == fenceMarker && markerLength >= fenceLength)
                {
                    fenceMarker = 0;
                    fenceLength = 0;
                }
                continue;
            }
            if (fenceMarker != 0)
            {
                continue;
            }

            int level = AtxLevel(content, indent);
            RevisionByteRange range;
            if (level > 0)
            {
                range = new RevisionByteRange(line.Offset, line.FullLength);
            }
            else if (index + 1 < lines.Length && content.Length > 0)
            {
                SourceLine underline = lines[index + 1];
                int setextLevel = SetextLevel(source.Slice(underline.Offset, underline.ContentLength));
                if (setextLevel == 0)
                {
                    continue;
                }
                level = setextLevel;
                range = new RevisionByteRange(line.Offset, underline.Offset + underline.FullLength - line.Offset);
            }
            else
            {
                continue;
            }

            headings.Add(new RevisionDiffHeading(
                level,
                index,
                range,
                RevisionCompareCanonical.Sha256(source.Slice(range.Offset, range.Length))));
        }
        return headings.ToImmutable();
    }

    private static int AtxLevel(ReadOnlySpan<byte> line, int indent)
    {
        int index = indent;
        while (index < line.Length && line[index] == (byte)'#' && index - indent < 6)
        {
            index++;
        }
        int level = index - indent;
        return level > 0 && (index == line.Length || line[index] is (byte)' ' or (byte)'\t') ? level : 0;
    }

    private static int SetextLevel(ReadOnlySpan<byte> line)
    {
        int start = LeadingSpaces(line, 3);
        if (start >= line.Length || line[start] is not ((byte)'=' or (byte)'-'))
        {
            return 0;
        }
        byte marker = line[start];
        int count = 0;
        for (int index = start; index < line.Length; index++)
        {
            if (line[index] == marker)
            {
                count++;
            }
            else if (line[index] is not ((byte)' ' or (byte)'\t'))
            {
                return 0;
            }
        }
        return count == 0 ? 0 : marker == (byte)'=' ? 1 : 2;
    }

    private static bool TryFence(ReadOnlySpan<byte> line, out byte marker, out int length)
    {
        marker = line.IsEmpty ? (byte)0 : line[0];
        if (marker is not ((byte)'`' or (byte)'~'))
        {
            length = 0;
            return false;
        }
        length = 0;
        while (length < line.Length && line[length] == marker)
        {
            length++;
        }
        return length >= 3;
    }

    private static int LeadingSpaces(ReadOnlySpan<byte> line, int limit)
    {
        int count = 0;
        while (count < line.Length && count < limit && line[count] == (byte)' ')
        {
            count++;
        }
        return count;
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

    private static string DigestChunk(int index, ImmutableArray<RevisionDiffHunk> hunks)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        RevisionCompareCanonical.Append(hash, index);
        foreach (RevisionDiffHunk hunk in hunks)
        {
            RevisionCompareCanonical.Append(hash, (int)hunk.Kind);
            RevisionCompareCanonical.Append(hash, hunk.BaseStartLine);
            RevisionCompareCanonical.Append(hash, hunk.BaseLineCount);
            RevisionCompareCanonical.Append(hash, hunk.CompareStartLine);
            RevisionCompareCanonical.Append(hash, hunk.CompareLineCount);
            RevisionCompareCanonical.Append(hash, hunk.Base.Offset);
            RevisionCompareCanonical.Append(hash, hunk.Base.Length);
            RevisionCompareCanonical.Append(hash, hunk.Compare.Offset);
            RevisionCompareCanonical.Append(hash, hunk.Compare.Length);
            foreach (RevisionDiffWordEdit word in hunk.WordEdits)
            {
                RevisionCompareCanonical.Append(hash, (int)word.Kind);
                RevisionCompareCanonical.Append(hash, word.Base.Offset);
                RevisionCompareCanonical.Append(hash, word.Base.Length);
                RevisionCompareCanonical.Append(hash, word.Compare.Offset);
                RevisionCompareCanonical.Append(hash, word.Compare.Length);
            }
            foreach (string heading in hunk.HeadingIdentities)
            {
                RevisionCompareCanonical.Append(hash, heading);
            }
        }
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    private static RevisionSourceDiffReceipt Receipt(
        RevisionComparePlanBundle bundle,
        RevisionComparePlanStatus status,
        string reasonCode,
        int tokenCount,
        int hunkCount,
        int chunkCount,
        IEnumerable<string> chunkDigests)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        RevisionCompareCanonical.Append(hash, RevisionCompareContract.SchemaVersion);
        RevisionCompareCanonical.Append(hash, RevisionCompareContract.DiffEngineVersion);
        RevisionCompareCanonical.Append(hash, bundle.Plan.ContentDigest);
        RevisionCompareCanonical.Append(hash, bundle.BasePackage.SourceDigest);
        RevisionCompareCanonical.Append(hash, bundle.ComparePackage.SourceDigest);
        RevisionCompareCanonical.Append(hash, (int)status);
        RevisionCompareCanonical.Append(hash, reasonCode);
        RevisionCompareCanonical.Append(hash, tokenCount);
        RevisionCompareCanonical.Append(hash, hunkCount);
        RevisionCompareCanonical.Append(hash, chunkCount);
        foreach (string digest in chunkDigests)
        {
            RevisionCompareCanonical.Append(hash, digest);
        }
        return new RevisionSourceDiffReceipt(
            RevisionCompareContract.SchemaVersion,
            RevisionCompareContract.DiffEngineVersion,
            status,
            reasonCode,
            bundle.Plan.ContentDigest,
            bundle.BasePackage.SourceDigest,
            bundle.ComparePackage.SourceDigest,
            tokenCount,
            hunkCount,
            chunkCount,
            Convert.ToHexStringLower(hash.GetHashAndReset()));
    }

    private static RevisionSourceDiffResult Failure(
        RevisionComparePlanBundle bundle,
        RevisionComparePlanStatus status,
        string reasonCode)
    {
        RevisionSourceDiffReceipt receipt = Receipt(bundle, status, reasonCode, 0, 0, 0, []);
        return new RevisionSourceDiffResult(status, [], [], [], [], [], receipt);
    }

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

    private sealed record TextToken(string Value, int Offset, int Length, TextTokenClass Class);

    private enum TextTokenClass
    {
        Word = 0,
        Whitespace = 1,
        Symbol = 2
    }

    private sealed record WordDiffResult(
        ImmutableArray<RevisionDiffWordEdit> Edits,
        int TokenCount,
        bool BudgetExceeded);
}

public static class RevisionSourceDiffVerifier
{
    public static bool Verify(RevisionComparePlanBundle bundle, RevisionSourceDiffResult result)
    {
        ArgumentNullException.ThrowIfNull(bundle);
        ArgumentNullException.ThrowIfNull(result);
        if (!result.IsSuccess
            || result.Receipt.Status != result.Status
            || !string.Equals(result.Receipt.ReasonCode, "accepted", StringComparison.Ordinal)
            || result.Receipt.SchemaVersion != RevisionCompareContract.SchemaVersion
            || !string.Equals(result.Receipt.EngineVersion, RevisionCompareContract.DiffEngineVersion, StringComparison.Ordinal)
            || !string.Equals(result.Receipt.PlanDigest, bundle.Plan.ContentDigest, StringComparison.Ordinal)
            || !string.Equals(result.Receipt.BaseSourceDigest, bundle.BasePackage.SourceDigest, StringComparison.Ordinal)
            || !string.Equals(result.Receipt.CompareSourceDigest, bundle.ComparePackage.SourceDigest, StringComparison.Ordinal)
            || result.Receipt.ChunkCount != result.Chunks.Length)
        {
            return false;
        }
        if (!ValidLines(result.BaseLines, bundle.BasePackage.RawMarkdown)
            || !ValidLines(result.CompareLines, bundle.ComparePackage.RawMarkdown))
        {
            return false;
        }
        if (!ValidHeadings(result.BaseHeadings, bundle.BasePackage.RawMarkdown, result.BaseLines.Length)
            || !ValidHeadings(result.CompareHeadings, bundle.ComparePackage.RawMarkdown, result.CompareLines.Length))
        {
            return false;
        }

        int baseCursor = 0;
        int compareCursor = 0;
        int hunkCount = 0;
        for (int chunkIndex = 0; chunkIndex < result.Chunks.Length; chunkIndex++)
        {
            RevisionDiffChunk chunk = result.Chunks[chunkIndex];
            if (chunk.Index != chunkIndex || !string.Equals(chunk.ContentDigest, DigestChunk(chunk.Index, chunk.Hunks), StringComparison.Ordinal))
            {
                return false;
            }
            foreach (RevisionDiffHunk hunk in chunk.Hunks)
            {
                if (hunk.Base.Offset != baseCursor
                    || hunk.Compare.Offset != compareCursor
                    || hunk.Base.End > bundle.BasePackage.RawMarkdown.Length
                    || hunk.Compare.End > bundle.ComparePackage.RawMarkdown.Length
                    || hunk.Base.Offset < 0
                    || hunk.Compare.Offset < 0)
                {
                    return false;
                }
                foreach (RevisionDiffWordEdit word in hunk.WordEdits)
                {
                    if (word.Base.Offset < hunk.Base.Offset
                        || word.Base.End > hunk.Base.End
                        || word.Compare.Offset < hunk.Compare.Offset
                        || word.Compare.End > hunk.Compare.End
                        || word.Base.Length < 0
                        || word.Compare.Length < 0)
                    {
                        return false;
                    }
                }
                baseCursor = hunk.Base.End;
                compareCursor = hunk.Compare.End;
                hunkCount++;
            }
        }
        if (baseCursor != bundle.BasePackage.RawMarkdown.Length
            || compareCursor != bundle.ComparePackage.RawMarkdown.Length
            || hunkCount != result.Receipt.HunkCount)
        {
            return false;
        }
        RevisionSourceDiffReceipt expected = Receipt(
            bundle,
            result.Status,
            result.Receipt.ReasonCode,
            result.Receipt.TokenCount,
            result.Receipt.HunkCount,
            result.Receipt.ChunkCount,
            result.Chunks.Select(static chunk => chunk.ContentDigest));
        return string.Equals(expected.ContentDigest, result.Receipt.ContentDigest, StringComparison.Ordinal);
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
                || line.Content.Offset != cursor
                || line.Content.Length < 0
                || line.Terminator.Offset != line.Content.End
                || line.Terminator.Length != expectedTerminatorLength)
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
            cursor = line.Terminator.End;
        }
        return cursor == source.Length;
    }

    private static bool ValidHeadings(
        ImmutableArray<RevisionDiffHeading> headings,
        ImmutableArray<byte> source,
        int lineCount)
    {
        int previousLine = -1;
        foreach (RevisionDiffHeading heading in headings)
        {
            if (heading.Level is < 1 or > 6
                || heading.LineIndex <= previousLine
                || heading.LineIndex >= lineCount
                || heading.Source.Offset < 0
                || heading.Source.Length <= 0
                || heading.Source.End > source.Length
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

    private static string DigestChunk(int index, ImmutableArray<RevisionDiffHunk> hunks)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        RevisionCompareCanonical.Append(hash, index);
        foreach (RevisionDiffHunk hunk in hunks)
        {
            RevisionCompareCanonical.Append(hash, (int)hunk.Kind);
            RevisionCompareCanonical.Append(hash, hunk.BaseStartLine);
            RevisionCompareCanonical.Append(hash, hunk.BaseLineCount);
            RevisionCompareCanonical.Append(hash, hunk.CompareStartLine);
            RevisionCompareCanonical.Append(hash, hunk.CompareLineCount);
            RevisionCompareCanonical.Append(hash, hunk.Base.Offset);
            RevisionCompareCanonical.Append(hash, hunk.Base.Length);
            RevisionCompareCanonical.Append(hash, hunk.Compare.Offset);
            RevisionCompareCanonical.Append(hash, hunk.Compare.Length);
            foreach (RevisionDiffWordEdit word in hunk.WordEdits)
            {
                RevisionCompareCanonical.Append(hash, (int)word.Kind);
                RevisionCompareCanonical.Append(hash, word.Base.Offset);
                RevisionCompareCanonical.Append(hash, word.Base.Length);
                RevisionCompareCanonical.Append(hash, word.Compare.Offset);
                RevisionCompareCanonical.Append(hash, word.Compare.Length);
            }
            foreach (string heading in hunk.HeadingIdentities)
            {
                RevisionCompareCanonical.Append(hash, heading);
            }
        }
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    private static RevisionSourceDiffReceipt Receipt(
        RevisionComparePlanBundle bundle,
        RevisionComparePlanStatus status,
        string reasonCode,
        int tokenCount,
        int hunkCount,
        int chunkCount,
        IEnumerable<string> chunkDigests)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        RevisionCompareCanonical.Append(hash, RevisionCompareContract.SchemaVersion);
        RevisionCompareCanonical.Append(hash, RevisionCompareContract.DiffEngineVersion);
        RevisionCompareCanonical.Append(hash, bundle.Plan.ContentDigest);
        RevisionCompareCanonical.Append(hash, bundle.BasePackage.SourceDigest);
        RevisionCompareCanonical.Append(hash, bundle.ComparePackage.SourceDigest);
        RevisionCompareCanonical.Append(hash, (int)status);
        RevisionCompareCanonical.Append(hash, reasonCode);
        RevisionCompareCanonical.Append(hash, tokenCount);
        RevisionCompareCanonical.Append(hash, hunkCount);
        RevisionCompareCanonical.Append(hash, chunkCount);
        foreach (string digest in chunkDigests)
        {
            RevisionCompareCanonical.Append(hash, digest);
        }
        return ResultReceipt(hash, bundle, status, reasonCode, tokenCount, hunkCount, chunkCount);
    }

    private static RevisionSourceDiffReceipt ResultReceipt(
        IncrementalHash hash,
        RevisionComparePlanBundle bundle,
        RevisionComparePlanStatus status,
        string reasonCode,
        int tokenCount,
        int hunkCount,
        int chunkCount)
        => new(
            RevisionCompareContract.SchemaVersion,
            RevisionCompareContract.DiffEngineVersion,
            status,
            reasonCode,
            bundle.Plan.ContentDigest,
            bundle.BasePackage.SourceDigest,
            bundle.ComparePackage.SourceDigest,
            tokenCount,
            hunkCount,
            chunkCount,
            Convert.ToHexStringLower(hash.GetHashAndReset()));
}
