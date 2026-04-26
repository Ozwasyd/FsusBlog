using FsusBlog.Server.Infrastructure.Cache;
using StackExchange.Redis;

namespace FsusBlog.Server.Tests;

public sealed class UnifiedCacheTests
{
    [Fact]
    public void BuildRegistryKeyForTests_UsesPerPolicyKeySpace()
    {
        string registryKey = UnifiedCache.BuildRegistryKeyForTests(CachePolicyId.PublicAotDocument);

        Assert.Equal("cache:registry:15", registryKey);
    }

    [Fact]
    public void FilterRegistryKeys_ReturnsOnlyMatchingPrefix()
    {
        RedisValue[] registryEntries =
        [
            "public:aot:v2:doc:1:home",
            RedisValue.Null,
            "public:aot:v2:doc:1:archive",
            "public:aot:v2:doc:2:article:1"
        ];

        IReadOnlyList<string> matches = UnifiedCache.FilterRegistryKeys("public:aot:v2:doc:1:", registryEntries);

        Assert.Equal(
            ["public:aot:v2:doc:1:home", "public:aot:v2:doc:1:archive"],
            matches);
    }

    [Fact]
    public void FilterRegistryKeys_EmptyRegistryLeavesCallerFreeToFallback()
    {
        IReadOnlyList<string> matches = UnifiedCache.FilterRegistryKeys("public:aot:v2:doc:1:", []);

        Assert.Empty(matches);
    }

    [Fact]
    public void ApplyDeterministicJitterForTests_SameKeyRemainsDeterministic()
    {
        TimeSpan first = UnifiedCache.ApplyDeterministicJitterForTests(TimeSpan.FromMinutes(10), 0.10d, "fsus:blog:article-list:1");
        TimeSpan second = UnifiedCache.ApplyDeterministicJitterForTests(TimeSpan.FromMinutes(10), 0.10d, "fsus:blog:article-list:1");

        Assert.Equal(first, second);
    }

    [Fact]
    public void ApplyDeterministicJitterForTests_StaysWithinConfiguredWindow()
    {
        TimeSpan ttl = UnifiedCache.ApplyDeterministicJitterForTests(TimeSpan.FromMinutes(10), 0.10d, "fsus:blog:article-list:42");

        Assert.InRange(ttl, TimeSpan.FromMinutes(9), TimeSpan.FromMinutes(11));
    }

    [Fact]
    public async Task SingleFlightEntry_RetireAfterReference_DoesNotDisposeSemaphoreUntilReleased()
    {
        var entry = new UnifiedCache.SingleFlightEntry();

        Assert.True(entry.TryAddReference());
        entry.MarkRetired();

        await entry.Semaphore.WaitAsync();
        entry.Semaphore.Release();

        entry.ReleaseReference();

        await Assert.ThrowsAsync<ObjectDisposedException>(async () => await entry.Semaphore.WaitAsync());
    }

    [Fact]
    public void SingleFlightEntry_RetiredEntryRejectsNewReferences()
    {
        var entry = new UnifiedCache.SingleFlightEntry();

        entry.MarkRetired();

        Assert.False(entry.TryAddReference());
    }
}
