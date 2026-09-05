using System.Collections.Concurrent;

using FsusBlog.Server.Infrastructure.Cache;

using Microsoft.Extensions.Logging.Abstractions;
namespace FsusBlog.Server.Tests;

public sealed class CacheMissCoordinatorTests
{
    [Fact]
    public async Task CoordinateAsync_AcquireThrows_StillRecordsLeaseWait()
    {
        CacheCoordinationObservation? captured = null;
        var cache = new CoordinatingCache
        {
            TryAcquireLeaseHandler = async (_, _, _, _, _) =>
            {
                captured = CacheCoordinationObservation.Current;
                await Task.Delay(10);
                throw new InvalidOperationException("acquire-failed");
            }
        };
        using var singleFlight = new CacheSingleFlightCoordinator(cache);
        var coordinator = new CacheMissCoordinator(singleFlight, cache, new CachePolicyRegistry(), NullLogger<CacheMissCoordinator>.Instance);
        await Assert.ThrowsAsync<InvalidOperationException>(() => coordinator.CoordinateAsync<string>(
            CachePolicyId.ArticleDetail, "acquire-failure",
            _ => Task.FromResult(new CacheReadResult<string>(false, default)),
            _ => throw new InvalidOperationException("unexpected-rebuild"), "acquire-failure"));
        Assert.NotNull(captured);
        Assert.True(captured.LeaseWait > TimeSpan.Zero);
        Assert.Equal(0, captured.RebuildCount);
        Assert.Equal("not-owned", captured.ReleaseOutcome);
        Assert.Equal(0, singleFlight.ActiveEntryCount);
    }

