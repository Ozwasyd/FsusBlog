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

public sealed record RevisionDiffContextGroup(
    int Index,
    bool Collapsed,
    int BaseStartLine,
    int BaseLineCount,
    int CompareStartLine,
    int CompareLineCount,
    RevisionByteRange Base,
    RevisionByteRange Compare,
    string ContentDigest);

public sealed record RevisionSourceDiffReceipt(
    int SchemaVersion,
    string EngineVersion,
    string SegmenterVersion,
    string StructureParserVersion,
    RevisionComparePlanStatus Status,
    string ReasonCode,
    string PlanDigest,
    string BaseSourceDigest,
    string CompareSourceDigest,
    string BaseStructureDigest,
    string CompareStructureDigest,
    string BudgetDigest,
    string AdmissionDigest,
    int BaseSourceByteCount,
    int CompareSourceByteCount,
    int BaseLineCount,
    int CompareLineCount,
    int TokenCount,
    int WordEditCount,
    int HeadingCount,
    int ContextGroupCount,
    int HunkCount,
    int ChunkCount,
    long EstimatedMemoryBytes,
    long EstimatedOutputBytes,
    string ContentDigest);

public sealed record RevisionSourceDiffAttemptReceipt(
    string SemanticContentDigest,
    RevisionComparePlanStatus Status,
    long ElapsedMilliseconds,
    string ContentDigest);

public sealed record RevisionSourceDiffResult(
    RevisionComparePlanStatus Status,
    ImmutableArray<RevisionDiffChunk> Chunks,
    ImmutableArray<RevisionDiffLine> BaseLines,
    ImmutableArray<RevisionDiffLine> CompareLines,
    ImmutableArray<RevisionDiffHeading> BaseHeadings,
    ImmutableArray<RevisionDiffHeading> CompareHeadings,
    ImmutableArray<RevisionDiffContextGroup> ContextGroups,
    RevisionSourceDiffReceipt Receipt,
    RevisionSourceDiffAttemptReceipt AttemptReceipt)
{
    public bool IsSuccess => Status == RevisionComparePlanStatus.Accepted;
}

