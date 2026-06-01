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
    public void RemoveByPrefix_SourceUsesPagedSetScanInsteadOfSetMembers()
    {
        string source = File.ReadAllText(Path.Combine(FindRepoRoot(), "src/backend/Infrastructure/Cache/IUnifiedCache.cs"));

        Assert.Contains(".SetScan(", source, StringComparison.Ordinal);
        Assert.DoesNotContain("SetMembersAsync", source, StringComparison.Ordinal);
    }

    [Fact]
    public void CopyRawBytesForTests_ReturnsCallerOwnedCopy()
    {
        byte[] cached = [1, 2, 3];

        byte[] returned = UnifiedCache.CopyRawBytesForTests(cached);
        returned[0] = 9;

        Assert.Equal(new byte[] { 1, 2, 3 }, cached);
        Assert.Equal(new byte[] { 9, 2, 3 }, returned);
        Assert.NotSame(cached, returned);
    }

    [Fact]
    public void BorrowRawBytesReadonlyForTests_ReusesImmutableCacheBuffer()
    {
        byte[] cached = [1, 2, 3];

        ReadOnlyMemory<byte> returned = UnifiedCache.BorrowRawBytesReadonlyForTests(cached);

        Assert.Equal(new byte[] { 1, 2, 3 }, returned.ToArray());
        Assert.True(System.Runtime.InteropServices.MemoryMarshal.TryGetArray(returned, out ArraySegment<byte> segment));
        Assert.Same(cached, segment.Array);
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

    private static string FindRepoRoot()
    {
        DirectoryInfo? current = new(AppContext.BaseDirectory);
        while (current is not null)
        {
            if (File.Exists(Path.Combine(current.FullName, "FsusBlog.slnx")))
            {
                return current.FullName;
            }

            current = current.Parent;
        }

        throw new DirectoryNotFoundException("repo root not found");
    }
}