    [Fact]
    public async Task CoordinateAsync_IntegerIdentityHit_ReturnsBeforeStringCoordination()
    {
        var cache = new CoordinatingCache();
        var coordinator = new CacheMissCoordinator(cache, cache, new CachePolicyRegistry(), NullLogger<CacheMissCoordinator>.Instance);

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
        var coordinator = new CacheMissCoordinator(cache, cache, new CachePolicyRegistry(), NullLogger<CacheMissCoordinator>.Instance);
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
        var coordinator = new CacheMissCoordinator(cache, cache, new CachePolicyRegistry(), NullLogger<CacheMissCoordinator>.Instance);
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
                TimeSpan.FromMilliseconds(300), TimeSpan.FromSeconds(1)));

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
        var coordinator = new CacheMissCoordinator(cache, cache, new CachePolicyRegistry(), NullLogger<CacheMissCoordinator>.Instance);
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
        var coordinator = new CacheMissCoordinator(cache, cache, new CachePolicyRegistry(), NullLogger<CacheMissCoordinator>.Instance);
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
    public async Task CoordinateAsync_LeaseTimeout_FailsWithoutReacquiringOrRebuilding()
    {
        int leaseAttempts = 0;
        int reads = 0;
        var cache = new CoordinatingCache
        {
            TryAcquireLeaseHandler = (_, _, _, _, _) =>
            {
                Interlocked.Increment(ref leaseAttempts);
                return Task.FromResult(false);
            }
        };
        var coordinator = new CacheMissCoordinator(cache, cache, new CachePolicyRegistry(), NullLogger<CacheMissCoordinator>.Instance);

        CacheCoordinationException failure = await Assert.ThrowsAsync<CacheCoordinationException>(
            () => coordinator.CoordinateAsync<string>(
                CachePolicyId.ArticleDetail,
                "contended",
                _ =>
                {
                    reads++;
                    return Task.FromResult(new CacheReadResult<string>(false, default));
                },
                _ => throw new InvalidOperationException("A non-owner must never rebuild."),
                "article-detail",
                strategy: new CacheRebuildStrategy(TimeSpan.FromSeconds(1), TimeSpan.FromMilliseconds(10), TimeSpan.FromSeconds(4))));

        Assert.Equal("refill-timeout", failure.Reason);
        Assert.Equal(1, leaseAttempts);
        Assert.Equal(3, reads);
    }

    [Fact]
    public async Task CoordinateAsync_SingleFlightLimitsSameKeyConcurrency()
    {
        var cache = new CoordinatingCache
        {
            TryAcquireLeaseHandler = static (_, _, _, _, _) => Task.FromResult(true)
        };
        var coordinator = new CacheMissCoordinator(cache, cache, new CachePolicyRegistry(), NullLogger<CacheMissCoordinator>.Instance);
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

    [Theory]
    [InlineData("success")]
    [InlineData("rebuild-failure")]
    [InlineData("publish-failure")]
    [InlineData("cancel")]
    public async Task CoordinateAsync_OwnerExit_ReleasesLeaseAndRetiresEntry(string exit)
    {
        using var cancellation = new CancellationTokenSource();
        int reads = 0;
        int releases = 0;
        var cache = new CoordinatingCache
        {
            TryAcquireLeaseHandler = static (_, _, _, _, _) => Task.FromResult(true),
            ReleaseHandler = token =>
            {
                Assert.False(token.IsCancellationRequested);
                releases++;
                return Task.FromResult(true);
            }
        };
        using var singleFlight = new CacheSingleFlightCoordinator(cache);
        var coordinator = new CacheMissCoordinator(singleFlight, cache, new CachePolicyRegistry(), NullLogger<CacheMissCoordinator>.Instance);
        Task<string?> run = coordinator.CoordinateAsync<string>(
            CachePolicyId.ArticleDetail, "owner-exit",
            _ =>
            {
                reads++;
                return Task.FromResult(new CacheReadResult<string>(false, default));
            },
            token =>
            {
                Assert.Equal(2, reads);
                Assert.Equal(1, singleFlight.ActiveEntryCount);
                if (exit == "cancel")
                {
                    cancellation.Cancel();
                    token.ThrowIfCancellationRequested();
                }
                if (exit != "success")
                {
                    throw new InvalidOperationException(exit);
                }
                return Task.FromResult<string?>("built");
            }, "owner-exit", cancellation.Token);

        if (exit == "success")
        {
            Assert.Equal("built", await run);
        }
        else if (exit == "cancel")
        {
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => run);
        }
        else
        {
            await Assert.ThrowsAsync<InvalidOperationException>(() => run);
        }
        Assert.Equal(1, releases);
        Assert.Equal(0, singleFlight.ActiveEntryCount);
    }

    [Fact]
    public async Task CoordinateAsync_LostRenewal_CancelsRebuildBeforePublish()
    {
        bool published = false;
        int releases = 0;
        var cache = new CoordinatingCache
        {
            TryAcquireLeaseHandler = static (_, _, _, _, _) => Task.FromResult(true),
            RenewHandler = static _ => Task.FromResult(false),
            ReleaseHandler = _ =>
            {
                releases++;
                return Task.FromResult(false);
            }
        };
        using var singleFlight = new CacheSingleFlightCoordinator(cache);
        var coordinator = new CacheMissCoordinator(singleFlight, cache, new CachePolicyRegistry(), NullLogger<CacheMissCoordinator>.Instance);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => coordinator.CoordinateAsync<string>(
            CachePolicyId.ArticleDetail, "lost-renewal",
            _ => Task.FromResult(new CacheReadResult<string>(false, default)),
            async token =>
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, token);
                published = true;
                return "obsolete";
            }, "lost-renewal",
            strategy: new CacheRebuildStrategy(TimeSpan.FromMilliseconds(150), TimeSpan.Zero, TimeSpan.FromSeconds(1))));
        Assert.False(published);
        Assert.Equal(1, releases);
        Assert.Equal(0, singleFlight.ActiveEntryCount);
    }

    [Fact]
    public async Task SingleFlight_HighCardinality_RetiresEveryKey()
    {
        var cache = new CoordinatingCache();
        using var singleFlight = new CacheSingleFlightCoordinator(cache);
        for (int key = 0; key < 100_000; key++)
        {
            await using (await singleFlight.AcquireAsync(CachePolicyId.ArticleDetail, key.ToString(System.Globalization.CultureInfo.InvariantCulture)))
            {
                Assert.Equal(1, singleFlight.ActiveEntryCount);
            }
            Assert.Equal(0, singleFlight.ActiveEntryCount);
        }
    }

    [Fact]
    public async Task CoordinateAsync_SuccessfulRenewal_AllowsRebuildPastInitialTtl()
    {
        int renewals = 0;
        var cache = new CoordinatingCache
        {
            TryAcquireLeaseHandler = static (_, _, _, _, _) => Task.FromResult(true),
            RenewHandler = _ =>
            {
                Interlocked.Increment(ref renewals);
                return Task.FromResult(true);
            }
        };
        using var singleFlight = new CacheSingleFlightCoordinator(cache);
        var coordinator = new CacheMissCoordinator(singleFlight, cache, new CachePolicyRegistry(), NullLogger<CacheMissCoordinator>.Instance);
        string? result = await coordinator.CoordinateAsync<string>(
            CachePolicyId.ArticleDetail, "renewed",
            _ => Task.FromResult(new CacheReadResult<string>(false, default)),
            async token =>
            {
                await Task.Delay(TimeSpan.FromMilliseconds(750), token);
                return "built";
            }, "renewed",
            strategy: new CacheRebuildStrategy(TimeSpan.FromMilliseconds(500), TimeSpan.Zero, TimeSpan.FromSeconds(4)));
        Assert.Equal("built", result);
        Assert.True(renewals >= 2);
        Assert.Equal(0, singleFlight.ActiveEntryCount);
    }

    [Fact]
    public async Task CoordinateAsync_RenewalCancellationCallbackThrows_StillReleasesLease()
    {
        int releases = 0;
        var renewed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cache = new CoordinatingCache
        {
            TryAcquireLeaseHandler = static (_, _, _, _, _) => Task.FromResult(true),
            RenewHandler = async token =>
            {
                using CancellationTokenRegistration registration = token.Register(() => throw new InvalidOperationException("callback"));
                renewed.SetResult();
                await Task.Delay(Timeout.InfiniteTimeSpan, token);
                return true;
            },
            ReleaseHandler = _ =>
            {
                releases++;
                return Task.FromResult(true);
            }
        };
        using var singleFlight = new CacheSingleFlightCoordinator(cache);
        var coordinator = new CacheMissCoordinator(singleFlight, cache, new CachePolicyRegistry(), NullLogger<CacheMissCoordinator>.Instance);
        await Assert.ThrowsAnyAsync<Exception>(() => coordinator.CoordinateAsync<string>(
            CachePolicyId.ArticleDetail, "callback-failure",
            _ => Task.FromResult(new CacheReadResult<string>(false, default)),
            async _ =>
            {
                await renewed.Task;
                return "built";
            }, "callback-failure",
            strategy: new CacheRebuildStrategy(TimeSpan.FromMilliseconds(500), TimeSpan.Zero, TimeSpan.FromSeconds(4))));
        Assert.Equal(1, releases);
        Assert.Equal(0, singleFlight.ActiveEntryCount);
    }

    [Fact]
    public void PublicationScope_NestedDispose_RestoresParentAndRetiresChild()
    {
        Assert.Null(CacheRebuildLeaseScope.Current);
        var cache = new CoordinatingCache();
        using (var parent = new CacheRebuildLeaseScope(cache, CachePolicyId.ArticleDetail, "outer", "outer-value", CancellationToken.None))
        {
            CacheRebuildLeaseScope child;
            using (child = new CacheRebuildLeaseScope(cache, CachePolicyId.ArticleDetail, "inner", "inner-value", CancellationToken.None))
            {
                Assert.Same(child, CacheRebuildLeaseScope.Current);
                Assert.Same(parent, child.Parent);
            }
            Assert.Same(parent, CacheRebuildLeaseScope.Current);
            Assert.Throws<CacheCoordinationException>(() => child.EnsureActive());
            parent.EnsureActive();
        }
        Assert.Null(CacheRebuildLeaseScope.Current);
    }

    private sealed class CoordinatingCache : IUnifiedCache
    {
        private readonly ConcurrentDictionary<string, SemaphoreSlim> _locks = new(StringComparer.Ordinal);

        public Func<CachePolicyId, string, string, TimeSpan, CancellationToken, Task<bool>> TryAcquireLeaseHandler
        {
            get; init;
        }
            = static (_, _, _, _, _) => Task.FromResult(false);

        public Func<CancellationToken, Task<bool>> ReleaseHandler { get; init; } = static _ => Task.FromResult(true);

        public Func<CancellationToken, Task<bool>> RenewHandler { get; init; } = static _ => Task.FromResult(true);

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

        public Task<bool> TryRenewLeaseAsync(CachePolicyId policyId, string identity, string expectedValue, TimeSpan ttl, CancellationToken cancellationToken = default)
            => RenewHandler(cancellationToken);

        public Task<bool> TryReleaseLeaseAsync(CachePolicyId policyId, string identity, string expectedValue, CancellationToken cancellationToken = default)
            => ReleaseHandler(cancellationToken);

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