public sealed class RevisionSourceDiffEngine(
    RevisionComparePlanVerifier planVerifier,
    IRevisionMarkdownStructureAuthority structureAuthority)
{
    public const string SegmenterVersion = "unicode-text-elements-v1";

    public async Task<RevisionSourceDiffResult> ComputeAsync(
        RevisionComparePlanBundle bundle,
        DateTimeOffset observedAtUtc,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(bundle);
        var stopwatch = System.Diagnostics.Stopwatch.StartNew();
        RevisionComparePlanVerification verification = await planVerifier.VerifyAsync(
                bundle,
                observedAtUtc,
                cancellationToken)
            .ConfigureAwait(false);
        if (!verification.Valid)
        {
            return WithElapsed(
                Failure(bundle, verification.Status, verification.ReasonCode),
                stopwatch.ElapsedMilliseconds);
        }

        using var timeout = new CancellationTokenSource(bundle.Plan.Budgets.TimeoutMilliseconds);
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, timeout.Token);
        try
        {
            RevisionMarkdownStructureSnapshot? baseStructure = null;
            RevisionMarkdownStructureSnapshot? compareStructure = null;
            if (bundle.Plan.Options.HeadingNavigation)
            {
                RevisionMarkdownStructureReadResult baseRead = await ReadStructureAsync(
                        bundle.BasePackage,
                        linked.Token)
                    .ConfigureAwait(false);
                RevisionSourceDiffResult? baseFailure = StructureFailure(bundle, baseRead);
                if (baseFailure is not null)
                {
                    return WithElapsed(baseFailure, stopwatch.ElapsedMilliseconds);
                }
                if (DateTimeOffset.UtcNow > bundle.Plan.ExpiresAtUtc)
                {
                    return WithElapsed(
                        Failure(bundle, RevisionComparePlanStatus.Stale, "revision_compare_plan_expired"),
                        stopwatch.ElapsedMilliseconds);
                }
                RevisionMarkdownStructureReadResult compareRead = await ReadStructureAsync(
                        bundle.ComparePackage,
                        linked.Token)
                    .ConfigureAwait(false);
                RevisionSourceDiffResult? compareFailure = StructureFailure(bundle, compareRead);
                if (compareFailure is not null)
                {
                    return WithElapsed(compareFailure, stopwatch.ElapsedMilliseconds);
                }
                if (DateTimeOffset.UtcNow > bundle.Plan.ExpiresAtUtc)
                {
                    return WithElapsed(
                        Failure(bundle, RevisionComparePlanStatus.Stale, "revision_compare_plan_expired"),
                        stopwatch.ElapsedMilliseconds);
                }
                baseStructure = baseRead.Snapshot!;
                compareStructure = compareRead.Snapshot!;
                if (!string.Equals(
                    baseStructure.ParserVersion,
                    compareStructure.ParserVersion,
                    StringComparison.Ordinal))
                {
                    return WithElapsed(
                        Failure(bundle, RevisionComparePlanStatus.Invalid, "revision_diff_structure_version_mismatch"),
                        stopwatch.ElapsedMilliseconds);
                }
            }

            RevisionSourceDiffResult result = await Task.Run(
                    () => ComputeVerified(bundle, baseStructure, compareStructure, linked.Token),
                    linked.Token)
                .ConfigureAwait(false);
            linked.Token.ThrowIfCancellationRequested();
            if (DateTimeOffset.UtcNow > bundle.Plan.ExpiresAtUtc)
            {
                return WithElapsed(
                    Failure(bundle, RevisionComparePlanStatus.Stale, "revision_compare_plan_expired"),
                    stopwatch.ElapsedMilliseconds);
            }
            RevisionComparePlanVerification completionVerification = await planVerifier.VerifyAsync(
                    bundle,
                    DateTimeOffset.UtcNow,
                    linked.Token)
                .ConfigureAwait(false);
            if (!completionVerification.Valid)
            {
                return WithElapsed(
                    Failure(bundle, completionVerification.Status, completionVerification.ReasonCode),
                    stopwatch.ElapsedMilliseconds);
            }
            linked.Token.ThrowIfCancellationRequested();
            return WithElapsed(result, stopwatch.ElapsedMilliseconds);
        }
        catch (OperationCanceledException)
        {
            string reason = timeout.IsCancellationRequested && !cancellationToken.IsCancellationRequested
                ? "revision_diff_timeout"
                : "revision_diff_cancelled";
            return WithElapsed(
                Failure(bundle, RevisionComparePlanStatus.Cancelled, reason),
                stopwatch.ElapsedMilliseconds);
        }
    }

    private async Task<RevisionMarkdownStructureReadResult> ReadStructureAsync(
        RevisionComparePackage package,
        CancellationToken cancellationToken)
    {
        var request = new RevisionMarkdownStructureRequest(package.SourceDigest, package.RawMarkdown);
        RevisionMarkdownStructureReadResult result = await structureAuthority
            .ReadAsync(request, cancellationToken)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        return result;
    }

    private static RevisionSourceDiffResult? StructureFailure(
        RevisionComparePlanBundle bundle,
        RevisionMarkdownStructureReadResult result)
        => result.Status switch
        {
            RevisionMarkdownStructureReadStatus.Available when result.Snapshot is not null => null,
            RevisionMarkdownStructureReadStatus.Unavailable => Failure(
                bundle,
                RevisionComparePlanStatus.Unavailable,
                "revision_diff_structure_unavailable"),
            _ => Failure(bundle, RevisionComparePlanStatus.Invalid, "revision_diff_structure_invalid")
        };

    private static RevisionSourceDiffResult ComputeVerified(
        RevisionComparePlanBundle bundle,
        RevisionMarkdownStructureSnapshot? baseStructure,
        RevisionMarkdownStructureSnapshot? compareStructure,
        CancellationToken cancellationToken)
    {
        RevisionCompareBudgets budgets = bundle.Plan.Budgets;
        ImmutableArray<SourceLine> baseLines = SplitLines(bundle.BasePackage.RawMarkdown.AsSpan(), cancellationToken);
        ImmutableArray<SourceLine> compareLines = SplitLines(bundle.ComparePackage.RawMarkdown.AsSpan(), cancellationToken);
        if (!ValidStructureCoordinates(baseStructure, baseLines, bundle.BasePackage.RawMarkdown.Length)
            || !ValidStructureCoordinates(compareStructure, compareLines, bundle.ComparePackage.RawMarkdown.Length))
        {
            return Failure(bundle, RevisionComparePlanStatus.Invalid, "revision_diff_structure_invalid");
        }
        long estimatedMemory = ((long)bundle.BasePackage.RawMarkdown.Length + bundle.ComparePackage.RawMarkdown.Length) * 3L
            + ((long)baseLines.Length + compareLines.Length) * 128L
            + ((long)(baseStructure?.Headings.Length ?? 0) + (compareStructure?.Headings.Length ?? 0)) * 96L;
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
        if (edits.Count > bundle.Plan.Admission.HunkLimit)
        {
            return Failure(bundle, RevisionComparePlanStatus.BudgetExceeded, "revision_diff_chunk_budget_exceeded");
        }
        ImmutableArray<RevisionDiffHeading> baseHeadings = ProjectHeadings(baseStructure);
        ImmutableArray<RevisionDiffHeading> compareHeadings = ProjectHeadings(compareStructure);

        var hunks = ImmutableArray.CreateBuilder<RevisionDiffHunk>(edits.Count);
        int tokenCount = 0;
        long estimatedOutput = ((long)baseLines.Length + compareLines.Length) * 48L
            + (baseHeadings.Length + compareHeadings.Length) * 96L;
        if (estimatedOutput > budgets.MaxOutputBytes)
        {
            return Failure(bundle, RevisionComparePlanStatus.BudgetExceeded, "revision_diff_output_budget_exceeded");
        }
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
            estimatedMemory += 192L + words.Length * 80L + headingIds.Length * 72L;
            if (estimatedMemory > budgets.MaxMemoryBytes)
            {
                return Failure(bundle, RevisionComparePlanStatus.BudgetExceeded, "revision_diff_memory_budget_exceeded");
            }
            estimatedOutput += 192L + words.Length * 80L + headingIds.Length * 72L;
            if (estimatedOutput > budgets.MaxOutputBytes)
            {
                return Failure(bundle, RevisionComparePlanStatus.BudgetExceeded, "revision_diff_output_budget_exceeded");
            }
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

        ImmutableArray<RevisionDiffContextGroup> contextGroups = CreateContextGroups(
            hunks,
            baseLines,
            compareLines,
            bundle.BasePackage.RawMarkdown.Length,
            bundle.ComparePackage.RawMarkdown.Length,
            bundle.Plan.Options.ContextLineCount,
            cancellationToken);
        estimatedMemory += contextGroups.Length * 128L;
        if (estimatedMemory > budgets.MaxMemoryBytes)
        {
            return Failure(bundle, RevisionComparePlanStatus.BudgetExceeded, "revision_diff_memory_budget_exceeded");
        }
        estimatedOutput += contextGroups.Length * 128L;
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
            chunks.Add(new RevisionDiffChunk(index, items, CreateChunkDigest(index, items)));
        }

        ImmutableArray<RevisionDiffChunk> materializedChunks = chunks.MoveToImmutable();
        ImmutableArray<RevisionDiffLine> projectedBaseLines = ProjectLines(baseLines);
        ImmutableArray<RevisionDiffLine> projectedCompareLines = ProjectLines(compareLines);
        RevisionSourceDiffReceipt receipt = CreateReceipt(
            bundle,
            RevisionComparePlanStatus.Accepted,
            "accepted",
            baseStructure?.ParserVersion ?? "not-requested",
            baseStructure?.ContentDigest ?? string.Empty,
            compareStructure?.ContentDigest ?? string.Empty,
            projectedBaseLines,
            projectedCompareLines,
            baseHeadings,
            compareHeadings,
            contextGroups,
            estimatedMemory,
            estimatedOutput,
            tokenCount,
            materializedChunks);
        return new RevisionSourceDiffResult(
            RevisionComparePlanStatus.Accepted,
            materializedChunks,
            projectedBaseLines,
            projectedCompareLines,
            baseHeadings,
            compareHeadings,
            contextGroups,
            receipt,
            CreateAttemptReceipt(receipt, 0));
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
        TokenizationStatus baseStatus = TryTokenize(
            baseBytes,
            baseOffset,
            remainingTokenBudget,
            cancellationToken,
            out List<TextToken>? baseTokens);
        if (baseStatus == TokenizationStatus.BudgetExceeded)
        {
            return new WordDiffResult([], baseTokens.Count, true);
        }
        if (baseStatus == TokenizationStatus.InvalidUtf8)
        {
            return new WordDiffResult([], 0, false);
        }
        TokenizationStatus compareStatus = TryTokenize(
            compareBytes,
            compareOffset,
            remainingTokenBudget - baseTokens.Count,
            cancellationToken,
            out List<TextToken>? compareTokens);
        if (compareStatus == TokenizationStatus.BudgetExceeded)
        {
            return new WordDiffResult([], baseTokens.Count + compareTokens.Count, true);
        }
        if (compareStatus == TokenizationStatus.InvalidUtf8)
        {
            return new WordDiffResult([], 0, false);
        }
        int tokenCount = baseTokens.Count + compareTokens.Count;

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
        int baseEnd = baseTokens.Count - suffix;
        int compareEnd = compareTokens.Count - suffix;
        List<(int Base, int Compare)> anchors = UniqueTokenAnchors(
            baseTokens,
            prefix,
            baseEnd,
            compareTokens,
            prefix,
            compareEnd,
            cancellationToken);
        var edits = ImmutableArray.CreateBuilder<RevisionDiffWordEdit>();
        int baseCursor = prefix;
        int compareCursor = prefix;
        foreach ((int baseAnchor, int compareAnchor) in anchors)
        {
            AddWordChange(
                edits,
                baseTokens,
                baseCursor,
                baseAnchor - baseCursor,
                baseOffset + baseBytes.Length,
                compareTokens,
                compareCursor,
                compareAnchor - compareCursor,
                compareOffset + compareBytes.Length);
            baseCursor = baseAnchor + 1;
            compareCursor = compareAnchor + 1;
        }
        AddWordChange(
            edits,
            baseTokens,
            baseCursor,
            baseEnd - baseCursor,
            baseOffset + baseBytes.Length,
            compareTokens,
            compareCursor,
            compareEnd - compareCursor,
            compareOffset + compareBytes.Length);
        return new WordDiffResult(edits.ToImmutable(), tokenCount, false);
    }

    private static List<(int Base, int Compare)> UniqueTokenAnchors(
        List<TextToken> baseTokens,
        int baseStart,
        int baseEnd,
        List<TextToken> compareTokens,
        int compareStart,
        int compareEnd,
        CancellationToken cancellationToken)
    {
        var baseOccurrences = new Dictionary<string, LineOccurrence>(StringComparer.Ordinal);
        var compareOccurrences = new Dictionary<string, LineOccurrence>(StringComparer.Ordinal);
        CountTokens(baseTokens, baseStart, baseEnd, baseOccurrences, cancellationToken);
        CountTokens(compareTokens, compareStart, compareEnd, compareOccurrences, cancellationToken);
        var candidates = new List<(int Base, int Compare)>();
        foreach ((string value, LineOccurrence left) in baseOccurrences)
        {
            if (left.Count == 1
                && compareOccurrences.TryGetValue(value, out LineOccurrence right)
                && right.Count == 1)
            {
                candidates.Add((left.Index, right.Index));
            }
        }
        candidates.Sort(static (left, right) => left.Base.CompareTo(right.Base));
        return LongestIncreasingSubsequence(candidates);
    }

    private static void CountTokens(
        List<TextToken> tokens,
        int start,
        int end,
        Dictionary<string, LineOccurrence> occurrences,
        CancellationToken cancellationToken)
    {
        for (int index = start; index < end; index++)
        {
            if ((index & 1023) == 0)
            {
                cancellationToken.ThrowIfCancellationRequested();
            }
            string value = tokens[index].Value;
            occurrences[value] = occurrences.TryGetValue(value, out LineOccurrence existing)
                ? existing with
                {
                    Count = existing.Count + 1
                }
                : new LineOccurrence(index, 1);
        }
    }

    private static void AddWordChange(
        ImmutableArray<RevisionDiffWordEdit>.Builder edits,
        List<TextToken> baseTokens,
        int baseStart,
        int baseCount,
        int baseEnd,
        List<TextToken> compareTokens,
        int compareStart,
        int compareCount,
        int compareEnd)
    {
        while (baseCount > 0
            && compareCount > 0
            && string.Equals(
                baseTokens[baseStart].Value,
                compareTokens[compareStart].Value,
                StringComparison.Ordinal))
        {
            baseStart++;
            baseCount--;
            compareStart++;
            compareCount--;
        }
        while (baseCount > 0
            && compareCount > 0
            && string.Equals(
                baseTokens[baseStart + baseCount - 1].Value,
                compareTokens[compareStart + compareCount - 1].Value,
                StringComparison.Ordinal))
        {
            baseCount--;
            compareCount--;
        }
        if (baseCount == 0 && compareCount == 0)
        {
            return;
        }
        RevisionDiffKind kind = baseCount == 0
            ? RevisionDiffKind.Insert
            : compareCount == 0
                ? RevisionDiffKind.Delete
                : RevisionDiffKind.Replace;
        edits.Add(new RevisionDiffWordEdit(
            kind,
            TokenRange(baseTokens, baseStart, baseCount, baseEnd),
            TokenRange(compareTokens, compareStart, compareCount, compareEnd)));
    }

    private static TokenizationStatus TryTokenize(
        ReadOnlySpan<byte> bytes,
        int absoluteOffset,
        int maxTokenCount,
        CancellationToken cancellationToken,
        out List<TextToken> tokens)
    {
        tokens = [];
        string text;
        try
        {
            text = new UTF8Encoding(false, true).GetString(bytes);
        }
        catch (DecoderFallbackException)
        {
            return TokenizationStatus.InvalidUtf8;
        }
        TextElementEnumerator enumerator = StringInfo.GetTextElementEnumerator(text);
        int byteOffset = absoluteOffset;
        int tokenCharStart = 0;
        int tokenByteOffset = absoluteOffset;
        int tokenByteLength = 0;
        TextTokenClass tokenClass = default;
        bool hasToken = false;
        int elementCount = 0;
        while (enumerator.MoveNext())
        {
            if ((elementCount++ & 1023) == 0)
            {
                cancellationToken.ThrowIfCancellationRequested();
            }
            string value = enumerator.GetTextElement();
            int byteLength = Encoding.UTF8.GetByteCount(value);
            TextTokenClass currentClass = Classify(value);
            bool coalesces = hasToken
                && (currentClass is TextTokenClass.Word or TextTokenClass.Whitespace)
                && tokenClass == currentClass;
            if (!coalesces)
            {
                if (hasToken)
                {
                    if (tokens.Count >= maxTokenCount)
                    {
                        return TokenizationStatus.BudgetExceeded;
                    }
                    tokens.Add(new TextToken(
                        text[tokenCharStart..enumerator.ElementIndex],
                        tokenByteOffset,
                        tokenByteLength,
                        tokenClass));
                }
                tokenCharStart = enumerator.ElementIndex;
                tokenByteOffset = byteOffset;
                tokenByteLength = 0;
                tokenClass = currentClass;
                hasToken = true;
            }
            tokenByteLength += byteLength;
            byteOffset += byteLength;
        }
        cancellationToken.ThrowIfCancellationRequested();
        if (hasToken)
        {
            if (tokens.Count >= maxTokenCount)
            {
                return TokenizationStatus.BudgetExceeded;
            }
            tokens.Add(new TextToken(text[tokenCharStart..], tokenByteOffset, tokenByteLength, tokenClass));
        }
        return TokenizationStatus.Available;
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

    internal static string CreateChunkDigest(int index, ImmutableArray<RevisionDiffHunk> hunks)
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

    internal static string CreateContextGroupDigest(
        int index,
        bool collapsed,
        int baseStart,
        int baseCount,
        int compareStart,
        int compareCount,
        RevisionByteRange baseRange,
        RevisionByteRange compareRange)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        RevisionCompareCanonical.Append(hash, index);
        RevisionCompareCanonical.Append(hash, collapsed);
        RevisionCompareCanonical.Append(hash, baseStart);
        RevisionCompareCanonical.Append(hash, baseCount);
        RevisionCompareCanonical.Append(hash, compareStart);
        RevisionCompareCanonical.Append(hash, compareCount);
        RevisionCompareCanonical.Append(hash, baseRange.Offset);
        RevisionCompareCanonical.Append(hash, baseRange.Length);
        RevisionCompareCanonical.Append(hash, compareRange.Offset);
        RevisionCompareCanonical.Append(hash, compareRange.Length);
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    internal static RevisionSourceDiffReceipt CreateReceipt(
        RevisionComparePlanBundle bundle,
        RevisionComparePlanStatus status,
        string reasonCode,
        string structureParserVersion,
        string baseStructureDigest,
        string compareStructureDigest,
        ImmutableArray<RevisionDiffLine> baseLines,
        ImmutableArray<RevisionDiffLine> compareLines,
        ImmutableArray<RevisionDiffHeading> baseHeadings,
        ImmutableArray<RevisionDiffHeading> compareHeadings,
        ImmutableArray<RevisionDiffContextGroup> contextGroups,
        long estimatedMemoryBytes,
        long estimatedOutputBytes,
        int tokenCount,
        ImmutableArray<RevisionDiffChunk> chunks)
    {
        int hunkCount = chunks.Sum(static chunk => chunk.Hunks.Length);
        int wordEditCount = chunks.Sum(static chunk => chunk.Hunks.Sum(static hunk => hunk.WordEdits.Length));
        int headingCount = baseHeadings.Length + compareHeadings.Length;
        string budgetDigest = CreateBudgetDigest(bundle.Plan.Budgets, bundle.Plan.Options);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        RevisionCompareCanonical.Append(hash, RevisionCompareContract.SchemaVersion);
        RevisionCompareCanonical.Append(hash, RevisionCompareContract.DiffEngineVersion);
        RevisionCompareCanonical.Append(hash, SegmenterVersion);
        RevisionCompareCanonical.Append(hash, structureParserVersion);
        RevisionCompareCanonical.Append(hash, bundle.Plan.ContentDigest);
        RevisionCompareCanonical.Append(hash, bundle.BasePackage.SourceDigest);
        RevisionCompareCanonical.Append(hash, bundle.ComparePackage.SourceDigest);
        RevisionCompareCanonical.Append(hash, baseStructureDigest);
        RevisionCompareCanonical.Append(hash, compareStructureDigest);
        RevisionCompareCanonical.Append(hash, budgetDigest);
        RevisionCompareCanonical.Append(hash, bundle.Plan.Admission.ContentDigest);
        RevisionCompareCanonical.Append(hash, (int)status);
        RevisionCompareCanonical.Append(hash, reasonCode);
        RevisionCompareCanonical.Append(hash, bundle.BasePackage.RawMarkdown.Length);
        RevisionCompareCanonical.Append(hash, bundle.ComparePackage.RawMarkdown.Length);
        RevisionCompareCanonical.Append(hash, baseLines.Length);
        RevisionCompareCanonical.Append(hash, compareLines.Length);
        RevisionCompareCanonical.Append(hash, tokenCount);
        RevisionCompareCanonical.Append(hash, wordEditCount);
        RevisionCompareCanonical.Append(hash, headingCount);
        RevisionCompareCanonical.Append(hash, contextGroups.Length);
        RevisionCompareCanonical.Append(hash, hunkCount);
        RevisionCompareCanonical.Append(hash, chunks.Length);
        RevisionCompareCanonical.Append(hash, estimatedMemoryBytes);
        RevisionCompareCanonical.Append(hash, estimatedOutputBytes);
        foreach (RevisionDiffLine line in baseLines.Concat(compareLines))
        {
            RevisionCompareCanonical.Append(hash, line.Index);
            RevisionCompareCanonical.Append(hash, line.Content.Offset);
            RevisionCompareCanonical.Append(hash, line.Content.Length);
            RevisionCompareCanonical.Append(hash, line.Terminator.Offset);
            RevisionCompareCanonical.Append(hash, line.Terminator.Length);
            RevisionCompareCanonical.Append(hash, (int)line.TerminatorKind);
        }
        foreach (RevisionDiffHeading heading in baseHeadings.Concat(compareHeadings))
        {
            RevisionCompareCanonical.Append(hash, heading.Level);
            RevisionCompareCanonical.Append(hash, heading.LineIndex);
            RevisionCompareCanonical.Append(hash, heading.Source.Offset);
            RevisionCompareCanonical.Append(hash, heading.Source.Length);
            RevisionCompareCanonical.Append(hash, heading.IdentityDigest);
        }
        foreach (RevisionDiffContextGroup group in contextGroups)
        {
            RevisionCompareCanonical.Append(hash, group.ContentDigest);
        }
        foreach (RevisionDiffChunk chunk in chunks)
        {
            RevisionCompareCanonical.Append(hash, chunk.ContentDigest);
        }
        return new RevisionSourceDiffReceipt(
            RevisionCompareContract.SchemaVersion,
            RevisionCompareContract.DiffEngineVersion,
            SegmenterVersion,
            structureParserVersion,
            status,
            reasonCode,
            bundle.Plan.ContentDigest,
            bundle.BasePackage.SourceDigest,
            bundle.ComparePackage.SourceDigest,
            baseStructureDigest,
            compareStructureDigest,
            budgetDigest,
            bundle.Plan.Admission.ContentDigest,
            bundle.BasePackage.RawMarkdown.Length,
            bundle.ComparePackage.RawMarkdown.Length,
            baseLines.Length,
            compareLines.Length,
            tokenCount,
            wordEditCount,
            headingCount,
            contextGroups.Length,
            hunkCount,
            chunks.Length,
            estimatedMemoryBytes,
            estimatedOutputBytes,
            Convert.ToHexStringLower(hash.GetHashAndReset()));
    }

    internal static string CreateBudgetDigest(RevisionCompareBudgets budgets, RevisionCompareOptions options)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        RevisionCompareCanonical.Append(hash, RevisionCompareCanonical.BudgetDigest(budgets));
        RevisionCompareCanonical.Append(hash, RevisionCompareCanonical.OptionsDigest(options));
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }

    private static RevisionSourceDiffResult Failure(
        RevisionComparePlanBundle bundle,
        RevisionComparePlanStatus status,
        string reasonCode)
    {
        RevisionSourceDiffReceipt receipt = CreateReceipt(
            bundle,
            status,
            reasonCode,
            "not-requested",
            string.Empty,
            string.Empty,
            [],
            [],
            [],
            [],
            [],
            0,
            0,
            0,
            []);
        return new RevisionSourceDiffResult(status, [], [], [], [], [], [], receipt, CreateAttemptReceipt(receipt, 0));
    }

    private static RevisionSourceDiffResult WithElapsed(RevisionSourceDiffResult result, long elapsedMilliseconds)
        => result with
        {
            AttemptReceipt = CreateAttemptReceipt(result.Receipt, elapsedMilliseconds)
        };

    internal static RevisionSourceDiffAttemptReceipt CreateAttemptReceipt(
        RevisionSourceDiffReceipt semanticReceipt,
        long elapsedMilliseconds)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        RevisionCompareCanonical.Append(hash, semanticReceipt.ContentDigest);
        RevisionCompareCanonical.Append(hash, (int)semanticReceipt.Status);
        RevisionCompareCanonical.Append(hash, elapsedMilliseconds);
        return new RevisionSourceDiffAttemptReceipt(
            semanticReceipt.ContentDigest,
            semanticReceipt.Status,
            elapsedMilliseconds,
            Convert.ToHexStringLower(hash.GetHashAndReset()));
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

    private enum TokenizationStatus
    {
        Available = 0,
        InvalidUtf8 = 1,
        BudgetExceeded = 2
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
        if (!RevisionComparePlanVerifier.LocalBundleValid(bundle)
            || !result.IsSuccess
            || result.Receipt.Status != result.Status
            || !string.Equals(result.Receipt.ReasonCode, "accepted", StringComparison.Ordinal)
            || result.Receipt.SchemaVersion != RevisionCompareContract.SchemaVersion
            || !string.Equals(result.Receipt.EngineVersion, RevisionCompareContract.DiffEngineVersion, StringComparison.Ordinal)
            || !string.Equals(result.Receipt.SegmenterVersion, RevisionSourceDiffEngine.SegmenterVersion, StringComparison.Ordinal)
            || !string.Equals(result.Receipt.PlanDigest, bundle.Plan.ContentDigest, StringComparison.Ordinal)
            || !string.Equals(result.Receipt.BaseSourceDigest, bundle.BasePackage.SourceDigest, StringComparison.Ordinal)
            || !string.Equals(result.Receipt.CompareSourceDigest, bundle.ComparePackage.SourceDigest, StringComparison.Ordinal)
            || !string.Equals(
                result.Receipt.BudgetDigest,
                RevisionSourceDiffEngine.CreateBudgetDigest(bundle.Plan.Budgets, bundle.Plan.Options),
                StringComparison.Ordinal)
            || !string.Equals(
                result.Receipt.AdmissionDigest,
                bundle.Plan.Admission.ContentDigest,
                StringComparison.Ordinal)
            || result.Receipt.BaseSourceByteCount != bundle.BasePackage.RawMarkdown.Length
            || result.Receipt.CompareSourceByteCount != bundle.ComparePackage.RawMarkdown.Length
            || result.Receipt.BaseLineCount != result.BaseLines.Length
            || result.Receipt.CompareLineCount != result.CompareLines.Length
            || result.Receipt.WordEditCount != result.Chunks.Sum(static chunk =>
                chunk.Hunks.Sum(static hunk => hunk.WordEdits.Length))
            || result.Receipt.HeadingCount != result.BaseHeadings.Length + result.CompareHeadings.Length
            || result.Receipt.ContextGroupCount != result.ContextGroups.Length
            || result.Receipt.HunkCount != result.Chunks.Sum(static chunk => chunk.Hunks.Length)
            || result.Receipt.ChunkCount != result.Chunks.Length
            || result.Receipt.HunkCount > bundle.Plan.Admission.HunkLimit
            || result.Receipt.ChunkCount > bundle.Plan.Budgets.MaxChunks
            || result.Chunks.Any(chunk => chunk.Hunks.IsDefaultOrEmpty
                || chunk.Hunks.Length > bundle.Plan.Budgets.MaxHunksPerChunk)
            || result.Receipt.TokenCount < 0
            || result.Receipt.TokenCount > bundle.Plan.Budgets.MaxTokenCount
            || result.AttemptReceipt.ElapsedMilliseconds < 0
            || result.AttemptReceipt.Status != result.Status
            || !string.Equals(
                result.AttemptReceipt.SemanticContentDigest,
                result.Receipt.ContentDigest,
                StringComparison.Ordinal)
            || result.AttemptReceipt != RevisionSourceDiffEngine.CreateAttemptReceipt(
                result.Receipt,
                result.AttemptReceipt.ElapsedMilliseconds))
        {
            return false;
        }
        bool structureIdentityValid = bundle.Plan.Options.HeadingNavigation
            ? !string.Equals(result.Receipt.StructureParserVersion, "not-requested", StringComparison.Ordinal)
                && !string.IsNullOrWhiteSpace(result.Receipt.BaseStructureDigest)
                && !string.IsNullOrWhiteSpace(result.Receipt.CompareStructureDigest)
            : string.Equals(result.Receipt.StructureParserVersion, "not-requested", StringComparison.Ordinal)
                && string.IsNullOrEmpty(result.Receipt.BaseStructureDigest)
                && string.IsNullOrEmpty(result.Receipt.CompareStructureDigest)
                && result.BaseHeadings.IsEmpty
                && result.CompareHeadings.IsEmpty;
        if (!structureIdentityValid)
        {
            return false;
        }
        if (!ValidLines(result.BaseLines, bundle.BasePackage.RawMarkdown)
            || !ValidLines(result.CompareLines, bundle.ComparePackage.RawMarkdown))
        {
            return false;
        }
        if (!ValidHeadings(result.BaseHeadings, bundle.BasePackage.RawMarkdown, result.BaseLines)
            || !ValidHeadings(result.CompareHeadings, bundle.ComparePackage.RawMarkdown, result.CompareLines))
        {
            return false;
        }

        int baseCursor = 0;
        int compareCursor = 0;
        int baseLineCursor = 0;
        int compareLineCursor = 0;
        int hunkCount = 0;
        HashSet<string> headingIdentities = result.BaseHeadings
            .Concat(result.CompareHeadings)
            .Select(static heading => heading.IdentityDigest)
            .ToHashSet(StringComparer.Ordinal);
        for (int chunkIndex = 0; chunkIndex < result.Chunks.Length; chunkIndex++)
        {
            RevisionDiffChunk chunk = result.Chunks[chunkIndex];
            if (chunk.Index != chunkIndex
                || !string.Equals(
                    chunk.ContentDigest,
                    RevisionSourceDiffEngine.CreateChunkDigest(chunk.Index, chunk.Hunks),
                    StringComparison.Ordinal))
            {
                return false;
            }
            foreach (RevisionDiffHunk hunk in chunk.Hunks)
            {
                RevisionByteRange expectedBase = RangeFromLines(
                    result.BaseLines,
                    hunk.BaseStartLine,
                    hunk.BaseLineCount,
                    bundle.BasePackage.RawMarkdown.Length);
                RevisionByteRange expectedCompare = RangeFromLines(
                    result.CompareLines,
                    hunk.CompareStartLine,
                    hunk.CompareLineCount,
                    bundle.ComparePackage.RawMarkdown.Length);
                if (hunk.BaseStartLine != baseLineCursor
                    || hunk.CompareStartLine != compareLineCursor
                    || hunk.Base != expectedBase
                    || hunk.Compare != expectedCompare
                    || hunk.Base.Offset != baseCursor
                    || hunk.Compare.Offset != compareCursor
                    || hunk.Base.End > bundle.BasePackage.RawMarkdown.Length
                    || hunk.Compare.End > bundle.ComparePackage.RawMarkdown.Length
                    || hunk.Base.Offset < 0
                    || hunk.Compare.Offset < 0)
                {
                    return false;
                }
                bool kindValid = hunk.Kind switch
                {
                    RevisionDiffKind.Equal => hunk.Base.Length > 0
                        && hunk.Compare.Length > 0
                        && bundle.BasePackage.RawMarkdown.AsSpan(hunk.Base.Offset, hunk.Base.Length)
                            .SequenceEqual(bundle.ComparePackage.RawMarkdown.AsSpan(hunk.Compare.Offset, hunk.Compare.Length)),
                    RevisionDiffKind.Insert => hunk.Base.Length == 0 && hunk.Compare.Length > 0,
                    RevisionDiffKind.Delete => hunk.Base.Length > 0 && hunk.Compare.Length == 0,
                    RevisionDiffKind.Replace => hunk.Base.Length > 0
                        && hunk.Compare.Length > 0
                        && !bundle.BasePackage.RawMarkdown.AsSpan(hunk.Base.Offset, hunk.Base.Length)
                            .SequenceEqual(bundle.ComparePackage.RawMarkdown.AsSpan(hunk.Compare.Offset, hunk.Compare.Length)),
                    _ => false
                };
                if (!kindValid || hunk.HeadingIdentities.Any(identity => !headingIdentities.Contains(identity)))
                {
                    return false;
                }
                if (hunk.Kind != RevisionDiffKind.Replace && !hunk.WordEdits.IsEmpty)
                {
                    return false;
                }
                int baseWordCursor = hunk.Base.Offset;
                int compareWordCursor = hunk.Compare.Offset;
                foreach (RevisionDiffWordEdit word in hunk.WordEdits)
                {
                    if (word.Base.Length < 0
                        || word.Compare.Length < 0
                        || word.Base.Offset < baseWordCursor
                        || word.Compare.Offset < compareWordCursor
                        || word.Base.Offset > hunk.Base.End
                        || word.Compare.Offset > hunk.Compare.End
                        || word.Base.Length > hunk.Base.End - word.Base.Offset
                        || word.Compare.Length > hunk.Compare.End - word.Compare.Offset)
                    {
                        return false;
                    }
                    ReadOnlySpan<byte> baseGap = bundle.BasePackage.RawMarkdown.AsSpan(
                        baseWordCursor,
                        word.Base.Offset - baseWordCursor);
                    ReadOnlySpan<byte> compareGap = bundle.ComparePackage.RawMarkdown.AsSpan(
                        compareWordCursor,
                        word.Compare.Offset - compareWordCursor);
                    bool wordKindValid = word.Kind switch
                    {
                        RevisionDiffKind.Insert => word.Base.Length == 0 && word.Compare.Length > 0,
                        RevisionDiffKind.Delete => word.Base.Length > 0 && word.Compare.Length == 0,
                        RevisionDiffKind.Replace => word.Base.Length > 0
                            && word.Compare.Length > 0
                            && !bundle.BasePackage.RawMarkdown.AsSpan(word.Base.Offset, word.Base.Length)
                                .SequenceEqual(bundle.ComparePackage.RawMarkdown.AsSpan(word.Compare.Offset, word.Compare.Length)),
                        _ => false
                    };
                    if (!baseGap.SequenceEqual(compareGap) || !wordKindValid)
                    {
                        return false;
                    }
                    baseWordCursor = word.Base.Offset + word.Base.Length;
                    compareWordCursor = word.Compare.Offset + word.Compare.Length;
                }
                if (!hunk.WordEdits.IsEmpty
                    && !bundle.BasePackage.RawMarkdown.AsSpan(baseWordCursor, hunk.Base.End - baseWordCursor)
                    .SequenceEqual(bundle.ComparePackage.RawMarkdown.AsSpan(
                        compareWordCursor,
                        hunk.Compare.End - compareWordCursor)))
                {
                    return false;
                }
                baseCursor = hunk.Base.End;
                compareCursor = hunk.Compare.End;
                baseLineCursor += hunk.BaseLineCount;
                compareLineCursor += hunk.CompareLineCount;
                hunkCount++;
            }
        }
        if (baseCursor != bundle.BasePackage.RawMarkdown.Length
            || compareCursor != bundle.ComparePackage.RawMarkdown.Length
            || baseLineCursor != result.BaseLines.Length
            || compareLineCursor != result.CompareLines.Length
            || hunkCount != result.Receipt.HunkCount)
        {
            return false;
        }
        if (!ValidContextGroups(bundle, result))
        {
            return false;
        }
        long expectedMemory = ((long)bundle.BasePackage.RawMarkdown.Length + bundle.ComparePackage.RawMarkdown.Length) * 3L
            + ((long)result.BaseLines.Length + result.CompareLines.Length) * 128L
            + (result.BaseHeadings.Length + result.CompareHeadings.Length) * 96L
            + result.Receipt.HunkCount * 192L
            + result.Chunks.Sum(static chunk => chunk.Hunks.Sum(static hunk =>
                (long)hunk.WordEdits.Length * 80L + hunk.HeadingIdentities.Length * 72L))
            + result.ContextGroups.Length * 128L;
        long expectedOutput = result.Receipt.HunkCount * 192L
            + result.Chunks.Sum(static chunk => chunk.Hunks.Sum(static hunk =>
                (long)hunk.WordEdits.Length * 80L + hunk.HeadingIdentities.Length * 72L))
            + (result.BaseHeadings.Length + result.CompareHeadings.Length) * 96L
            + result.ContextGroups.Length * 128L
            + ((long)result.BaseLines.Length + result.CompareLines.Length) * 48L;
        if (result.Receipt.EstimatedMemoryBytes != expectedMemory
            || result.Receipt.EstimatedOutputBytes != expectedOutput
            || expectedMemory > bundle.Plan.Budgets.MaxMemoryBytes
            || expectedOutput > bundle.Plan.Budgets.MaxOutputBytes)
        {
            return false;
        }
        RevisionSourceDiffReceipt expected = RevisionSourceDiffEngine.CreateReceipt(
            bundle,
            result.Status,
            result.Receipt.ReasonCode,
            result.Receipt.StructureParserVersion,
            result.Receipt.BaseStructureDigest,
            result.Receipt.CompareStructureDigest,
            result.BaseLines,
            result.CompareLines,
            result.BaseHeadings,
            result.CompareHeadings,
            result.ContextGroups,
            result.Receipt.EstimatedMemoryBytes,
            result.Receipt.EstimatedOutputBytes,
            result.Receipt.TokenCount,
            result.Chunks);
        return expected == result.Receipt;
    }

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

