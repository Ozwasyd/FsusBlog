using System.Buffers;

using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.Cache;

using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;

using StackExchange.Redis;
using StackExchange.Redis.Profiling;

namespace FsusBlog.Server.Tests;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
public sealed class CacheMissLeaseIntegrationTests(PublicHotDeliveryRedisFixture redis) : IClassFixture<PublicHotDeliveryRedisFixture>
{
    [Fact]
    public async Task ColdLeader_ProfilesTwoReadsOneAcquireAndAtomicPublishRelease()
    {
        await using ConnectionMultiplexer connection = await redis.ConnectAsync();
        using var memory = new MemoryCache(new MemoryCacheOptions());
        var policies = new CachePolicyRegistry();
        var scope = new DefaultRuntimeKeyScope();
        using var cache = new UnifiedCache(memory, connection, policies, scope, NullLogger<UnifiedCache>.Instance);
        using var singleFlight = new CacheSingleFlightCoordinator(new CacheKeyResolver(policies, scope, NullLogger<CacheKeyResolver>.Instance));
        var coordinator = new CacheMissCoordinator(singleFlight, cache, policies, NullLogger<CacheMissCoordinator>.Instance);
        string identity = $"eight-cache-profile-{Guid.NewGuid():N}";
        var profile = new ProfilingSession();
        connection.RegisterProfiler(() => profile);
        try
        {
            string? result = await coordinator.CoordinateAsync<string>(CachePolicyId.SystemPage, identity,
                async token =>
                {
                    string? value = await cache.GetStringAsync(CachePolicyId.SystemPage, identity, token);
                    return new CacheReadResult<string>(value is not null, value);
                },
                async token =>
                {
                    await cache.SetStringAsync(CachePolicyId.SystemPage, identity, "built", cancellationToken: token);
                    return "built";
                }, "profile");
            Assert.Equal("built", result);
            string[] commands = profile.FinishProfiling().Select(command => command.Command).ToArray();
            Assert.Equal(2, commands.Count(command => command == "GET"));
            Assert.Equal(1, commands.Count(command => command == "SET"));
            Assert.Equal(2, commands.Count(command => command is "EVAL" or "EVALSHA"));
            Assert.DoesNotContain("SADD", commands);
            Assert.False(await connection.GetDatabase().KeyExistsAsync(cache.BuildKey(CachePolicyId.SystemPage, $"__lease__:{identity}")));
        }
        finally
        {
            await cache.RemoveAsync(CachePolicyId.SystemPage, identity);
        }
    }

