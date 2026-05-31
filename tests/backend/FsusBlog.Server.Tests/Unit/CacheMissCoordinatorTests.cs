using System.Collections.Concurrent;
using FsusBlog.Server.Infrastructure.Cache;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests;

public sealed class CacheMissCoordinatorTests
{
    [Fact]
    public async Task CoordinateAsync_LeaseAcquired_RebuildsOnce()
    {
        var cache = new CoordinatingCache
        {
            TryAcquireLeaseHandler = static (_, _, _, _, _) => Task.FromResult(true)
        };
        var coordinator = new CacheMissCoordinator(cache, new CachePolicyRegistry(), NullLogger<CacheMissCoordinator>.Instance);
        int rebuildCount = 0;

        string? value = await coordinator.CoordinateAsync(
            CachePolicyId.SystemSeo,
            "main",
            static _ => Task.FromResult(new CacheReadResult<string>(false, default)),
            _ =>
            {
                Interlocked.Increment(ref rebuildCount);
                return Task.FromResult<string?>("rebuilt");
            },
            "system-seo");

        Assert.Equal("rebuilt", value);
        Assert.Equal(1, rebuildCount);
    }

    [Fact]
    public async Task CoordinateAsync_LeaseMiss_WaitsForNegativeCacheRefill()
    {
        var cache = new CoordinatingCache
        {
            TryAcquireLeaseHandler = static (_, _, _, _, _) => Task.FromResult(false)
        };
        var coordinator = new CacheMissCoordinator(cache, new CachePolicyRegistry(), NullLogger<CacheMissCoordinator>.Instance);
        int reads = 0;
        int rebuildCount = 0;

        string? value = await coordinator.CoordinateAsync<string?>(
            CachePolicyId.SystemPage,
            "missing",
            _ =>
            {
                int currentRead = Interlocked.Increment(ref reads);
                return Task.FromResult(currentRead >= 3
                    ? new CacheReadResult<string?>(true, default)
                    : new CacheReadResult<string?>(false, default));
            },
            _ =>
            {
                Interlocked.Increment(ref rebuildCount);
                return Task.FromResult<string?>(default);
            },
            "system-page",
            strategy: new CacheRebuildStrategy(
                TimeSpan.FromMilliseconds(200),
                TimeSpan.FromMilliseconds(300),
                TimeSpan.FromMilliseconds(20)));

        Assert.Null(value);
        Assert.Equal(0, rebuildCount);
    }

    [Fact]
    public async Task CoordinateAsync_LocalSingleFlight_AllowsOnlyOneLeaderRebuild()
    {
        var cache = new CoordinatingCache
        {
            TryAcquireLeaseHandler = static (_, _, _, _, _) => Task.FromResult(true)
        };
        var coordinator = new CacheMissCoordinator(cache, new CachePolicyRegistry(), NullLogger<CacheMissCoordinator>.Instance);
        var gate = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        var entered = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        string? current = null;
        int rebuildCount = 0;

        Task<string?> first = coordinator.CoordinateAsync(
            CachePolicyId.AdminStats,
            "main",
            _ => Task.FromResult(current is null
                ? new CacheReadResult<string>(false, default)
                : new CacheReadResult<string>(true, current)),
            async _ =>
            {
                Interlocked.Increment(ref rebuildCount);
                current = "ready";
                entered.SetResult(true);
                await gate.Task;
                return current;
            },
            "admin-stats");

        await entered.Task;

        Task<string?> second = coordinator.CoordinateAsync(
            CachePolicyId.AdminStats,
            "main",
            _ => Task.FromResult(current is null
                ? new CacheReadResult<string>(false, default)
                : new CacheReadResult<string>(true, current)),
            _ =>
            {
                Interlocked.Increment(ref rebuildCount);
                return Task.FromResult(current);
            },
            "admin-stats");

        gate.SetResult(true);
        string?[] results = await Task.WhenAll(first, second);

        Assert.Equal("ready", results[0]);
        Assert.Equal("ready", results[1]);
        Assert.Equal(1, rebuildCount);
    }

    [Fact]
    public async Task CoordinateAsync_ManyConcurrentMisses_CoalescesHotKeyRebuild()
    {
        var cache = new CoordinatingCache
        {
            TryAcquireLeaseHandler = static (_, _, _, _, _) => Task.FromResult(true)
        };
        var coordinator = new CacheMissCoordinator(cache, new CachePolicyRegistry(), NullLogger<CacheMissCoordinator>.Instance);
        var releaseRebuild = new TaskCompletionSource<bool>(TaskCreationOptions.RunContinuationsAsynchronously);
        string? current = null;
        int rebuildCount = 0;
        int readCount = 0;

        Task<string?>[] callers = Enumerable.Range(0, 64)
            .Select(_ => coordinator.CoordinateAsync(
                CachePolicyId.ArticleDetail,
                "hot:42",
                _ =>
                {
                    Interlocked.Increment(ref readCount);
                    return Task.FromResult(current is null
                        ? new CacheReadResult<string>(false, default)
                        : new CacheReadResult<string>(true, current));
                },
                async _ =>
                {
                    Interlocked.Increment(ref rebuildCount);
                    await releaseRebuild.Task;
                    current = "rebuilt-hot-article";
                    return current;
                },
                "article-detail"))
            .ToArray();

        await Task.Yield();
        releaseRebuild.SetResult(true);

        string?[] results = await Task.WhenAll(callers);

        Assert.All(results, result => Assert.Equal("rebuilt-hot-article", result));
        Assert.Equal(1, rebuildCount);
        Assert.True(readCount >= callers.Length);
    }

    private sealed class CoordinatingCache : IUnifiedCache
    {
        private readonly ConcurrentDictionary<string, SemaphoreSlim> _locks = new(StringComparer.Ordinal);

        public Func<CachePolicyId, string, string, TimeSpan, CancellationToken, Task<bool>> TryAcquireLeaseHandler { get; init; }
            = static (_, _, _, _, _) => Task.FromResult(false);

        public Task<CacheReadResult<T>> TryGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<CacheReadResult<byte[]>> TryGetRawAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
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

        public Task<bool> TryAcquireLeaseAsync(CachePolicyId policyId, string identity, string value, TimeSpan ttl, CancellationToken cancellationToken = default)
            => TryAcquireLeaseHandler(policyId, identity, value, ttl, cancellationToken);

        public Task<bool> ConsumeOnceAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task RemoveAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task RemoveByPrefixAsync(CachePolicyId policyId, string identityPrefix, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public async Task<IAsyncDisposable> AcquireSingleFlightAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
        {
            string key = $"{(int)policyId}:{identity}";
            SemaphoreSlim semaphore = _locks.GetOrAdd(key, static _ => new SemaphoreSlim(1, 1));
            await semaphore.WaitAsync(cancellationToken);
            return new AsyncReleaser(semaphore);
        }

        public string BuildKey(CachePolicyId policyId, string identity, string? version = null)
            => $"{(int)policyId}:{identity}:{version}";

        private sealed class AsyncReleaser(SemaphoreSlim semaphore) : IAsyncDisposable
        {
            public ValueTask DisposeAsync()
            {
                semaphore.Release();
                return ValueTask.CompletedTask;
            }
        }
    }
}
