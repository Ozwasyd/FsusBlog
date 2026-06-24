using System.Collections.Concurrent;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Tests.TestInfrastructure;
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

        await leaderStarted.Task.WaitAsync(TimeSpan.FromSeconds(2));
        await Task.Delay(2500);
        bool standbyRan = await standby.TryRunAsLeaderAsync(
            "pow-load-reset-worker",
            _ =>
            {
                Interlocked.Increment(ref standbyExecutions);
                return Task.CompletedTask;
            });

        releaseLeader.SetResult(true);
        bool leaderRan = await leaderTask.WaitAsync(TimeSpan.FromSeconds(2));

        Assert.True(leaderRan);
        Assert.False(standbyRan);
        Assert.Equal(1, leaderExecutions);
        Assert.Equal(0, standbyExecutions);
    }

    [Theory]
    [InlineData("src/backend/Services/Background/ArticleMutationOutboxDispatcher.cs", "article-mutation-outbox-dispatcher")]
    [InlineData("src/backend/Services/Background/LogCleanupService.cs", "log-cleanup-worker")]
    [InlineData("src/backend/Services/Background/ScheduledPublishWorker.cs", "scheduled-publish-worker")]
    [InlineData("src/backend/Services/Background/UploadSessionCleanupWorker.cs", "upload-session-cleanup-worker")]
    [InlineData("src/backend/Services/Background/PublicAotBackfillWorker.cs", "public-aot-backfill-worker")]
    [InlineData("src/backend/Services/Background/CrawlerUpdateWorker.cs", "crawler-update-worker")]
    [InlineData("src/backend/Infrastructure/PowLoadResetWorker.cs", "pow-load-reset-worker")]
    [InlineData("src/backend/Services/VisitLog/ArticleViewProjectionRepairWorker.cs", "article-view-projection-repair-worker")]
    public void AffectedBackgroundWorkers_UseLeaderLease(string relativePath, string workerName)
    {
        string source = BackendTestPaths.ReadAllTextFromRoot(relativePath);

        Assert.Contains("IBackgroundWorkerLease", source, StringComparison.Ordinal);
        Assert.Contains($"TryRunAsLeaderAsync(\"{workerName}\"", source, StringComparison.Ordinal);
    }

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

        public Task<bool> TryAcquireLeaseAsync(CachePolicyId policyId, string identity, string value, TimeSpan ttl, CancellationToken cancellationToken = default)
        {
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
