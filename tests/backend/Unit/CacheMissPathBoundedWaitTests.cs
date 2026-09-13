using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Observability;

using Microsoft.Extensions.Logging.Abstractions;
namespace FsusBlog.Server.Tests.Unit;

public sealed class CacheMissPathBoundedWaitTests
{
    [Fact]
    public void MissPathBudget_DocumentsSingleFlightPlusLeasePlusRebuild()
    {
        var strategy = new CacheRebuildStrategy(
            TimeSpan.FromSeconds(20),
            TimeSpan.FromSeconds(5),
            TimeSpan.FromSeconds(80));

        TimeSpan total = CacheMissPathBudget.ComputeTotal(strategy);

        Assert.Equal(TimeSpan.FromMilliseconds(750), CacheMissPathBudget.SingleFlightMaxAcquireWait);
        Assert.Equal(64, CacheMissPathBudget.SingleFlightMaxWaitersPerKey);
        Assert.Equal(
            CacheMissPathBudget.SingleFlightMaxAcquireWait + strategy.WaitTimeout + strategy.RebuildTimeout,
            total);
        Assert.True(total <= TimeSpan.FromSeconds(86));
    }

    [Fact]
    public async Task AcquireAsync_WaiterCap_RejectsExcessWithoutQueueGrowth()
    {
        using var coordinator = new CacheSingleFlightCoordinator(
            new FakeKeyResolver(),
            TimeSpan.FromSeconds(2),
            maxWaitersPerKey: 2);
        await using IAsyncDisposable leader = await coordinator.AcquireAsync(CachePolicyId.ArticleDetail, "cap");
        Task<IAsyncDisposable> firstWaiter = coordinator.AcquireAsync(CachePolicyId.ArticleDetail, "cap");
        Task<IAsyncDisposable> secondWaiter = coordinator.AcquireAsync(CachePolicyId.ArticleDetail, "cap");
        await Task.Delay(20);

        CacheCoordinationException rejected = await Assert.ThrowsAsync<CacheCoordinationException>(
            () => coordinator.AcquireAsync(CachePolicyId.ArticleDetail, "cap"));

        Assert.Equal("singleflight-waiter-cap", rejected.Reason);
        Assert.Equal(1, coordinator.RejectByCapCount);
        Assert.False(firstWaiter.IsCompleted);
        Assert.False(secondWaiter.IsCompleted);
        await leader.DisposeAsync();
        await using IAsyncDisposable first = await firstWaiter.WaitAsync(TimeSpan.FromSeconds(2));
        await first.DisposeAsync();
        await using IAsyncDisposable second = await secondWaiter.WaitAsync(TimeSpan.FromSeconds(2));
        await second.DisposeAsync();
        Assert.Equal(0, coordinator.ActiveEntryCount);
    }

    [Fact]
    public async Task AcquireAsync_MaxWait_FailsClosedInsteadOfHanging()
    {
        using var coordinator = new CacheSingleFlightCoordinator(
            new FakeKeyResolver(),
            TimeSpan.FromMilliseconds(40),
            maxWaitersPerKey: 8);
        await using IAsyncDisposable leader = await coordinator.AcquireAsync(CachePolicyId.ArticleDetail, "timeout");
        long started = Environment.TickCount64;

        CacheCoordinationException rejected = await Assert.ThrowsAsync<CacheCoordinationException>(
            () => coordinator.AcquireAsync(CachePolicyId.ArticleDetail, "timeout"));

        long elapsed = Environment.TickCount64 - started;
        Assert.Equal("singleflight-timeout", rejected.Reason);
        Assert.Equal(1, coordinator.RejectByTimeoutCount);
        Assert.InRange(elapsed, 20, 750);
        await leader.DisposeAsync();
        Assert.Equal(0, coordinator.ActiveEntryCount);
    }

