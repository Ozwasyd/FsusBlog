using System.Text;

using FsusBlog.Core.Services.Articles;

namespace FsusBlog.Server.Tests.Unit;

public sealed partial class RevisionSourceDiffTests
{
    [Fact]
    public async Task ComputeAsync_RejectsDraftEpochDriftDuringExactPackageReread()
    {
        RevisionComparePackage draft = DraftPackage("epoch-a", 4, "draft\n");
        RevisionComparePackage historical = Package(
            RevisionCompareSourceKind.HistoricalRevision,
            11,
            1,
            Encoding.UTF8.GetBytes("history\n"));
        var reader = new MutableReader(draft, historical);
        var request = new RevisionComparePlanRequest(
            7,
            new RevisionCompareReadContext(5, "primary", Guid.Parse("f6cc3f8c-b06f-437c-8c0f-91da744ad783")),
            new RevisionCompareSourceSelector(
                RevisionCompareSourceKind.CurrentDraft,
                DraftKey: "draft-key",
                ExpectedServerRevision: 4,
                DocumentEpoch: "epoch-a"),
            new RevisionCompareSourceSelector(RevisionCompareSourceKind.HistoricalRevision, RevisionId: 11),
            new RevisionCompareOptions(
                RevisionCompareViewMode.Unified,
                RevisionCompareWordSegmentation.UnicodeTextElementsV1,
                3,
                false,
                ["title"]),
            Budgets(),
            "diff:7:draft:11",
            DateTimeOffset.UtcNow.AddMinutes(5));
        RevisionComparePlanResult planned = await new RevisionComparePlanner(reader).CreateAsync(request);
        Assert.True(planned.IsSuccess, planned.Receipt.ReasonCode);
        reader.Baseline = DraftPackage("epoch-b", 5, "changed\n");
        var engine = new RevisionSourceDiffEngine(
            new RevisionComparePlanVerifier(reader),
            new RevisionMarkdownStructureAuthority([]));

        RevisionSourceDiffResult result = await engine.ComputeAsync(planned.Bundle!, DateTimeOffset.UtcNow);

        Assert.Equal(RevisionComparePlanStatus.Stale, result.Status);
        Assert.Equal("revision_compare_source_stale", result.Receipt.ReasonCode);
        Assert.Empty(result.Chunks);
    }

    [Fact]
    public async Task ComputeAsync_RejectsDraftDriftWhileCanonicalStructureReadIsInFlight()
    {
        RevisionComparePackage draft = DraftPackage("epoch-a", 4, "# Draft\nbody\n");
        RevisionComparePackage historical = Package(
            RevisionCompareSourceKind.HistoricalRevision,
            11,
            1,
            Encoding.UTF8.GetBytes("# History\nbody\n"));
        var reader = new MutableReader(draft, historical);
        var request = new RevisionComparePlanRequest(
            7,
            new RevisionCompareReadContext(5, "primary", Guid.Parse("f6cc3f8c-b06f-437c-8c0f-91da744ad783")),
            new RevisionCompareSourceSelector(
                RevisionCompareSourceKind.CurrentDraft,
                DraftKey: "draft-key",
                ExpectedServerRevision: 4,
                DocumentEpoch: "epoch-a"),
            new RevisionCompareSourceSelector(RevisionCompareSourceKind.HistoricalRevision, RevisionId: 11),
            new RevisionCompareOptions(
                RevisionCompareViewMode.Unified,
                RevisionCompareWordSegmentation.UnicodeTextElementsV1,
                3,
                true,
                ["title"]),
            Budgets(),
            "diff:7:draft:11",
            DateTimeOffset.UtcNow.AddMinutes(5));
        RevisionComparePlanResult planned = await new RevisionComparePlanner(reader).CreateAsync(request);
        Assert.True(planned.IsSuccess, planned.Receipt.ReasonCode);
        var provider = new CoordinatedStructureProvider(
            Structure(draft.RawMarkdown.ToArray(), (1, 0, LineRange(draft.RawMarkdown.ToArray(), 0, 1))),
            Structure(historical.RawMarkdown.ToArray(), (1, 0, LineRange(historical.RawMarkdown.ToArray(), 0, 1))));
        var engine = new RevisionSourceDiffEngine(
            new RevisionComparePlanVerifier(reader),
            new RevisionMarkdownStructureAuthority([provider]));

        Task<RevisionSourceDiffResult> pending = engine.ComputeAsync(planned.Bundle!, DateTimeOffset.UtcNow);
        await provider.Started.Task.WaitAsync(TimeSpan.FromSeconds(5));
        reader.Baseline = DraftPackage("epoch-b", 5, "# Changed\nbody\n");
        provider.Release.TrySetResult();
        RevisionSourceDiffResult result = await pending;

        Assert.Equal(RevisionComparePlanStatus.Stale, result.Status);
        Assert.Equal("revision_compare_source_stale", result.Receipt.ReasonCode);
        Assert.Empty(result.Chunks);
    }