    [Theory]
    [InlineData("string")]
    [InlineData("negative")]
    [InlineData("owned")]
    public async Task ReplacedOwner_CannotPublishValueOrDeleteReplacementLease(string kind)
    {
        await using ConnectionMultiplexer connection = await redis.ConnectAsync();
        using var memory = new MemoryCache(new MemoryCacheOptions());
        using var cache = new UnifiedCache(memory, connection, new CachePolicyRegistry(), new DefaultRuntimeKeyScope(), NullLogger<UnifiedCache>.Instance);
        var resolver = new CacheKeyResolver(new CachePolicyRegistry(), new DefaultRuntimeKeyScope(), NullLogger<CacheKeyResolver>.Instance);
        using var singleFlight = new CacheSingleFlightCoordinator(resolver);
        var coordinator = new CacheMissCoordinator(singleFlight, cache, new CachePolicyRegistry(), NullLogger<CacheMissCoordinator>.Instance);
        string identity = $"eight-cache-fence-{Guid.NewGuid():N}";
        CachePolicyId policy = kind == "owned" ? CachePolicyId.ArticleListFrame : CachePolicyId.SystemPage;
        string leaseKey = cache.BuildKey(policy, $"__lease__:{identity}");
        string valueKey = cache.BuildKey(policy, identity);
        IDatabase db = connection.GetDatabase();
        try
        {
            CacheCoordinationException failure = await Assert.ThrowsAsync<CacheCoordinationException>(() => coordinator.CoordinateAsync<string>(
                policy, identity,
                _ => Task.FromResult(new CacheReadResult<string>(false, default)),
                async _ =>
                {
                    Assert.True(await db.StringSetAsync(leaseKey, "replacement-owner", TimeSpan.FromSeconds(30)));
                    if (kind == "negative")
                    {
                        await cache.SetNegativeAsync(CachePolicyId.SystemPage, identity, CancellationToken.None);
                    }
                    else if (kind == "owned")
                    {
                        using var writer = new AedsFrameBufferWriter(128);
                        writer.Write(new byte[8]);
                        writer.Seal(AedsFrameType.ArticleList);
                        await cache.SetOwnedFrameAsync(policy, identity, writer.DetachOwnedFrame(), cancellationToken: CancellationToken.None);
                    }
                    else
                    {
                        await cache.SetStringAsync(CachePolicyId.SystemPage, identity, "obsolete", cancellationToken: CancellationToken.None);
                    }
                    return "obsolete";
                }, "replaced-owner"));
            Assert.Equal("publication-lease-lost", failure.Reason);
            Assert.False(await db.KeyExistsAsync(valueKey));
            Assert.False((await cache.TryGetRawAsync(policy, identity)).Hit);
            Assert.Equal(0, cache.GetOwnedFrameResidencySnapshot().EntryCount);
            Assert.Equal("replacement-owner", (string?)await db.StringGetAsync(leaseKey));
            Assert.Equal(0, singleFlight.ActiveEntryCount);
        }
        finally
        {
            await db.KeyDeleteAsync([leaseKey, valueKey]);
        }
    }

    [Theory]
    [InlineData(100)]
    [InlineData(1000)]
    public async Task TwoCoordinators_ColdKey_HaveOneBuilderAndReleaseLease(int concurrency)
    {
        await using ConnectionMultiplexer connection = await redis.ConnectAsync();
        using var memoryA = new MemoryCache(new MemoryCacheOptions());
        using var memoryB = new MemoryCache(new MemoryCacheOptions());
        var policies = new CachePolicyRegistry();
        var scope = new DefaultRuntimeKeyScope();
        using var cacheA = new UnifiedCache(memoryA, connection, policies, scope, NullLogger<UnifiedCache>.Instance);
        using var cacheB = new UnifiedCache(memoryB, connection, policies, scope, NullLogger<UnifiedCache>.Instance);
        var resolver = new CacheKeyResolver(policies, scope, NullLogger<CacheKeyResolver>.Instance);
        using var singleA = new CacheSingleFlightCoordinator(resolver);
        using var singleB = new CacheSingleFlightCoordinator(resolver);
        var coordinatorA = new CacheMissCoordinator(singleA, cacheA, policies, NullLogger<CacheMissCoordinator>.Instance);
        var coordinatorB = new CacheMissCoordinator(singleB, cacheB, policies, NullLogger<CacheMissCoordinator>.Instance);
        string identity = $"eight-cache-concurrency-{Guid.NewGuid():N}";
        string leaseKey = cacheA.BuildKey(CachePolicyId.SystemPage, $"__lease__:{identity}");
        string valueKey = cacheA.BuildKey(CachePolicyId.SystemPage, identity);
        var builderStarted = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var releaseBuilder = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int builds = 0;
        try
        {
            Task<string?>[] requests = Enumerable.Range(0, concurrency).Select(index =>
            {
                UnifiedCache cache = index % 2 == 0 ? cacheA : cacheB;
                CacheMissCoordinator coordinator = index % 2 == 0 ? coordinatorA : coordinatorB;
                return coordinator.CoordinateAsync<string>(CachePolicyId.SystemPage, identity,
                    async token =>
                    {
                        string? value = await cache.GetStringAsync(CachePolicyId.SystemPage, identity, token);
                        return new CacheReadResult<string>(value is not null, value);
                    },
                    async token =>
                    {
                        Interlocked.Increment(ref builds);
                        builderStarted.TrySetResult();
                        await releaseBuilder.Task.WaitAsync(token);
                        await cache.SetStringAsync(CachePolicyId.SystemPage, identity, "built", cancellationToken: token);
                        return "built";
                    }, "two-coordinators",
                    strategy: new CacheRebuildStrategy(TimeSpan.FromSeconds(5), TimeSpan.FromSeconds(1), TimeSpan.FromSeconds(10)));
            }).ToArray();
            await builderStarted.Task.WaitAsync(TimeSpan.FromSeconds(10));
            releaseBuilder.SetResult();
            string?[] values = await Task.WhenAll(requests).WaitAsync(TimeSpan.FromSeconds(20));
            Assert.All(values, value => Assert.Equal("built", value));
            Assert.Equal(1, builds);
            Assert.False(await connection.GetDatabase().KeyExistsAsync(leaseKey));
            Assert.Equal(0, singleA.ActiveEntryCount);
            Assert.Equal(0, singleB.ActiveEntryCount);
        }
        finally
        {
            releaseBuilder.TrySetResult();
            await connection.GetDatabase().KeyDeleteAsync([leaseKey, valueKey]);
        }
    }