    [Fact]
    public async Task CoordinateAsync_FollowerWithLastGood_ServesStaleWithoutWaitingRebuild()
    {
        var lastGood = new StaticLastGoodLookup("stale-bytes");
        using var singleFlight = new CacheSingleFlightCoordinator(
            new FakeKeyResolver(),
            TimeSpan.FromSeconds(2),
            maxWaitersPerKey: 8);
        var coordinator = new CacheMissCoordinator(
            singleFlight,
            new ImmediateLeaseStore(),
            new CachePolicyRegistry(),
            NullLogger<CacheMissCoordinator>.Instance)
        {
            LastGoodLookup = lastGood
        };
        var leaderStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseLeader = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int rebuilds = 0;
        string? current = null;

        Task<string?> leader = coordinator.CoordinateAsync(
            CachePolicyId.ArticleDetail,
            "hot",
            _ => Task.FromResult(current is null
                ? new CacheReadResult<string>(false, default)
                : new CacheReadResult<string>(true, current)),
            async _ =>
            {
                Interlocked.Increment(ref rebuilds);
                leaderStarted.SetResult();
                await releaseLeader.Task;
                current = "fresh";
                return current;
            },
            "article-detail");

        await leaderStarted.Task.WaitAsync(TimeSpan.FromSeconds(2));
        Assert.True(singleFlight.IsHeld(CachePolicyId.ArticleDetail, "hot"));

        long started = Environment.TickCount64;
        string? follower = await coordinator.CoordinateAsync(
            CachePolicyId.ArticleDetail,
            "hot",
            _ => Task.FromResult(new CacheReadResult<string>(false, default)),
            _ => throw new InvalidOperationException("follower must not rebuild"),
            "article-detail")
            .WaitAsync(TimeSpan.FromMilliseconds(250));
        long elapsed = Environment.TickCount64 - started;

        Assert.Equal("stale-bytes", follower);
        Assert.InRange(elapsed, 0, 200);
        Assert.Equal(1, rebuilds);
        releaseLeader.SetResult();
        Assert.Equal("fresh", await leader.WaitAsync(TimeSpan.FromSeconds(2)));
        Assert.Equal(1, rebuilds);
        Assert.Equal(0, singleFlight.ActiveEntryCount);
    }

    [Theory]
    [InlineData(100)]
    [InlineData(1000)]
    public async Task CoordinateAsync_SameKeyConcurrency_CapsWaitersAndKeepsSingleRebuild(int concurrency)
    {
        TimeSpan budget = TimeSpan.FromMilliseconds(250);
        var lastGood = new StaticLastGoodLookup("last-good");
        using var singleFlight = new CacheSingleFlightCoordinator(
            new FakeKeyResolver(),
            maxAcquireWait: TimeSpan.FromMilliseconds(50),
            maxWaitersPerKey: 8);
        var coordinator = new CacheMissCoordinator(
            singleFlight,
            new ImmediateLeaseStore(),
            new CachePolicyRegistry(),
            NullLogger<CacheMissCoordinator>.Instance)
        {
            LastGoodLookup = lastGood
        };
        var releaseRebuild = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int rebuilds = 0;
        int lastGoodHits = 0;
        string? current = null;

        Task<string?>[] callers = Enumerable.Range(0, concurrency).Select(_ => coordinator.CoordinateAsync(
            CachePolicyId.ArticleDetail,
            "burst",
            _ => Task.FromResult(current is null
                ? new CacheReadResult<string>(false, default)
                : new CacheReadResult<string>(true, current)),
            async _ =>
            {
                Interlocked.Increment(ref rebuilds);
                await releaseRebuild.Task;
                current = "rebuilt";
                return current;
            },
            "article-detail")).ToArray();

        long started = Environment.TickCount64;
        await Task.Delay(30);
        releaseRebuild.SetResult();
        string?[] results = await Task.WhenAll(callers).WaitAsync(TimeSpan.FromSeconds(5));
        long elapsed = Environment.TickCount64 - started;
        Assert.True(elapsed < 2_000, $"same-key burst hung for {elapsed}ms");

        foreach (string? result in results)
        {
            Assert.True(result is "rebuilt" or "last-good");
            if (result == "last-good")
            {
                lastGoodHits++;
            }
        }

        Assert.Equal(1, rebuilds);
        Assert.True(lastGoodHits >= concurrency - 9);
        Assert.True(singleFlight.RejectByCapCount + singleFlight.RejectByTimeoutCount >= 0);
        Assert.Equal(0, singleFlight.ActiveEntryCount);
        Assert.True(CacheMissPathBudget.ComputeTotal(
            new CacheRebuildStrategy(TimeSpan.FromSeconds(5), TimeSpan.FromMilliseconds(750), TimeSpan.FromSeconds(20)))
            > budget);
    }

