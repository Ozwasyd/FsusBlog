using System.Collections.Concurrent;

using Microsoft.Extensions.Logging.Abstractions;

using FsusBlog.Server.Infrastructure.Cache;
namespace FsusBlog.Server.Tests;

public sealed class CacheMissCoordinatorTests
{
    [Fact]
    public async Task CoordinateAsync_IntegerIdentityHit_ReturnsBeforeStringCoordination()
    {
        var cache = new CoordinatingCache();
        var coordinator = new CacheMissCoordinator(cache, new CachePolicyRegistry(), NullLogger<CacheMissCoordinator>.Instance);

        string? value = await coordinator.CoordinateAsync(
            CachePolicyId.ArticleDetail,
            42,
            static _ => Task.FromResult(new CacheReadResult<string>(true, "cached")),
            static _ => throw new InvalidOperationException("A cache hit must not rebuild."),
            "article-detail");

        Assert.Equal("cached", value);
    }

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

    [Fact]
    public async Task CoordinateAsync_LeaseTimeout_ReelectsSingleFallbackRebuilder()
    {
        const int CallersCount = 16;
        int leaseAttempts = 0;
        var cache = new CoordinatingCache
        {
            DisableLocalSingleFlight = true,
            TryAcquireLeaseHandler = (_, _, _, _, _) =>
            {
                int attempt = Interlocked.Increment(ref leaseAttempts);
                return Task.FromResult(attempt == CallersCount + 1);
            }
        };
        var coordinator = new CacheMissCoordinator(cache, new CachePolicyRegistry(), NullLogger<CacheMissCoordinator>.Instance);
        string? current = null;
        int rebuildCount = 0;
        var strategy = new CacheRebuildStrategy(
            TimeSpan.FromMilliseconds(100),
            TimeSpan.FromMilliseconds(40),
            TimeSpan.FromMilliseconds(5));

        Task<string?>[] callers = Enumerable.Range(0, CallersCount)
            .Select(_ => coordinator.CoordinateAsync(
                CachePolicyId.ArticleDetail,
                "timeout-hot:42",
                _ => Task.FromResult(current is null
                    ? new CacheReadResult<string>(false, default)
                    : new CacheReadResult<string>(true, current)),
                async _ =>
                {
                    Interlocked.Increment(ref rebuildCount);
                    await Task.Delay(25);
                    current = "fallback-rebuilt";
                    return current;
                },
                "article-detail",
                strategy: strategy))
            .ToArray();

        string?[] results = await Task.WhenAll(callers).WaitAsync(TimeSpan.FromSeconds(10));

        Assert.All(results, result => Assert.Equal("fallback-rebuilt", result));
        Assert.Equal(1, rebuildCount);
        Assert.True(leaseAttempts > CallersCount);
    }

    [Fact]
    public async Task CoordinateAsync_RebuildSemaphoreLimitsSameKeyConcurrency()
    {
        var cache = new CoordinatingCache
        {
            DisableLocalSingleFlight = true,
            TryAcquireLeaseHandler = static (_, _, _, _, _) => Task.FromResult(true)
        };
        var coordinator = new CacheMissCoordinator(cache, new CachePolicyRegistry(), NullLogger<CacheMissCoordinator>.Instance);
        string? current = null;
        int activeRebuilds = 0;
        int maxActiveRebuilds = 0;
        int rebuildCount = 0;

        Task<string?>[] callers = Enumerable.Range(0, 24)
            .Select(_ => coordinator.CoordinateAsync(
                CachePolicyId.ArticleDetail,
                "semaphore-hot:42",
                _ => Task.FromResult(current is null
                    ? new CacheReadResult<string>(false, default)
                    : new CacheReadResult<string>(true, current)),
                async _ =>
                {
                    int active = Interlocked.Increment(ref activeRebuilds);
                    int observed;
                    while (active > (observed = Volatile.Read(ref maxActiveRebuilds)))
                    {
                        Interlocked.CompareExchange(ref maxActiveRebuilds, active, observed);
                    }

                    Interlocked.Increment(ref rebuildCount);
                    await Task.Delay(40);
                    current = "semaphore-rebuilt";
                    Interlocked.Decrement(ref activeRebuilds);
                    return current;
                },
                "article-detail"))
            .ToArray();

        string?[] results = await Task.WhenAll(callers).WaitAsync(TimeSpan.FromSeconds(10));

        Assert.All(results, result => Assert.Equal("semaphore-rebuilt", result));
        Assert.Equal(1, rebuildCount);
        Assert.Equal(1, maxActiveRebuilds);
    }

    private sealed class CoordinatingCache : IUnifiedCache
    {
        private readonly ConcurrentDictionary<string, SemaphoreSlim> _locks = new(StringComparer.Ordinal);

        public Func<CachePolicyId, string, string, TimeSpan, CancellationToken, Task<bool>> TryAcquireLeaseHandler
        {
            get; init;
        }
            = static (_, _, _, _, _) => Task.FromResult(false);

        public bool DisableLocalSingleFlight
        {
            get; init;
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

        public Task<bool> TryAcquireLeaseAsync(CachePolicyId policyId, string identity, string value, TimeSpan ttl, CancellationToken cancellationToken = default)
            => TryAcquireLeaseHandler(policyId, identity, value, ttl, cancellationToken);

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

        public async Task<IAsyncDisposable> AcquireSingleFlightAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
        {
            if (DisableLocalSingleFlight)
            {
                return NoopAsyncDisposable.Instance;
            }

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

        private sealed class NoopAsyncDisposable : IAsyncDisposable
        {
            public static readonly NoopAsyncDisposable Instance = new();

            public ValueTask DisposeAsync() => ValueTask.CompletedTask;
        }
    }
}
