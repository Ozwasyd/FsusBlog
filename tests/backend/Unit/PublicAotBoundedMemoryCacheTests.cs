using FsusBlog.Server.Infrastructure.PublicAot;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicAotBoundedMemoryCacheTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-07-15T12:00:00Z");

    [Fact]
    public void Limits_ResolveFromVisibleMachineMemoryWhenConfigurationUsesAutoValues()
    {
        PublicAotMemoryCacheLimits limits = PublicAotMemoryCacheLimits.Resolve(
            new PublicAotFileShellCacheOptions(),
            availableMemoryBytes: 8L * 1024 * 1024 * 1024);

        Assert.Equal(128L * 1024 * 1024, limits.MaxBytes);
        Assert.Equal(2048, limits.MaxEntries);
        Assert.Equal(TimeSpan.FromMinutes(40), limits.EntryDeadline);
    }

    [Fact]
    public void CapacityLimit_EvictsLeastRecentlyUsedEntryAndAccountsResidentBytes()
    {
        var clock = new MutableTimeProvider(Now);
        var cache = new PublicAotBoundedMemoryCache(
            new PublicAotMemoryCacheLimits(1_000_000, 250, 2, TimeSpan.FromMinutes(10)),
            clock);
        cache["a"] = Entry("a", 100, Now.AddMinutes(10));
        cache["b"] = Entry("b", 100, Now.AddMinutes(10));
        Assert.True(cache.TryGetValue("a", out _));

        cache["c"] = Entry("c", 100, Now.AddMinutes(10));

        Assert.True(cache.TryGetValue("a", out _));
        Assert.False(cache.TryGetValue("b", out _));
        Assert.True(cache.TryGetValue("c", out _));
        PublicAotMemoryCacheSnapshot snapshot = cache.Snapshot();
        Assert.Equal(2, snapshot.EntryCount);
        Assert.Equal(200, snapshot.ResidentBytes);
        Assert.Equal(1, snapshot.CapacityEvictionCount);
    }

    [Fact]
    public void DeadlineLimit_EvictsExpiredEntryWithoutWaitingForArtifactExpiry()
    {
        var clock = new MutableTimeProvider(Now);
        var cache = new PublicAotBoundedMemoryCache(
            new PublicAotMemoryCacheLimits(1_000_000, 10_000, 10, TimeSpan.FromMinutes(1)),
            clock);
        cache["a"] = Entry("a", 100, Now.AddHours(1));

        clock.Advance(TimeSpan.FromMinutes(2));

        Assert.False(cache.TryGetValue("a", out _));
        PublicAotMemoryCacheSnapshot snapshot = cache.Snapshot();
        Assert.Equal(0, snapshot.EntryCount);
        Assert.Equal(0, snapshot.ResidentBytes);
        Assert.Equal(1, snapshot.DeadlineEvictionCount);
    }

    [Fact]
    public void OversizedEntry_IsRejectedByEvictionInsteadOfExceedingHardBytesLimit()
    {
        var cache = new PublicAotBoundedMemoryCache(
            new PublicAotMemoryCacheLimits(1_000_000, 99, 10, TimeSpan.FromMinutes(10)),
            new MutableTimeProvider(Now));

        cache["large"] = Entry("large", 100, Now.AddMinutes(10));

        PublicAotMemoryCacheSnapshot snapshot = cache.Snapshot();
        Assert.Equal(0, snapshot.EntryCount);
        Assert.Equal(0, snapshot.ResidentBytes);
        Assert.Equal(1, snapshot.CapacityEvictionCount);
    }

    private static PublicAotMemoryCacheEntry Entry(
        string cacheKey,
        long sizeBytes,
        DateTimeOffset deadline)
        => new(
            new PublicAotCacheEntry
            {
                CacheKey = cacheKey,
                RouteKey = cacheKey,
                ExpiresAtUtc = Now.AddHours(1)
            },
            Now.AddHours(1),
            string.Empty,
            string.Empty,
            0,
            sizeBytes,
            deadline);

    private sealed class MutableTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        private DateTimeOffset _utcNow = utcNow;

        public override DateTimeOffset GetUtcNow() => _utcNow;

        internal void Advance(TimeSpan delta) => _utcNow += delta;
    }
}
