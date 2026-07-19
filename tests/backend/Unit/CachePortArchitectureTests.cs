using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.Caching.Memory;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CachePortArchitectureTests
{
    [Fact]
    public void ProductionCacheConsumersUseNarrowPorts()
    {
        string backendRoot = BackendTestPaths.FromRoot("src/backend");
        string[] files = Directory.GetFiles(backendRoot, "*.cs", SearchOption.AllDirectories);
        var violations = files
            .Select(path => new { Path = path, Source = File.ReadAllText(path) })
            .Where(static file => file.Source.Contains("IUnifiedCache", StringComparison.Ordinal))
            .Select(file => Path.GetRelativePath(BackendTestPaths.RepositoryRoot, file.Path))
            .ToArray();

        Assert.Empty(violations);
        Assert.False(File.Exists(Path.Combine(backendRoot, "Infrastructure/Cache/IUnifiedCache.cs")));

        Assert.Contains(
            "ICacheStringReader _cache",
            File.ReadAllText(Path.Combine(backendRoot, "Infrastructure/Security/AdaptivePowGovernor.cs")),
            StringComparison.Ordinal);
        Assert.Contains(
            "ICacheSingleFlightCoordinator singleFlightCoordinator",
            File.ReadAllText(Path.Combine(backendRoot, "Infrastructure/Cache/CacheMissCoordinator.cs")),
            StringComparison.Ordinal);
        Assert.False(File.Exists(Path.Combine(
            backendRoot,
            "Infrastructure/CoreBridge/Caching/ArticleCoreQueryCache.cs")));
        Assert.Contains(
            "internal sealed class UnifiedCache",
            File.ReadAllText(Path.Combine(backendRoot, "Infrastructure/Cache/RedisCacheStorage.cs")),
            StringComparison.Ordinal);
    }

    [Fact]
    public void CacheModulesKeepSingleDirectionDependencies()
    {
        string cacheRoot = BackendTestPaths.FromRoot("src/backend/Infrastructure/Cache");
        string contracts = File.ReadAllText(Path.Combine(cacheRoot, "CachePorts.cs"));
        string local = File.ReadAllText(Path.Combine(cacheRoot, "CacheLocalStore.cs"));
        string keys = File.ReadAllText(Path.Combine(cacheRoot, "CacheKeyResolver.cs"));
        string coordination = File.ReadAllText(Path.Combine(cacheRoot, "CacheSingleFlightCoordinator.cs"));
        string distributed = File.ReadAllText(Path.Combine(cacheRoot, "SharedRedisDistributedCache.cs"));
        string telemetry = File.ReadAllText(Path.Combine(cacheRoot, "CacheTelemetry.cs"));

        Assert.DoesNotContain("StackExchange.Redis", contracts, StringComparison.Ordinal);
        Assert.DoesNotContain("Microsoft.Extensions.Caching", contracts, StringComparison.Ordinal);
        Assert.DoesNotContain("StackExchange.Redis", local, StringComparison.Ordinal);
        Assert.DoesNotContain("UnifiedCache", keys, StringComparison.Ordinal);
        Assert.DoesNotContain("StackExchange.Redis", coordination, StringComparison.Ordinal);
        Assert.DoesNotContain("IMemoryCache", coordination, StringComparison.Ordinal);
        Assert.DoesNotContain("UnifiedCache", distributed, StringComparison.Ordinal);
        Assert.DoesNotContain("IOwnedFrameCache", distributed, StringComparison.Ordinal);
        Assert.DoesNotContain("ICacheSingleFlightCoordinator", distributed, StringComparison.Ordinal);
        Assert.DoesNotContain("StackExchange.Redis", telemetry, StringComparison.Ordinal);
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

    private sealed class ManualTimeProvider : TimeProvider
    {
        private long _timestamp;

        public override long TimestampFrequency => TimeSpan.TicksPerSecond;

        public override long GetTimestamp() => Volatile.Read(ref _timestamp);

        internal void Advance(TimeSpan elapsed)
            => Interlocked.Add(ref _timestamp, elapsed.Ticks);
    }
}
