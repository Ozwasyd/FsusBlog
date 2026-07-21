using System.Reflection;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Security;

using Microsoft.Extensions.Caching.Memory;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CachePortArchitectureTests
{
    [Fact]
    public void ProductionCacheConsumersUseNarrowPorts()
    {
        Assembly backend = typeof(CachePolicyId).Assembly;
        Assert.Null(backend.GetType("FsusBlog.Server.Infrastructure.Cache.IUnifiedCache"));
        Assert.Null(backend.GetType("FsusBlog.Server.Infrastructure.CoreBridge.Caching.ArticleCoreQueryCache"));

        FieldInfo governorCache = Assert.Single(
            typeof(AdaptivePowGovernor).GetFields(BindingFlags.Instance | BindingFlags.NonPublic),
            static field => field.FieldType == typeof(ICacheStringReader));
        Assert.Equal("_cache", governorCache.Name);

        ConstructorInfo coordinatorConstructor = Assert.Single(typeof(CacheMissCoordinator).GetConstructors());
        Assert.Contains(
            coordinatorConstructor.GetParameters(),
            static parameter => parameter.ParameterType == typeof(ICacheSingleFlightCoordinator));

        Type unifiedCache = Assert.IsAssignableFrom<Type>(
            backend.GetType("FsusBlog.Server.Infrastructure.Cache.UnifiedCache"));
        Assert.True(unifiedCache.IsNotPublic);
        Assert.True(unifiedCache.IsSealed);
        Assert.Contains(typeof(ICacheStringReader), unifiedCache.GetInterfaces());
        Assert.Contains(typeof(ICacheLeaseStore), unifiedCache.GetInterfaces());
    }

    [Fact]
    public void CacheModulesKeepSingleDirectionDependencies()
    {
        Type[] contracts =
        [
            typeof(ICacheTypedReader),
            typeof(ICacheRawReader),
            typeof(ICacheStringReader),
            typeof(ICacheRawWriter),
            typeof(ICacheStringWriter),
            typeof(ICacheCompareExchangeStore),
            typeof(ICacheCounterStore),
            typeof(ICacheOneTimeStore),
            typeof(ICacheOneTimeExchangeStore),
            typeof(ICacheInvalidationStore),
            typeof(ICacheLeaseStore),
            typeof(ICacheSingleFlightCoordinator),
            typeof(ICacheDiagnostics)
        ];
        Assert.All(contracts, static contract =>
        {
            Assert.True(contract.IsInterface);
            Assert.DoesNotContain(
                DescribePublicContract(contract),
                static type => IsFromNamespace(type, "StackExchange.Redis")
                    || IsFromNamespace(type, "Microsoft.Extensions.Caching"));
        });

        ConstructorInfo missCoordinator = Assert.Single(typeof(CacheMissCoordinator).GetConstructors());
        Assert.DoesNotContain(
            missCoordinator.GetParameters(),
            static parameter => IsFromNamespace(parameter.ParameterType, "StackExchange.Redis")
                || IsFromNamespace(parameter.ParameterType, "Microsoft.Extensions.Caching"));

        Assert.DoesNotContain(
            typeof(CacheTelemetry).GetFields(BindingFlags.Instance | BindingFlags.NonPublic),
            static field => IsFromNamespace(field.FieldType, "StackExchange.Redis"));

        Assembly backend = typeof(CachePolicyId).Assembly;
        Type distributed = Assert.IsAssignableFrom<Type>(
            backend.GetType("FsusBlog.Server.Infrastructure.Cache.SharedRedisDistributedCache"));
        Type[] distributedInterfaces = distributed.GetInterfaces();
        Assert.DoesNotContain(typeof(ICacheSingleFlightCoordinator), distributedInterfaces);
        Assert.DoesNotContain(distributedInterfaces, static type => type.Name == "IOwnedFrameCache");
    }

    [Fact]
    public async Task SingleFlightCancellationDoesNotPoisonNextReservation()
    {
        var coordinator = new CacheSingleFlightCoordinator(new FakeKeyResolver());
        await using IAsyncDisposable first = await coordinator.AcquireAsync(CachePolicyId.ArticleDetail, "42");
        using var cancellation = new CancellationTokenSource();
        Task<IAsyncDisposable> cancelledWait = coordinator.AcquireAsync(
            CachePolicyId.ArticleDetail,
            "42",
            cancellation.Token);
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => cancelledWait);
        await first.DisposeAsync();
        await using IAsyncDisposable next = await coordinator.AcquireAsync(CachePolicyId.ArticleDetail, "42");
    }

    [Fact]
    public void LocalStoreUsesFixedTimeProviderAndDefensivePayloadOwnership()
    {
        using var memoryCache = new MemoryCache(new MemoryCacheOptions());
        var time = new ManualTimeProvider();
        var store = new CacheLocalStore(memoryCache, time);
        var policy = new CachePolicy(
            CachePolicyId.ArticleDetail,
            "test",
            "article",
            TimeSpan.FromSeconds(5),
            TimeSpan.FromMinutes(1));
        CacheL1Key key = CacheL1Key.ForString("test", CachePolicyId.ArticleDetail, "42");
        byte[] source = [1, 2, 3];

        store.Set(policy, key, "fsus:test:article:42", source);
        source[0] = 9;

        Assert.True(store.TryGet(key, out byte[] cached));
        Assert.Equal(new byte[] { 1, 2, 3 }, cached);
        time.Advance(TimeSpan.FromSeconds(6));
        Assert.False(store.TryGet(key, out _));
    }

    private sealed class FakeKeyResolver : ICacheKeyResolver
    {
        public string BuildKey(CachePolicyId policyId, string identity, string? version = null)
            => $"test:{policyId}:{identity}:{version}";
    }

    private static IEnumerable<Type> DescribePublicContract(Type contract)
        => contract.GetMethods()
            .SelectMany(static method => method.GetParameters()
                .Select(static parameter => parameter.ParameterType)
                .Append(method.ReturnType))
            .SelectMany(FlattenType);

    private static IEnumerable<Type> FlattenType(Type type)
    {
        yield return type;
        if (type.HasElementType && type.GetElementType() is { } element)
        {
            foreach (Type nested in FlattenType(element))
            {
                yield return nested;
            }
        }

        foreach (Type argument in type.GetGenericArguments())
        {
            foreach (Type nested in FlattenType(argument))
            {
                yield return nested;
            }
        }
    }

    private static bool IsFromNamespace(Type type, string namespacePrefix)
        => type.Namespace?.StartsWith(namespacePrefix, StringComparison.Ordinal) == true;

    private sealed class ManualTimeProvider : TimeProvider
    {
        private long _timestamp;

        public override long TimestampFrequency => TimeSpan.TicksPerSecond;

        public override long GetTimestamp() => Volatile.Read(ref _timestamp);

        internal void Advance(TimeSpan elapsed)
            => Interlocked.Add(ref _timestamp, elapsed.Ticks);
    }
}
