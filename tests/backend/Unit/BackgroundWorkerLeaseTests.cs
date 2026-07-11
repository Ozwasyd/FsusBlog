using System.Collections.Concurrent;
using FsusBlog.Server.Infrastructure;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.VisitLog;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class BackgroundWorkerLeaseTests
{
    [Fact]
    public async Task TryRunAsLeaderAsync_ConcurrentInstances_OnlyLeaderRuns()
    {
        var cache = new LeaseMemoryCache();
        var first = CreateLease(cache);
        var second = CreateLease(cache);
        int executions = 0;

        bool firstRan = await first.TryRunAsLeaderAsync(
            "crawler-update-worker",
            _ =>
            {
                Interlocked.Increment(ref executions);
                return Task.CompletedTask;
            });
        bool secondRan = await second.TryRunAsLeaderAsync(
            "crawler-update-worker",
            _ =>
            {
                Interlocked.Increment(ref executions);
                return Task.CompletedTask;
            });

        Assert.True(firstRan);
        Assert.False(secondRan);
        Assert.Equal(1, executions);
    }

    [Fact]
    public async Task TryRunAsLeaderAsync_ExpiredLease_AllowsNewLeader()
    {
        var time = new MutableTimeProvider(DateTimeOffset.Parse("2026-06-25T00:00:00Z"));
        var cache = new LeaseMemoryCache(time);
        var first = CreateLease(cache, time, TimeSpan.FromSeconds(5));
        var second = CreateLease(cache, time, TimeSpan.FromSeconds(5));
        int executions = 0;

        Assert.True(await first.TryRunAsLeaderAsync("scheduled-publish-worker", _ =>
        {
            Interlocked.Increment(ref executions);
            return Task.CompletedTask;
        }));

        time.Advance(TimeSpan.FromSeconds(6));

        Assert.True(await second.TryRunAsLeaderAsync("scheduled-publish-worker", _ =>
        {
            Interlocked.Increment(ref executions);
            return Task.CompletedTask;
        }));
        Assert.Equal(2, executions);
    }

    [Fact]
    public async Task TryRunAsLeaderAsync_SameInstance_CanRenewLeadershipBeforeExpiry()
    {
        var time = new MutableTimeProvider(DateTimeOffset.Parse("2026-06-25T00:00:00Z"));
        var cache = new LeaseMemoryCache(time);
        var lease = CreateLease(cache, time, TimeSpan.FromSeconds(5));
        int executions = 0;

        Assert.True(await lease.TryRunAsLeaderAsync("pow-load-reset-worker", _ =>
        {
            Interlocked.Increment(ref executions);
            return Task.CompletedTask;
        }));
        time.Advance(TimeSpan.FromSeconds(1));

        Assert.True(await lease.TryRunAsLeaderAsync("pow-load-reset-worker", _ =>
        {
            Interlocked.Increment(ref executions);
            return Task.CompletedTask;
        }));
        Assert.Equal(2, executions);
    }

    [Fact]
    [Trait("Category", "Concurrency")]
    public async Task TryRunAsLeaderAsync_RenewsLeaseDuringLongWork()
    {
        var cache = new LeaseMemoryCache();
        var leader = CreateLease(cache, leaseTtl: TimeSpan.FromSeconds(2), renewInterval: TimeSpan.FromMilliseconds(100));
        var standby = CreateLease(cache, leaseTtl: TimeSpan.FromSeconds(2), renewInterval: TimeSpan.FromMilliseconds(100));
        var leaderStarted = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseLeader = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        int leaderExecutions = 0;
        int standbyExecutions = 0;

        Task<bool> leaderTask = leader.TryRunAsLeaderAsync(
            "pow-load-reset-worker",
            async token =>
            {
                Interlocked.Increment(ref leaderExecutions);
                leaderStarted.SetResult(true);
                await releaseLeader.Task.WaitAsync(token);
            });

        await leaderStarted.Task.WaitAsync(TimeSpan.FromSeconds(10));
        await Task.Delay(2500);
        bool standbyRan = await standby.TryRunAsLeaderAsync(
            "pow-load-reset-worker",
            _ =>
            {
                Interlocked.Increment(ref standbyExecutions);
                return Task.CompletedTask;
            });

        releaseLeader.SetResult(true);
        bool leaderRan = await leaderTask.WaitAsync(TimeSpan.FromSeconds(10));

        Assert.True(leaderRan);
        Assert.False(standbyRan);
        Assert.Equal(1, leaderExecutions);
        Assert.Equal(0, standbyExecutions);
    }

    [Fact]
    public async Task TryRunAsLeaderAsync_LeaseCacheFailure_SkipsIterationWithoutRunningAction()
    {
        var cache = new LeaseMemoryCache { ThrowOnAcquire = true };
        var lease = CreateLease(cache);
        int executions = 0;

        bool ran = await lease.TryRunAsLeaderAsync(
            "scheduled-publish-worker",
            _ =>
            {
                Interlocked.Increment(ref executions);
                return Task.CompletedTask;
            });

        Assert.False(ran);
        Assert.Equal(0, executions);
    }

    [Theory]
    [MemberData(nameof(LeasedWorkerTypes))]
    public void AffectedBackgroundWorkers_UseLeaderLease(Type workerType, string workerName)
    {
        string runtimeShape = RuntimeMetadataInspection.DescribeType(workerType);

        Assert.Contains("IBackgroundWorkerLease", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("TryRunAsLeaderAsync", runtimeShape, StringComparison.Ordinal);
        Assert.Contains(workerName, runtimeShape, StringComparison.Ordinal);
    }

    public static TheoryData<Type, string> LeasedWorkerTypes => new()
    {
        { typeof(ArticleMutationOutboxDispatcher), "article-mutation-outbox-dispatcher" },
        { typeof(LogCleanupService), "log-cleanup-worker" },
        { typeof(ScheduledPublishWorker), "scheduled-publish-worker" },
        { typeof(UploadSessionCleanupWorker), "upload-session-cleanup-worker" },
        { typeof(PublicAotBackfillWorker), "public-aot-backfill-worker" },
        { typeof(CrawlerUpdateWorker), "crawler-update-worker" },
        { typeof(PowLoadResetWorker), "pow-load-reset-worker" },
        { typeof(ArticleViewProjectionRepairWorker), "article-view-projection-repair-worker" }
    };

    private static BackgroundWorkerLease CreateLease(
        IUnifiedCache cache,
        TimeProvider? timeProvider = null,
        TimeSpan? leaseTtl = null,
        TimeSpan? renewInterval = null)
        => new(
            cache,
            NullLogger<BackgroundWorkerLease>.Instance,
            new BackgroundWorkerLeaseOptions(
                leaseTtl ?? TimeSpan.FromSeconds(5),
                renewInterval ?? TimeSpan.FromSeconds(1),
                "test-node"),
            timeProvider ?? TimeProvider.System);

    private sealed class LeaseMemoryCache(TimeProvider? timeProvider = null) : IUnifiedCache
    {
        private readonly ConcurrentDictionary<string, Entry> _entries = new(StringComparer.Ordinal);
        private readonly TimeProvider _timeProvider = timeProvider ?? TimeProvider.System;

        public bool ThrowOnAcquire { get; init; }

        public Task<bool> TryAcquireLeaseAsync(CachePolicyId policyId, string identity, string value, TimeSpan ttl, CancellationToken cancellationToken = default)
        {
            if (ThrowOnAcquire)
            {
                throw new InvalidOperationException("lease cache unavailable");
            }

            string key = $"{policyId}:{identity}";
            DateTimeOffset now = _timeProvider.GetUtcNow();
            DateTimeOffset expiresAt = now.Add(ttl);
            while (true)
            {
                if (!_entries.TryGetValue(key, out Entry? existing) || existing.ExpiresAt <= now)
                {
                    if (_entries.TryAdd(key, new Entry(value, expiresAt)))
                    {
                        return Task.FromResult(true);
                    }

                    _entries.TryUpdate(key, new Entry(value, expiresAt), existing!);
                    continue;
                }

                return Task.FromResult(false);
            }
        }

        public Task<bool> TrySetStringIfValueAsync(
            CachePolicyId policyId,
            string identity,
            string value,
            string compareIdentity,
            string expectedCompareValue,
            TimeSpan? l2TtlOverride = null,
            CancellationToken cancellationToken = default)
        {
            string key = $"{policyId}:{identity}";
            DateTimeOffset now = _timeProvider.GetUtcNow();
            if (!_entries.TryGetValue(key, out Entry? existing)
                || existing.ExpiresAt <= now
                || existing.Value != expectedCompareValue)
            {
                return Task.FromResult(false);
            }

            TimeSpan ttl = l2TtlOverride ?? TimeSpan.FromSeconds(5);
            _entries[key] = new Entry(value, now.Add(ttl));
            return Task.FromResult(true);
        }

        public Task<CacheReadResult<T>> TryGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<CacheReadResult<byte[]>> TryGetRawAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<CacheReadResult<ReadOnlyMemory<byte>>> TryGetRawReadonlyAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task SetRawAsync(CachePolicyId policyId, string identity, byte[] value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task SetNegativeAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<string?> GetStringAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task SetStringAsync(CachePolicyId policyId, string identity, string value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<long> IncrementAsync(CachePolicyId policyId, string identity, long value = 1, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<bool> ConsumeOnceAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<CacheReadResult<T>> ConsumeOnceAndGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task RemoveAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task RemoveManyAsync(IReadOnlyList<CacheKeyIdentity> keys, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task RemoveByPrefixAsync(CachePolicyId policyId, string identityPrefix, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task RemoveByPrefixManyAsync(IReadOnlyList<CachePrefixIdentity> prefixes, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<IAsyncDisposable> AcquireSingleFlightAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public string BuildKey(CachePolicyId policyId, string identity, string? version = null)
            => $"{policyId}:{identity}:{version}";

        private sealed record Entry(string Value, DateTimeOffset ExpiresAt);
    }

    private sealed class MutableTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        private DateTimeOffset _utcNow = utcNow;

        public override DateTimeOffset GetUtcNow() => _utcNow;

        public void Advance(TimeSpan delta) => _utcNow = _utcNow.Add(delta);
    }
}
