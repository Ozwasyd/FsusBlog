using System.Collections.Immutable;
using System.Text;

using FsusBlog.Core.Services.Articles;

namespace FsusBlog.Server.Tests.Unit;

public sealed partial class RevisionSourceDiffTests
{
    [Fact]
    public async Task ComputeAsync_PreservesBomLineEndingsWhitespaceAndFinalNewlineAsBytes()
    {
        byte[] baseline = [0xef, 0xbb, 0xbf, .. Encoding.UTF8.GetBytes("alpha\r\nbeta  \n")];
        byte[] compare = Encoding.UTF8.GetBytes("alpha\nbeta\r");
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        Assert.True(result.IsSuccess, result.Receipt.ReasonCode);
        Assert.True(RevisionSourceDiffVerifier.Verify(plan, result));
        Assert.Equal(baseline.Length, result.Chunks.SelectMany(static chunk => chunk.Hunks).Sum(static hunk => hunk.Base.Length));
        Assert.Equal(compare.Length, result.Chunks.SelectMany(static chunk => chunk.Hunks).Sum(static hunk => hunk.Compare.Length));
        Assert.Contains(result.Chunks.SelectMany(static chunk => chunk.Hunks), static hunk => hunk.Kind == RevisionDiffKind.Replace);
        Assert.Equal(
            [RevisionLineTerminator.CarriageReturnLineFeed, RevisionLineTerminator.LineFeed],
            result.BaseLines.Select(static line => line.TerminatorKind));
        Assert.Equal(
            [RevisionLineTerminator.LineFeed, RevisionLineTerminator.CarriageReturn],
            result.CompareLines.Select(static line => line.TerminatorKind));
        Assert.Equal(RevisionSourceDiffEngine.SegmenterVersion, result.Receipt.SegmenterVersion);
        Assert.Equal(baseline.Length, result.Receipt.BaseSourceByteCount);
        Assert.Equal(compare.Length, result.Receipt.CompareSourceByteCount);
        Assert.Equal(result.BaseLines.Length, result.Receipt.BaseLineCount);
        Assert.Equal(result.CompareLines.Length, result.Receipt.CompareLineCount);
        Assert.Equal(result.Receipt.ContentDigest, result.AttemptReceipt.SemanticContentDigest);
        Assert.True(result.Receipt.EstimatedMemoryBytes > 0);
        Assert.True(result.Receipt.EstimatedOutputBytes > 0);
    }

    [Fact]
    public async Task ComputeAsync_IdenticalSourceProducesOneExactEqualHunk()
    {
        byte[] source = Encoding.UTF8.GetBytes("same\r\ncontent without final newline");
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(source, source);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        RevisionDiffHunk hunk = Assert.Single(Assert.Single(result.Chunks).Hunks);
        Assert.Equal(RevisionDiffKind.Equal, hunk.Kind);
        Assert.Equal(new RevisionByteRange(0, source.Length), hunk.Base);
        Assert.Equal(new RevisionByteRange(0, source.Length), hunk.Compare);
        Assert.Empty(hunk.WordEdits);
    }

    [Fact]
    public async Task ComputeAsync_WordRefinementUsesExactUnicodeGraphemeByteRanges()
    {
        byte[] baseline = Encoding.UTF8.GetBytes("前言 emoji 👩‍💻 cafe\u0301 مرحبا https://a.test/路径\n");
        byte[] compare = Encoding.UTF8.GetBytes("前言 emoji 👩‍🔬 café مرحبتين https://b.test/路径\n");
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        RevisionDiffHunk replacement = Assert.Single(
            result.Chunks.SelectMany(static chunk => chunk.Hunks),
            static hunk => hunk.Kind == RevisionDiffKind.Replace);
        Assert.Equal(2, replacement.WordEdits.Length);
        Assert.All(replacement.WordEdits, edit =>
        {
            Assert.True(edit.Base.Offset >= 0 && edit.Base.End <= baseline.Length);
            Assert.True(edit.Compare.Offset >= 0 && edit.Compare.End <= compare.Length);
            Assert.NotEqual(
                baseline.AsSpan(edit.Base.Offset, edit.Base.Length).ToArray(),
                compare.AsSpan(edit.Compare.Offset, edit.Compare.Length).ToArray());
        });
        Assert.True(result.Receipt.TokenCount > 0);
    }

