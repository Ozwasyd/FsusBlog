using System.Text;

using FsusBlog.Core.Services.Articles;

namespace FsusBlog.Server.Tests.Unit;

public sealed partial class RevisionSourceDiffTests
{
    [Fact]
    public async Task ComputeAsync_RejectsDenseSymbolsBeforeTokenWorkspaceAllocation()
    {
        byte[] baseline = Encoding.UTF8.GetBytes(new string('^', 250_000));
        byte[] compare = Encoding.UTF8.GetBytes(new string('+', 250_000));
        RevisionCompareBudgets budgets = Budgets() with
        {
            MaxTokenCount = 500_000,
            MaxMemoryBytes = 4 * 1024 * 1024,
            TimeoutMilliseconds = 20_000
        };
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare, budgets);
        Assert.Equal(2_000_128, plan.Plan.Admission.InitialEstimatedMemoryBytes);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        Assert.Equal(RevisionComparePlanStatus.BudgetExceeded, result.Status);
        Assert.Equal("revision_diff_memory_budget_exceeded", result.Receipt.ReasonCode);
        Assert.True(result.Receipt.EstimatedMemoryBytes > budgets.MaxMemoryBytes);
        Assert.Empty(result.Chunks);
        Assert.Empty(result.BaseLines);
        Assert.Empty(result.CompareLines);
        Assert.Equal(0, result.Receipt.TokenCount);
        Assert.False(RevisionSourceDiffVerifier.Verify(plan, result));
    }

    [Fact]
    public async Task ComputeAsync_AdmitsTheSameDenseSymbolsWithTheirFullWorkspaceBudget()
    {
        byte[] baseline = Encoding.UTF8.GetBytes(new string('^', 250_000));
        byte[] compare = Encoding.UTF8.GetBytes(new string('+', 250_000));
        RevisionCompareBudgets budgets = Budgets() with
        {
            MaxTokenCount = 500_000,
            MaxMemoryBytes = 256 * 1024 * 1024,
            TimeoutMilliseconds = 20_000
        };
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare, budgets);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        Assert.True(result.IsSuccess, result.Receipt.ReasonCode);
        Assert.Equal(500_000, result.Receipt.TokenCount);
        Assert.True(result.Receipt.EstimatedMemoryBytes > 4 * 1024 * 1024);
        Assert.True(result.Receipt.EstimatedMemoryBytes <= budgets.MaxMemoryBytes);
        RevisionDiffHunk replacement = Assert.Single(Assert.Single(result.Chunks).Hunks);
        RevisionDiffWordEdit word = Assert.Single(replacement.WordEdits);
        Assert.Equal(new RevisionByteRange(0, 250_000), word.Base);
        Assert.Equal(new RevisionByteRange(0, 250_000), word.Compare);
        Assert.True(RevisionSourceDiffVerifier.Verify(plan, result));
        Assert.Equal(compare, Apply(result, baseline, compare, forward: true));
        Assert.Equal(baseline, Apply(result, baseline, compare, forward: false));
    }

    [Fact]
    public async Task ComputeAsync_ReleasesEachHunksWorkspaceButRetainsThePeak()
    {
        byte[] baseline = Encoding.UTF8.GetBytes(string.Concat(Enumerable.Range(0, 12)
            .Select(index => new string('^', 4_000) + "\nstable-" + index + "\n")));
        byte[] compare = Encoding.UTF8.GetBytes(string.Concat(Enumerable.Range(0, 12)
            .Select(index => new string('+', 4_000) + "\nstable-" + index + "\n")));
        RevisionCompareBudgets budgets = Budgets() with
        {
            MaxMemoryBytes = 8 * 1024 * 1024,
            TimeoutMilliseconds = 20_000
        };
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare, budgets);

        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        Assert.True(result.IsSuccess, result.Receipt.ReasonCode);
        Assert.Equal(96_024, result.Receipt.TokenCount);
        Assert.Equal(12, result.Chunks.SelectMany(static chunk => chunk.Hunks)
            .Count(static hunk => hunk.Kind == RevisionDiffKind.Replace));
        Assert.True(result.Receipt.TokenCount * 512L > budgets.MaxMemoryBytes);
        Assert.True(result.Receipt.EstimatedMemoryBytes <= budgets.MaxMemoryBytes);
        Assert.True(RevisionSourceDiffVerifier.Verify(plan, result));
        Assert.Equal(compare, Apply(result, baseline, compare, forward: true));
        Assert.Equal(baseline, Apply(result, baseline, compare, forward: false));
    }

    [Fact]
    public async Task ComputeAsync_LargeCoalescedWordsAndUnchangedSymbolsAreNotRejectedByByteSize()
    {
        foreach ((char baseValue, char compareValue, int tokens) in new[]
        {
            ('a', 'b', 2),
            ('^', '^', 0)
        })
        {
            byte[] baseline = Encoding.UTF8.GetBytes(new string(baseValue, 250_000));
            byte[] compare = Encoding.UTF8.GetBytes(new string(compareValue, 250_000));
            RevisionCompareBudgets budgets = Budgets() with
            {
                MaxTokenCount = 500_000,
                MaxMemoryBytes = 4 * 1024 * 1024,
                TimeoutMilliseconds = 20_000
            };
            (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare, budgets);

            RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

            Assert.True(result.IsSuccess, result.Receipt.ReasonCode);
            Assert.Equal(tokens, result.Receipt.TokenCount);
            Assert.True(result.Receipt.EstimatedMemoryBytes <= budgets.MaxMemoryBytes);
            Assert.True(RevisionSourceDiffVerifier.Verify(plan, result));
            Assert.Equal(compare, Apply(result, baseline, compare, forward: true));
            Assert.Equal(baseline, Apply(result, baseline, compare, forward: false));
        }
    }

    [Fact]
    public async Task ComputeAsync_PreflightPreservesUnicodeSegmentationAndByteRanges()
    {
        byte[] baseline = Encoding.UTF8.GetBytes(new string('中', 20_000) + " 👩‍💻 cafe\u0301 مرحبا");
        byte[] compare = Encoding.UTF8.GetBytes(new string('文', 20_000) + " 👩‍🔬 cafe\u0301 مرحبتين");
        RevisionCompareBudgets budgets = Budgets() with
        {
            MaxMemoryBytes = 4 * 1024 * 1024
        };
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare, budgets);

        RevisionSourceDiffResult first = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);
        RevisionSourceDiffResult second = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);

        Assert.True(first.IsSuccess, first.Receipt.ReasonCode);
        Assert.Equal(first.Receipt, second.Receipt);
        RevisionDiffHunk replacement = Assert.Single(Assert.Single(first.Chunks).Hunks);
        Assert.Contains(replacement.WordEdits, static word => word.Base.Length == 60_000 && word.Compare.Length == 60_000);
        Assert.True(RevisionSourceDiffVerifier.Verify(plan, first));
        Assert.Equal(compare, Apply(first, baseline, compare, forward: true));
        Assert.Equal(baseline, Apply(first, baseline, compare, forward: false));
    }

    [Fact]
    public void MemoryLedger_ReservesBeforeAllocationAndReleasesWithoutErasingPeak()
    {
        var memory = new RevisionSourceDiffEngine.MemoryBudget(4_096);
        memory.Retain(128);
        using (memory.Reserve(3_000))
        {
            Assert.Equal(3_128, memory.PeakBytes);
            RevisionSourceDiffEngine.MemoryBudgetExceededException failure =
                Assert.Throws<RevisionSourceDiffEngine.MemoryBudgetExceededException>(() => memory.Retain(1_000));
            Assert.Equal(4_128, failure.RequestedBytes);
        }
        using (memory.Reserve(3_000))
        {
            Assert.Equal(3_128, memory.PeakBytes);
        }
        memory.Retain(3_968);
        Assert.Equal(4_096, memory.PeakBytes);
        Assert.Throws<RevisionSourceDiffEngine.MemoryBudgetExceededException>(() => memory.Retain(1));
    }

    [Fact]
    public void WordPreflight_RespectsCancellationBeforeDecodingOrMaterializingTokens()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        Assert.Throws<OperationCanceledException>(() => RevisionSourceDiffEngine.PrepareWordTokenization(
            Encoding.UTF8.GetBytes("👩‍💻中^"),
            Encoding.UTF8.GetBytes("👩‍🔬文+"),
            100,
            cancellation.Token));
    }

    [Fact]
    public async Task Verify_RejectsResealedPeakAndTokenCountUnderstatement()
    {
        byte[] baseline = Encoding.UTF8.GetBytes("alpha ^^^ middle\n");
        byte[] compare = Encoding.UTF8.GetBytes("alpha +++ middle\n");
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(baseline, compare);
        RevisionSourceDiffResult result = await engine.ComputeAsync(plan, DateTimeOffset.UtcNow);
        Assert.True(RevisionSourceDiffVerifier.Verify(plan, result));

        foreach (bool mutateTokens in new[] { false, true })
        {
            RevisionSourceDiffReceipt receipt = RevisionSourceDiffEngine.CreateReceipt(
                plan, result.Status, result.Receipt.ReasonCode, result.Receipt.StructureParserVersion,
                result.Receipt.BaseStructureDigest, result.Receipt.CompareStructureDigest,
                result.BaseLines, result.CompareLines, result.BaseHeadings, result.CompareHeadings,
                result.ContextGroups,
                mutateTokens ? result.Receipt.EstimatedMemoryBytes : result.Receipt.EstimatedMemoryBytes - 1,
                result.Receipt.EstimatedOutputBytes,
                mutateTokens ? result.Receipt.TokenCount - 1 : result.Receipt.TokenCount,
                result.Chunks);
            RevisionSourceDiffResult tampered = result with
            {
                Receipt = receipt,
                AttemptReceipt = RevisionSourceDiffEngine.CreateAttemptReceipt(receipt, 0)
            };
            Assert.False(RevisionSourceDiffVerifier.Verify(plan, tampered));
        }
    }
}
