using FsusBlog.Server.Infrastructure.Cache;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Primitives;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
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
    public void FilterRegistryKeysByPrefixes_MatchesAnyPrefix()
    {
        RedisValue[] registryEntries =
        [
            "fsus:blog:comment-cursor:article:42:root:1",
            "fsus:blog:comment-cursor:article:42:page:1",
            "fsus:blog:comment-cursor:article:7:page:1"
        ];

        IReadOnlyList<string> matches = UnifiedCache.FilterRegistryKeysByPrefixes(
            [
                "fsus:blog:comment-cursor:article:42:root:",
                "fsus:blog:comment-cursor:article:42:page:"
            ],
            registryEntries);

        Assert.Equal(
            [
                "fsus:blog:comment-cursor:article:42:root:1",
                "fsus:blog:comment-cursor:article:42:page:1"
            ],
            matches);
    }

    [Fact]
    public void BuildCommonPrefixForTests_ReturnsSharedPolicyPrefix()
    {
        string prefix = UnifiedCache.BuildCommonPrefixForTests(
            [
                "fsus:blog:comment-cursor:article:42:root:",
                "fsus:blog:comment-cursor:article:42:page:"
            ]);

        Assert.Equal("fsus:blog:comment-cursor:article:42:", prefix);
    }

    [Fact]
    public async Task RemoveManyAsync_DeletesL1RedisKeysAndRegistryMembersInBatches()
    {
        using var memory = new MemoryCache(new MemoryCacheOptions());
        var db = Substitute.For<IDatabase>();
        db.KeyDeleteAsync(Arg.Any<RedisKey[]>(), Arg.Any<CommandFlags>()).Returns(Task.FromResult(2L));
        db.SetRemoveAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue[]>(), Arg.Any<CommandFlags>()).Returns(Task.FromResult(2L));
        UnifiedCache cache = CreateCache(memory, db);
        string firstKey = cache.BuildKey(CachePolicyId.CommentCursor, "article:42:root:1");
        string secondKey = cache.BuildKey(CachePolicyId.CommentCursor, "article:42:page:1");
        memory.Set(firstKey, new byte[] { 1 });
        memory.Set(secondKey, new byte[] { 2 });

        await cache.RemoveManyAsync(
            [
                new(CachePolicyId.CommentCursor, "article:42:root:1"),
                new(CachePolicyId.CommentCursor, "article:42:page:1")
            ]);

        Assert.False(memory.TryGetValue(firstKey, out _));
        Assert.False(memory.TryGetValue(secondKey, out _));
        await db.Received(1).KeyDeleteAsync(
            Arg.Is<RedisKey[]>(keys => ContainsAll(keys, firstKey, secondKey)),
            Arg.Any<CommandFlags>());
        await db.Received(1).SetRemoveAsync(
            Arg.Is<RedisKey>(key => key.ToString() == UnifiedCache.BuildRegistryKeyForTests(CachePolicyId.CommentCursor)),
            Arg.Is<RedisValue[]>(values => ContainsAll(values, firstKey, secondKey)),
            Arg.Any<CommandFlags>());
    }

    [Fact]
    public void RemoveByPrefixMany_SourceGroupsByPolicyAndScansRegistryOnce()
    {
        string source = File.ReadAllText(Path.Combine(FindRepoRoot(), "src/backend/Infrastructure/Cache/IUnifiedCache.cs"));

        Assert.Contains("RemoveByPrefixManyAsync", source, StringComparison.Ordinal);
        Assert.Contains("prefixes.GroupBy(static item => item.PolicyId)", source, StringComparison.Ordinal);
        Assert.Contains("DeleteRegisteredKeysByPrefixesAsync(registryKey, resolvedPrefixes", source, StringComparison.Ordinal);
        Assert.Contains("_db.SetScan(registryKey, pageSize: PrefixInvalidationBatchSize)", source, StringComparison.Ordinal);
        Assert.Contains("DeleteKeysByPrefixesScanAsync(resolvedPrefixes", source, StringComparison.Ordinal);
        Assert.Contains("BuildCommonPrefix(prefixes)", source, StringComparison.Ordinal);
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
    public void CachePolicyRegistry_DisablesRegistryForExactAndVersionedHotPathCaches()
    {
        var registry = new CachePolicyRegistry();

        Assert.True(registry.TryGet(CachePolicyId.ArticleListFrame, out CachePolicy articleListFrame));
        Assert.False(articleListFrame.RegisterKeysForPrefixInvalidation);

        Assert.True(registry.TryGet(CachePolicyId.SecurityPowRisk, out CachePolicy securityRisk));
        Assert.False(securityRisk.RegisterKeysForPrefixInvalidation);

        Assert.True(registry.TryGet(CachePolicyId.CommentCursorFrame, out CachePolicy commentFrame));
        Assert.True(commentFrame.RegisterKeysForPrefixInvalidation);
    }

    [Fact]
    public async Task SetStringAsync_SecurityBlacklistUser_StoresRedisValueWithoutExpiry()
    {
        using var memory = new MemoryCache(new MemoryCacheOptions());
        var db = Substitute.For<IDatabase>();
        db.StringSetAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<RedisValue>(),
                Arg.Any<TimeSpan?>(),
                Arg.Any<When>(),
                Arg.Any<CommandFlags>())
            .Returns(Task.FromResult(true));
        UnifiedCache cache = CreateCache(memory, db);

        await cache.SetStringAsync(CachePolicyId.SecurityBlacklistUser, "42", "spam");

        await db.Received(1).StringSetAsync(
            Arg.Is<RedisKey>(key => key.ToString() == "fsus:sec:blacklist-user:42"),
            Arg.Any<RedisValue>(),
            Arg.Is<TimeSpan?>(expiry => !expiry.HasValue),
            Arg.Any<When>(),
            Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task ConsumeOnceAsync_PreCanceledTokenDoesNotCreateRedisTransaction()
    {
        using var memory = new MemoryCache(new MemoryCacheOptions());
        var db = Substitute.For<IDatabase>();
        var transaction = Substitute.For<ITransaction>();
        transaction.ExecuteAsync(Arg.Any<CommandFlags>()).Returns(Task.FromResult(false));
        db.CreateTransaction(Arg.Any<object?>()).Returns(transaction);
        UnifiedCache cache = CreateCache(memory, db);
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        await Assert.ThrowsAsync<OperationCanceledException>(
            () => cache.ConsumeOnceAsync(CachePolicyId.SecurityMfaProof, "proof-1", cts.Token));

        db.DidNotReceive().CreateTransaction(Arg.Any<object?>());
    }

    [Fact]
    public async Task ConsumeOnceAsync_RemovesL1BeforeExecutingRedisTransaction()
    {
        using var memory = new RemoveTrackingMemoryCache();
        var db = Substitute.For<IDatabase>();
        var transaction = Substitute.For<ITransaction>();
        db.CreateTransaction(Arg.Any<object?>()).Returns(transaction);
        UnifiedCache cache = CreateCache(memory, db);
        string key = cache.BuildKey(CachePolicyId.SecurityMfaProof, "proof-1");
        transaction.ExecuteAsync(Arg.Any<CommandFlags>()).Returns(_ =>
        {
            Assert.True(memory.Removed);
            Assert.Equal(key, memory.RemovedKey);
            return Task.FromResult(true);
        });

        bool consumed = await cache.ConsumeOnceAsync(CachePolicyId.SecurityMfaProof, "proof-1");

        Assert.True(consumed);
        await transaction.Received(1).ExecuteAsync(Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task ConsumeOnceAsync_CancellationAfterRedisDeleteSkipsRegistryUnregister()
    {
        using var memory = new MemoryCache(new MemoryCacheOptions());
        var db = Substitute.For<IDatabase>();
        db.SetRemoveAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue>(), Arg.Any<CommandFlags>())
            .Returns(Task.FromResult(true));
        var transaction = Substitute.For<ITransaction>();
        db.CreateTransaction(Arg.Any<object?>()).Returns(transaction);
        UnifiedCache cache = CreateCache(memory, db);
        using var cts = new CancellationTokenSource();
        transaction.ExecuteAsync(Arg.Any<CommandFlags>()).Returns(_ =>
        {
            cts.Cancel();
            return Task.FromResult(true);
        });

        await Assert.ThrowsAsync<OperationCanceledException>(
            () => cache.ConsumeOnceAsync(CachePolicyId.CommentCursor, "cursor-1", cts.Token));

        await db.DidNotReceive().SetRemoveAsync(
            Arg.Any<RedisKey>(),
            Arg.Any<RedisValue>(),
            Arg.Any<CommandFlags>());
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

    private static UnifiedCache CreateCache(IMemoryCache memory, IDatabase db)
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(db);
        return new UnifiedCache(
            memory,
            redis,
            new CachePolicyRegistry(),
            new DefaultRuntimeKeyScope(),
            NullLogger<UnifiedCache>.Instance);
    }

    private sealed class RemoveTrackingMemoryCache : IMemoryCache
    {
        public bool Removed { get; private set; }
        public object? RemovedKey { get; private set; }

        public bool TryGetValue(object key, out object? value)
        {
            value = null;
            return false;
        }

        public ICacheEntry CreateEntry(object key)
            => new TestCacheEntry(key);

        public void Remove(object key)
        {
            Removed = true;
            RemovedKey = key;
        }

        public void Dispose()
        {
        }
    }

    private sealed class TestCacheEntry(object key) : ICacheEntry
    {
        public object Key { get; } = key;
        public object? Value { get; set; }
        public DateTimeOffset? AbsoluteExpiration { get; set; }
        public TimeSpan? AbsoluteExpirationRelativeToNow { get; set; }
        public TimeSpan? SlidingExpiration { get; set; }
        public IList<IChangeToken> ExpirationTokens { get; } = new List<IChangeToken>();
        public IList<PostEvictionCallbackRegistration> PostEvictionCallbacks { get; } = new List<PostEvictionCallbackRegistration>();
        public CacheItemPriority Priority { get; set; }
        public long? Size { get; set; }

        public void Dispose()
        {
        }
    }

    private static bool ContainsAll(RedisKey[] keys, params string[] expected)
    {
        string[] values = keys.Select(static key => key.ToString()).ToArray();
        return expected.All(expectedKey => values.Contains(expectedKey, StringComparer.Ordinal));
    }

    private static bool ContainsAll(RedisValue[] values, params string[] expected)
    {
        string[] actual = values.Select(static value => value.ToString()).ToArray();
        return expected.All(expectedValue => actual.Contains(expectedValue, StringComparer.Ordinal));
    }
}