    [Fact]
    public async Task ComputeAsync_WordRefinementPreservesStableMiddleAnchors()
    {
        byte[] baseline = Encoding.UTF8.GetBytes("alpha old middle bad omega\n");
        byte[] compare = Encoding.UTF8.GetBytes("alpha new middle good omega\n");
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        RevisionDiffHunk replacement = Assert.Single(
            result.Chunks.SelectMany(static chunk => chunk.Hunks),
            static hunk => hunk.Kind == RevisionDiffKind.Replace);
        Assert.Equal(2, replacement.WordEdits.Length);
        Assert.All(replacement.WordEdits, static edit => Assert.Equal(RevisionDiffKind.Replace, edit.Kind));
        Assert.Equal("old", Encoding.UTF8.GetString(
            baseline.AsSpan(replacement.WordEdits[0].Base.Offset, replacement.WordEdits[0].Base.Length)));
        Assert.Equal("new", Encoding.UTF8.GetString(
            compare.AsSpan(replacement.WordEdits[0].Compare.Offset, replacement.WordEdits[0].Compare.Length)));
    }

    [Fact]
    public async Task ComputeAsync_ChunksClosedHunksAndRemainsDeterministic()
    {
        byte[] baseline = Encoding.UTF8.GetBytes("a\nkeep-1\nb\nkeep-2\nc\n");
        byte[] compare = Encoding.UTF8.GetBytes("x\nkeep-1\ny\nkeep-2\nz\n");
        RevisionCompareBudgets budgets = Budgets() with
        {
            MaxHunksPerChunk = 1,
            MaxChunks = 16
        };
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare, budgets);

