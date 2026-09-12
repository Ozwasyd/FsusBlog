using System.Collections.Immutable;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Core.Services.Articles;

public sealed partial class RevisionSourceDiffEngine(
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

}