public sealed class RevisionSourceDiffResultVerifier(
    IRevisionMarkdownStructureAuthority structureAuthority)
{
    public async Task<bool> VerifyAsync(
        RevisionComparePlanBundle bundle,
        RevisionSourceDiffResult result,
        CancellationToken cancellationToken = default)
    {
        if (!RevisionSourceDiffVerifier.Verify(bundle, result))
        {
            return false;
        }
        if (!bundle.Plan.Options.HeadingNavigation)
        {
            return true;
        }

        RevisionMarkdownStructureReadResult baseRead = await structureAuthority.ReadAsync(
                new RevisionMarkdownStructureRequest(
                    bundle.BasePackage.SourceDigest,
                    bundle.BasePackage.RawMarkdown),
                cancellationToken)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        RevisionMarkdownStructureReadResult compareRead = await structureAuthority.ReadAsync(
                new RevisionMarkdownStructureRequest(
                    bundle.ComparePackage.SourceDigest,
                    bundle.ComparePackage.RawMarkdown),
                cancellationToken)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (baseRead.Status != RevisionMarkdownStructureReadStatus.Available
            || compareRead.Status != RevisionMarkdownStructureReadStatus.Available
            || baseRead.Snapshot is null
            || compareRead.Snapshot is null
            || !string.Equals(
                baseRead.Snapshot.ParserVersion,
                result.Receipt.StructureParserVersion,
                StringComparison.Ordinal)
            || !string.Equals(
                compareRead.Snapshot.ParserVersion,
                result.Receipt.StructureParserVersion,
                StringComparison.Ordinal)
            || !string.Equals(
                baseRead.Snapshot.ContentDigest,
                result.Receipt.BaseStructureDigest,
                StringComparison.Ordinal)
            || !string.Equals(
                compareRead.Snapshot.ContentDigest,
                result.Receipt.CompareStructureDigest,
                StringComparison.Ordinal))
        {
            return false;
        }

        return Project(baseRead.Snapshot.Headings).SequenceEqual(result.BaseHeadings)
            && Project(compareRead.Snapshot.Headings).SequenceEqual(result.CompareHeadings);
    }

    private static IEnumerable<RevisionDiffHeading> Project(
        ImmutableArray<RevisionMarkdownHeadingNode> headings)
        => headings.Select(static heading => new RevisionDiffHeading(
            heading.Level,
            heading.LineIndex,
            heading.Source,
            heading.IdentityDigest));
}