    [Fact]
    public async Task RenewalLosesAuthority_IgnoringCancellationCannotInstallL1OrL2()
    {
        await using ConnectionMultiplexer connection = await redis.ConnectAsync();
        using var memory = new MemoryCache(new MemoryCacheOptions());
        var policies = new CachePolicyRegistry();
        var scope = new DefaultRuntimeKeyScope();
        using var cache = new UnifiedCache(memory, connection, policies, scope, NullLogger<UnifiedCache>.Instance);
        using var singleFlight = new CacheSingleFlightCoordinator(new CacheKeyResolver(policies, scope, NullLogger<CacheKeyResolver>.Instance));
        var coordinator = new CacheMissCoordinator(singleFlight, cache, policies, NullLogger<CacheMissCoordinator>.Instance);
        string identity = $"eight-cache-renew-loss-{Guid.NewGuid():N}";
        string leaseKey = cache.BuildKey(CachePolicyId.SystemPage, $"__lease__:{identity}");
        IDatabase db = connection.GetDatabase();
        try
        {
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => coordinator.CoordinateAsync<string>(CachePolicyId.SystemPage, identity,
                _ => Task.FromResult(new CacheReadResult<string>(false, default)),
                async token =>
                {
                    await db.StringSetAsync(leaseKey, "new-owner", TimeSpan.FromSeconds(30));
                    var lost = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
                    using CancellationTokenRegistration registration = token.Register(() => lost.TrySetResult());
                    await lost.Task.WaitAsync(TimeSpan.FromSeconds(3));
                    await cache.SetStringAsync(CachePolicyId.SystemPage, identity, "obsolete", cancellationToken: CancellationToken.None);
                    return "obsolete";
                }, "renew-loss",
                strategy: new CacheRebuildStrategy(TimeSpan.FromMilliseconds(500), TimeSpan.Zero, TimeSpan.FromSeconds(5))));
            Assert.False(await db.KeyExistsAsync(cache.BuildKey(CachePolicyId.SystemPage, identity)));
            Assert.False((await cache.TryGetRawAsync(CachePolicyId.SystemPage, identity)).Hit);
            Assert.Equal("new-owner", (string?)await db.StringGetAsync(leaseKey));
        }
        finally
        {
            await db.KeyDeleteAsync(leaseKey);
            await cache.RemoveAsync(CachePolicyId.SystemPage, identity);
        }
    }

    [Fact]
    public async Task FencedPublication_PreservesTtlAndRegistryMembership()
    {
        await using ConnectionMultiplexer connection = await redis.ConnectAsync();
        using var memory = new MemoryCache(new MemoryCacheOptions());
        var policies = new CachePolicyRegistry();
        var scope = new DefaultRuntimeKeyScope();
        using var cache = new UnifiedCache(memory, connection, policies, scope, NullLogger<UnifiedCache>.Instance);
        using var singleFlight = new CacheSingleFlightCoordinator(new CacheKeyResolver(policies, scope, NullLogger<CacheKeyResolver>.Instance));
        var coordinator = new CacheMissCoordinator(singleFlight, cache, policies, NullLogger<CacheMissCoordinator>.Instance);
        string identity = $"eight-cache-registry-{Guid.NewGuid():N}";
        const CachePolicyId Policy = CachePolicyId.ArticleHotFrame;
        string valueKey = cache.BuildKey(Policy, identity);
        string registryKey = UnifiedCache.BuildRegistryKeyForTests(Policy);
        IDatabase db = connection.GetDatabase();
        try
        {
            await coordinator.CoordinateAsync<string>(Policy, identity,
                _ => Task.FromResult(new CacheReadResult<string>(false, default)),
                async token =>
                {
                    await cache.SetStringAsync(Policy, identity, "built", TimeSpan.FromSeconds(30), token);
                    return "built";
                }, "registry");
            Assert.Equal("built", (string?)await db.StringGetAsync(valueKey));
            Assert.True(await db.SetContainsAsync(registryKey, valueKey));
            TimeSpan? ttl = await db.KeyTimeToLiveAsync(valueKey);
            Assert.NotNull(ttl);
            Assert.InRange(ttl.Value.TotalSeconds, 20, 33);
            Assert.Null(await db.KeyTimeToLiveAsync(registryKey));
        }
        finally
        {
            await cache.RemoveAsync(Policy, identity);
        }
        Assert.False(await db.SetContainsAsync(registryKey, valueKey));
    }

    [Fact]
    public async Task NestedPublication_ChecksParentLeaseAndRejectsDifferentStore()
    {
        await using ConnectionMultiplexer connection = await redis.ConnectAsync();
        using var memory = new MemoryCache(new MemoryCacheOptions());
        using var otherMemory = new MemoryCache(new MemoryCacheOptions());
        var policies = new CachePolicyRegistry();
        var scope = new DefaultRuntimeKeyScope();
        using var cache = new UnifiedCache(memory, connection, policies, scope, NullLogger<UnifiedCache>.Instance);
        using var other = new UnifiedCache(otherMemory, connection, policies, scope, NullLogger<UnifiedCache>.Instance);
        string identity = $"eight-cache-nested-{Guid.NewGuid():N}";
        string leaseKey = cache.BuildKey(CachePolicyId.SystemPage, identity);
        string childKey = cache.BuildKey(CachePolicyId.SystemPage, $"{identity}-child");
        IDatabase db = connection.GetDatabase();
        await db.StringSetAsync(leaseKey, "replaced", TimeSpan.FromSeconds(30));
        await db.StringSetAsync(childKey, "child", TimeSpan.FromSeconds(30));
        try
        {
            using var parent = new CacheRebuildLeaseScope(cache, CachePolicyId.SystemPage, identity, "old", CancellationToken.None);
            using (var child = new CacheRebuildLeaseScope(cache, CachePolicyId.SystemPage, $"{identity}-child", "child", CancellationToken.None))
            {
                CacheCoordinationException lost = await Assert.ThrowsAsync<CacheCoordinationException>(() => cache.SetStringAsync(CachePolicyId.SystemPage, $"{identity}-value", "obsolete"));
                Assert.Equal("publication-lease-lost", lost.Reason);
            }
            Assert.Same(parent, CacheRebuildLeaseScope.Current);
            CacheCoordinationException mismatch = await Assert.ThrowsAsync<CacheCoordinationException>(() => other.SetStringAsync(CachePolicyId.SystemPage, $"{identity}-value", "obsolete"));
            Assert.Equal("publication-store-mismatch", mismatch.Reason);
            Assert.False((await cache.TryGetRawAsync(CachePolicyId.SystemPage, $"{identity}-value")).Hit);
            Assert.False((await other.TryGetRawAsync(CachePolicyId.SystemPage, $"{identity}-value")).Hit);
        }
        finally
        {
            await db.KeyDeleteAsync([leaseKey, childKey]);
        }
    }
}