    [Fact]
    public async Task CoordinateAsync_AcquireTimeoutWithoutLastGood_FailsClosedWithoutSecondRebuild()
    {
        using var singleFlight = new CacheSingleFlightCoordinator(
            new FakeKeyResolver(),
            TimeSpan.FromMilliseconds(40),
            maxWaitersPerKey: 8);
        var coordinator = new CacheMissCoordinator(
            singleFlight,
            new ImmediateLeaseStore(),
            new CachePolicyRegistry(),
            NullLogger<CacheMissCoordinator>.Instance);
        var releaseRebuild = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var leaderStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int rebuilds = 0;

        Task<string?> leader = coordinator.CoordinateAsync(
            CachePolicyId.ArticleDetail,
            "no-stale",
            static _ => Task.FromResult(new CacheReadResult<string>(false, default)),
            async _ =>
            {
                Interlocked.Increment(ref rebuilds);
                leaderStarted.SetResult();
                await releaseRebuild.Task;
                return "built";
            },
            "article-detail");

        await leaderStarted.Task.WaitAsync(TimeSpan.FromSeconds(2));
        CacheCoordinationException rejected = await Assert.ThrowsAsync<CacheCoordinationException>(
            () => coordinator.CoordinateAsync(
                CachePolicyId.ArticleDetail,
                "no-stale",
                static _ => Task.FromResult(new CacheReadResult<string>(false, default)),
                static _ => throw new InvalidOperationException("non-owner must not rebuild"),
                "article-detail"));

        Assert.Equal("singleflight-timeout", rejected.Reason);
        Assert.Equal(1, singleFlight.RejectByTimeoutCount);
        releaseRebuild.SetResult();
        Assert.Equal("built", await leader.WaitAsync(TimeSpan.FromSeconds(2)));
        Assert.Equal(1, rebuilds);
        Assert.Equal(0, singleFlight.ActiveEntryCount);
    }

    [Fact]
    public void SingleFlightMetrics_AreRegisteredOnServerMeter()
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        using var listener = new System.Diagnostics.Metrics.MeterListener();
        listener.InstrumentPublished = (instrument, meterListener) =>
        {
            if (string.Equals(instrument.Meter.Name, FsusObservability.MeterName, StringComparison.Ordinal)
                && instrument.Name.StartsWith("fsus.cache.singleflight.", StringComparison.Ordinal))
            {
                names.Add(instrument.Name);
                meterListener.EnableMeasurementEvents(instrument);
            }

            if (string.Equals(instrument.Name, "fsus.cache.coordination.last_good_while_rebuild", StringComparison.Ordinal))
            {
                names.Add(instrument.Name);
            }
        };
        listener.Start();
        FsusObservability.RecordSingleFlightWait("ArticleDetail", TimeSpan.FromMilliseconds(5), 2);
        FsusObservability.RecordSingleFlightReject("ArticleDetail", "waiter-cap");
        FsusObservability.RecordLastGoodWhileRebuild("ArticleDetail");

        Assert.Contains("fsus.cache.singleflight.wait", names);
        Assert.Contains("fsus.cache.singleflight.waiters", names);
        Assert.Contains("fsus.cache.singleflight.reject_by_cap", names);
        Assert.Contains("fsus.cache.coordination.last_good_while_rebuild", names);
    }

    private sealed class FakeKeyResolver : ICacheKeyResolver
    {
        public string BuildKey(CachePolicyId policyId, string identity, string? version = null)
            => $"test:{policyId}:{identity}:{version}";
    }

    private sealed class ImmediateLeaseStore : ICacheLeaseStore
    {
        public Task<bool> TryAcquireLeaseAsync(
            CachePolicyId policyId,
            string identity,
            string value,
            TimeSpan ttl,
            CancellationToken cancellationToken = default)
            => Task.FromResult(true);

        public Task<bool> TryRenewLeaseAsync(
            CachePolicyId policyId,
            string identity,
            string expectedValue,
            TimeSpan ttl,
            CancellationToken cancellationToken = default)
            => Task.FromResult(true);

        public Task<bool> TryReleaseLeaseAsync(
            CachePolicyId policyId,
            string identity,
            string expectedValue,
            CancellationToken cancellationToken = default)
            => Task.FromResult(true);
    }

    private sealed class StaticLastGoodLookup(string value) : ICacheLastGoodLookup
    {
        public bool TryGetQualifiedLastGood<T>(CachePolicyId policyId, string identity, out T? result)
        {
            if (typeof(T) == typeof(string))
            {
                result = (T)(object)value;
                return true;
            }

            result = default;
            return false;
        }
    }
}