    [Fact]
    public async Task ComputeAsync_RejectsLateStructureResponseAfterRequestCancellation()
    {
        byte[] baseline = Encoding.UTF8.GetBytes("# Old\nbody\n");
        byte[] compare = Encoding.UTF8.GetBytes("# New\nbody\n");
        var provider = new LateStructureProvider(
            TimeSpan.FromMilliseconds(30),
            Structure(baseline, (1, 0, LineRange(baseline, 0, 1))),
            Structure(compare, (1, 0, LineRange(compare, 0, 1))));
        (RevisionSourceDiffEngine engine, RevisionComparePlanBundle plan) = await SetupAsync(
            baseline,
            compare,
            headingNavigation: true,
            structureProvider: provider);
        using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(5));

        RevisionSourceDiffResult result = await engine.ComputeAsync(
            plan,
            DateTimeOffset.UtcNow,
            cancellation.Token);

        Assert.Equal(RevisionComparePlanStatus.Cancelled, result.Status);
        Assert.Equal("revision_diff_cancelled", result.Receipt.ReasonCode);
        Assert.Empty(result.Chunks);
    }

    [Fact]
    public async Task ComputeAsync_FailsClosedForStructureTimeoutAndWorkerMemoryBudget()
    {
        byte[] headingBase = Encoding.UTF8.GetBytes("# Old\nbody\n");
        byte[] headingCompare = Encoding.UTF8.GetBytes("# New\nbody\n");
        var slowProvider = new LateStructureProvider(
            TimeSpan.FromMilliseconds(30),
            Structure(headingBase, (1, 0, LineRange(headingBase, 0, 1))),
            Structure(headingCompare, (1, 0, LineRange(headingCompare, 0, 1))));
        (RevisionSourceDiffEngine timeoutEngine, RevisionComparePlanBundle timeoutPlan) = await SetupAsync(
            headingBase,
            headingCompare,
            Budgets() with
            {
                TimeoutMilliseconds = 10
            },
            headingNavigation: true,
            structureProvider: slowProvider);

        RevisionSourceDiffResult timeout = await timeoutEngine.ComputeAsync(timeoutPlan, DateTimeOffset.UtcNow);

        Assert.Equal(RevisionComparePlanStatus.Cancelled, timeout.Status);
        Assert.Equal("revision_diff_timeout", timeout.Receipt.ReasonCode);
        Assert.Empty(timeout.Chunks);

        byte[] baseline = Encoding.UTF8.GetBytes(string.Concat(Enumerable.Repeat("x\n", 100)));
        byte[] compare = Encoding.UTF8.GetBytes(string.Concat(Enumerable.Repeat("y\n", 100)));
        (RevisionSourceDiffEngine memoryEngine, RevisionComparePlanBundle memoryPlan) = await SetupAsync(
            baseline,
            compare,
            Budgets() with
            {
                MaxMemoryBytes = 20_000
            });

        RevisionSourceDiffResult memory = await memoryEngine.ComputeAsync(memoryPlan, DateTimeOffset.UtcNow);

        Assert.Equal(RevisionComparePlanStatus.BudgetExceeded, memory.Status);
        Assert.Equal("revision_diff_memory_budget_exceeded", memory.Receipt.ReasonCode);
        Assert.Empty(memory.Chunks);
    }
}