        RevisionSourceDiffResult first = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);
        RevisionSourceDiffResult second = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        Assert.True(first.Chunks.Length > 1);
        Assert.All(first.Chunks, static chunk => Assert.Single(chunk.Hunks));
        Assert.Equal(first.Receipt, second.Receipt);
        Assert.Equal(first.Receipt.ContentDigest, second.Receipt.ContentDigest);
        Assert.Equal(first.Chunks.Select(static chunk => chunk.ContentDigest), second.Chunks.Select(static chunk => chunk.ContentDigest));
        Assert.True(RevisionSourceDiffVerifier.Verify(plan, first));
    }

    [Fact]
    public async Task ComputeAsync_EnforcesAdmittedHunkAndChunkCapacityBeforeMaterializingOutput()
    {
        byte[] baseline = Encoding.UTF8.GetBytes("one\nkeep-a\ntwo\nkeep-b\nthree\n");
        byte[] compare = Encoding.UTF8.GetBytes("first\nkeep-a\nsecond\nkeep-b\nthird\n");
        RevisionCompareBudgets budgets = Budgets() with
        {
            MaxHunksPerChunk = 1,
            MaxChunks = 2
        };
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(
            baseline,
            compare,
            budgets);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        Assert.Equal(2, plan.Plan.Admission.HunkLimit);
        Assert.Equal(RevisionComparePlanStatus.BudgetExceeded, result.Status);
        Assert.Equal("revision_diff_chunk_budget_exceeded", result.Receipt.ReasonCode);
        Assert.Empty(result.Chunks);
    }

    [Fact]
    public async Task ComputeAsync_ContextGroupsUseStablePlanOwnedLineWindows()
    {
        byte[] baseline = Encoding.UTF8.GetBytes(
            "start\nold-a\nkeep-1\nkeep-2\nkeep-3\nkeep-4\nkeep-5\nkeep-6\nold-b\nend\n");
        byte[] compare = Encoding.UTF8.GetBytes(
            "start\nnew-a\nkeep-1\nkeep-2\nkeep-3\nkeep-4\nkeep-5\nkeep-6\nnew-b\nend\n");
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(
            baseline,
            compare,
            contextLineCount: 1);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        RevisionDiffContextGroup collapsed = Assert.Single(
            result.ContextGroups,
            static group => group.Collapsed && group.BaseLineCount == 4);
        Assert.Equal(3, collapsed.BaseStartLine);
        Assert.Equal(3, collapsed.CompareStartLine);
        Assert.True(RevisionSourceDiffVerifier.Verify(plan, result));

        RevisionDiffContextGroup substituted = collapsed with
        {
            Collapsed = false,
            ContentDigest = RevisionSourceDiffEngine.CreateContextGroupDigest(
                collapsed.Index,
                false,
                collapsed.BaseStartLine,
                collapsed.BaseLineCount,
                collapsed.CompareStartLine,
                collapsed.CompareLineCount,
                collapsed.Base,
                collapsed.Compare)
        };
        ImmutableArray<RevisionDiffContextGroup> contextGroups =
        [.. result.ContextGroups.Select(group => group == collapsed ? substituted : group)];
        Assert.False(RevisionSourceDiffVerifier.Verify(
            plan,
            Reseal(plan, result, result.Chunks, contextGroups: contextGroups)));
    }

    [Fact]
    public async Task ComputeAsync_HandlesOneHundredThousandLinesWithinLinearAdmissionEnvelope()
    {
        string[] lines = Enumerable.Range(0, 100_001).Select(static index => $"line-{index:D6}\n").ToArray();
        byte[] baseline = Encoding.UTF8.GetBytes(string.Concat(lines));
        lines[50_000] = "line-changed\n";
        byte[] compare = Encoding.UTF8.GetBytes(string.Concat(lines));
        RevisionCompareBudgets budgets = Budgets() with
        {
            MaxSourceBytes = 2_000_000,
            MaxLineCount = 110_000,
            MaxMemoryBytes = 64 * 1024 * 1024,
            MaxOutputBytes = 16 * 1024 * 1024,
            MaxTokenCount = 10_000,
            TimeoutMilliseconds = 20_000
        };
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare, budgets);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        Assert.True(result.IsSuccess, result.Receipt.ReasonCode);
        Assert.Contains(result.Chunks.SelectMany(static chunk => chunk.Hunks), static hunk => hunk.Kind == RevisionDiffKind.Replace);
        Assert.True(RevisionSourceDiffVerifier.Verify(plan, result));
    }

    [Fact]
    public async Task ComputeAsync_FullRewriteRemainsOneClosedReplaceWithoutMoveInference()
    {
        byte[] baseline = Encoding.UTF8.GetBytes(string.Concat(
            Enumerable.Range(0, 64).Select(static index => $"old-{index:D2}\n")));
        byte[] compare = Encoding.UTF8.GetBytes(string.Concat(
            Enumerable.Range(0, 64).Select(static index => $"new-{index:D2}\n")));
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        RevisionDiffHunk hunk = Assert.Single(result.Chunks.SelectMany(static chunk => chunk.Hunks));
        Assert.Equal(RevisionDiffKind.Replace, hunk.Kind);
        Assert.DoesNotContain("Move", Enum.GetNames<RevisionDiffKind>());
        Assert.Equal(compare, Apply(result, baseline, compare, forward: true));
        Assert.Equal(baseline, Apply(result, baseline, compare, forward: false));
    }

    [Fact]
    public async Task ComputeAsync_FailsClosedForTokenBudgetAndCancellation()
    {
        byte[] baseline = Encoding.UTF8.GetBytes("abcdefghij\n");
        byte[] compare = Encoding.UTF8.GetBytes("0123456789\n");
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(
            baseline,
            compare,
            Budgets() with
            {
                MaxTokenCount = 3
            });

        RevisionSourceDiffResult budget = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        RevisionSourceDiffResult cancellation = await engine.ComputeAsync(
            plan,
            DateTimeOffset.UtcNow,
            cancelled.Token);

        Assert.Equal(RevisionComparePlanStatus.BudgetExceeded, budget.Status);
        Assert.Equal("revision_diff_token_budget_exceeded", budget.Receipt.ReasonCode);
        Assert.Equal(RevisionComparePlanStatus.Cancelled, cancellation.Status);
        Assert.Empty(cancellation.Chunks);
    }

    [Fact]
    public async Task ComputeAsync_CoalescesLongSingleTokensWithoutQuadraticRebuilding()
    {
        byte[] baseline = Encoding.UTF8.GetBytes(new string('a', 500_000));
        byte[] compare = Encoding.UTF8.GetBytes(new string('b', 500_000));
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(
            baseline,
            compare,
            Budgets() with
            {
                MaxTokenCount = 2
            });

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        Assert.True(result.IsSuccess, result.Receipt.ReasonCode);
        Assert.Equal(2, result.Receipt.TokenCount);
        Assert.Equal(compare, Apply(result, baseline, compare, forward: true));
        Assert.Equal(baseline, Apply(result, baseline, compare, forward: false));
    }

    [Fact]
    public async Task ComputeAsync_StopsLargeSymbolTokenizationAtIncrementalBudget()
    {
        byte[] baseline = Encoding.UTF8.GetBytes(new string('!', 250_000));
        byte[] compare = Encoding.UTF8.GetBytes(new string('?', 250_000));
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(
            baseline,
            compare,
            Budgets() with
            {
                MaxTokenCount = 32
            });

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        Assert.Equal(RevisionComparePlanStatus.BudgetExceeded, result.Status);
        Assert.Equal("revision_diff_token_budget_exceeded", result.Receipt.ReasonCode);
        Assert.Empty(result.Chunks);
    }

    [Fact]
    public async Task ComputeAsync_CancelsWhileScanningLargeSingleToken()
    {
        byte[] baseline = Encoding.UTF8.GetBytes(new string('a', 1_500_000));
        byte[] compare = Encoding.UTF8.GetBytes(new string('b', 1_500_000));
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(
            baseline,
            compare,
            Budgets() with
            {
                MaxSourceBytes = 1_600_000,
                MaxTokenCount = 2,
                TimeoutMilliseconds = 10_000
            });
        using var cancellation = new CancellationTokenSource();

        Task<RevisionSourceDiffResult> pending = engine.ComputeAsync(
            plan,
            DateTimeOffset.UtcNow,
            cancellation.Token);
        await Task.Delay(10);
        cancellation.Cancel();
        RevisionSourceDiffResult result = await pending;

        Assert.Equal(RevisionComparePlanStatus.Cancelled, result.Status);
        Assert.Equal("revision_diff_cancelled", result.Receipt.ReasonCode);
        Assert.Empty(result.Chunks);
    }

    [Fact]
    public async Task ComputeAsync_TreatsStructuredMarkdownAsRawSourceWithoutHtmlOrRegexSubstitution()
    {
        byte[] baseline = Encoding.UTF8.GetBytes(
            "| a | b |\n|---|---|\n| 1 | 2 |\n\n```mermaid\ngraph TD; A-->B\n```\n\n$x^2$\n![alt](a.png) [link](https://a.test/x?q=1)\n");
        byte[] compare = Encoding.UTF8.GetBytes(
            "| a | b |\n|---|---|\n| 1 | 3 |\n\n```mermaid\ngraph TD; A-->C\n```\n\n$x^3$\n![alt](b.png) [link](https://a.test/x?q=2)\n");
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        Assert.True(result.IsSuccess, result.Receipt.ReasonCode);
        byte[] reconstructedCompare = result.Chunks
            .SelectMany(static chunk => chunk.Hunks)
            .SelectMany(hunk => compare.AsSpan(hunk.Compare.Offset, hunk.Compare.Length).ToArray())
            .ToArray();
        Assert.Equal(compare, reconstructedCompare);
        Assert.Empty(result.CompareHeadings);
        Assert.True(RevisionSourceDiffVerifier.Verify(plan, result));
    }

    [Theory]
    [InlineData("", "insert\n", RevisionDiffKind.Insert)]
    [InlineData("delete\n", "", RevisionDiffKind.Delete)]
    [InlineData("", "", RevisionDiffKind.Equal)]
    public async Task ComputeAsync_ClosesEmptyAndOneSidedInputs(
        string baselineText,
        string compareText,
        RevisionDiffKind expected)
    {
        byte[] baseline = Encoding.UTF8.GetBytes(baselineText);
        byte[] compare = Encoding.UTF8.GetBytes(compareText);
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        Assert.True(result.IsSuccess, result.Receipt.ReasonCode);
        RevisionDiffHunk[] hunks = [.. result.Chunks.SelectMany(static chunk => chunk.Hunks)];
        if (expected == RevisionDiffKind.Equal && baseline.Length == 0)
        {
            Assert.Empty(hunks);
        }
        else
        {
            Assert.Equal(expected, Assert.Single(hunks).Kind);
        }
        Assert.True(RevisionSourceDiffVerifier.Verify(plan, result));
    }

    [Fact]
    public async Task ComputeAsync_InvalidUtf8SkipsOnlyWordRefinement()
    {
        byte[] baseline = [0x66, 0x6f, 0x80, 0x0a];
        byte[] compare = [0x66, 0x6f, 0x81, 0x0a];
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        RevisionDiffHunk replacement = Assert.Single(
            result.Chunks.SelectMany(static chunk => chunk.Hunks),
            static hunk => hunk.Kind == RevisionDiffKind.Replace);
        Assert.Empty(replacement.WordEdits);
        Assert.Equal(baseline.Length, replacement.Base.Length);
        Assert.Equal(compare.Length, replacement.Compare.Length);
        Assert.True(RevisionSourceDiffVerifier.Verify(plan, result));
    }

}
