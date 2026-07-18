using System.Collections.Concurrent;
using System.Text;

using FsusBlog.Server.Infrastructure.Cache;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Primitives;
using NSubstitute;
using StackExchange.Redis;
namespace FsusBlog.Server.Tests;

public sealed class UnifiedCacheTests
{
    [Fact]
    public async Task StringL1Hit_DoesNotConstructRedisKeyOrCallRedis()
    {
        using var memory = new MemoryCache(new MemoryCacheOptions());
        var db = Substitute.For<IDatabase>();
        db.StringSetAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<RedisValue>(),
                Arg.Any<TimeSpan?>(),
                Arg.Any<When>(),
                Arg.Any<CommandFlags>())
            .Returns(true);
        var scope = new CountingRuntimeKeyScope("e2e:alpha:", "alpha");
        UnifiedCache cache = CreateCache(memory, db, scope);
        await cache.SetRawAsync(CachePolicyId.ArticleHotFrame, "core:v2:10", [1, 2, 3]);
        scope.Reset();
        db.ClearReceivedCalls();

        CacheReadResult<ReadOnlyMemory<byte>> read = await cache.TryGetRawReadonlyAsync(
            CachePolicyId.ArticleHotFrame,
            "core:v2:10");

        Assert.True(read.Hit);
        Assert.Equal(new byte[] { 1, 2, 3 }, read.Value.ToArray());
        Assert.Equal(0, scope.PrefixKeyCalls);
        await db.DidNotReceive().StringGetAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task IntegerL1Identity_PreservesNumericTypeAndAvoidsStringRedisKeyOnHit()
    {
        using var memory = new MemoryCache(new MemoryCacheOptions());
        var db = Substitute.For<IDatabase>();
        db.StringSetAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<RedisValue>(),
                Arg.Any<TimeSpan?>(),
                Arg.Any<When>(),
                Arg.Any<CommandFlags>())
            .Returns(true);
        var scope = new CountingRuntimeKeyScope("", "runtime");
        UnifiedCache cache = CreateCache(memory, db, scope);
        await cache.SetRawAsync(CachePolicyId.ArticleDetailFrame, 42, [4, 2]);
        CacheL1Key created = CacheL1Key.ForInteger("runtime", CachePolicyId.ArticleDetailFrame, 42);
        Assert.Equal(CacheIdentityKind.Integer, created.IdentityKind);
        Assert.Equal(42, created.IntegerIdentity);
        Assert.Null(created.StringIdentity);
        scope.Reset();
        db.ClearReceivedCalls();

        CacheReadResult<ReadOnlyMemory<byte>> read = await cache.TryGetRawReadonlyAsync(CachePolicyId.ArticleDetailFrame, 42);

        Assert.True(read.Hit);
        Assert.Equal(0, scope.PrefixKeyCalls);
        await db.DidNotReceive().StringGetAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>());
        Assert.Equal(
            cache.BuildKey(CachePolicyId.ArticleDetailFrame, "42"),
            cache.BuildKey(CachePolicyId.ArticleDetailFrame, 42));
    }

    [Fact]
    public async Task StringCompatibilityInvalidation_RemovesIntegerStructuredL1Alias()
    {
        using var memory = new MemoryCache(new MemoryCacheOptions());
        var db = Substitute.For<IDatabase>();
        db.StringSetAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<RedisValue>(),
                Arg.Any<TimeSpan?>(),
                Arg.Any<When>(),
                Arg.Any<CommandFlags>())
            .Returns(true);
        db.StringGetAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>()).Returns(RedisValue.Null);
        UnifiedCache cache = CreateCache(memory, db);
        await cache.SetRawAsync(CachePolicyId.ArticleDetail, 42, [4, 2]);

        await cache.RemoveManyAsync([new CacheKeyIdentity(CachePolicyId.ArticleDetail, "42")]);
        CacheReadResult<ReadOnlyMemory<byte>> read = await cache.TryGetRawReadonlyAsync(CachePolicyId.ArticleDetail, 42);

        Assert.False(read.Hit);
        await db.Received().StringGetAsync(cache.BuildKey(CachePolicyId.ArticleDetail, 42), Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task StructuredL1Entry_ExpiresWithoutRequiringMemoryCacheLookup()
    {
        using var memory = new MemoryCache(new MemoryCacheOptions());
        var db = Substitute.For<IDatabase>();
        db.StringSetAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<RedisValue>(),
                Arg.Any<TimeSpan?>(),
                Arg.Any<When>(),
                Arg.Any<CommandFlags>())
            .Returns(true);
        db.StringGetAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>()).Returns(RedisValue.Null);
        var policy = new CachePolicy(
            CachePolicyId.ArticleDetail,
            "blog",
            "article-detail",
            TimeSpan.FromMilliseconds(1),
            TimeSpan.FromMinutes(1));
        UnifiedCache cache = CreateCache(memory, db, policyRegistry: new FixedPolicyRegistry(policy));
        await cache.SetRawAsync(CachePolicyId.ArticleDetail, 42, [4, 2]);

        await Task.Delay(TimeSpan.FromMilliseconds(20));
        CacheReadResult<ReadOnlyMemory<byte>> read = await cache.TryGetRawReadonlyAsync(CachePolicyId.ArticleDetail, 42);

        Assert.False(read.Hit);
        await db.Received().StringGetAsync(cache.BuildKey(CachePolicyId.ArticleDetail, 42), Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task StructuredL1Key_BindsRuntimeScopeAndRemoveInvalidatesIt()
    {
        using var memory = new MemoryCache(new MemoryCacheOptions());
        var db = Substitute.For<IDatabase>();
        db.StringSetAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<RedisValue>(),
                Arg.Any<TimeSpan?>(),
                Arg.Any<When>(),
                Arg.Any<CommandFlags>())
            .Returns(true);
        db.StringGetAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>()).Returns(RedisValue.Null);
        UnifiedCache alpha = CreateCache(memory, db, new CountingRuntimeKeyScope("e2e:alpha:", "alpha"));
        UnifiedCache beta = CreateCache(memory, db, new CountingRuntimeKeyScope("e2e:beta:", "beta"));
        await alpha.SetRawAsync(CachePolicyId.ArticleHotFrame, 8, [8]);

        CacheReadResult<ReadOnlyMemory<byte>> isolated = await beta.TryGetRawReadonlyAsync(CachePolicyId.ArticleHotFrame, 8);
        Assert.False(isolated.Hit);

        await alpha.RemoveAsync(CachePolicyId.ArticleHotFrame, 8);
        CacheReadResult<ReadOnlyMemory<byte>> removed = await alpha.TryGetRawReadonlyAsync(CachePolicyId.ArticleHotFrame, 8);
        Assert.False(removed.Hit);
    }

    [Fact]
    public async Task RawFrameOwnership_DefensiveSetAndCallerCopyCannotMutateReadonlyCacheValue()
    {
        using var memory = new MemoryCache(new MemoryCacheOptions());
        var db = Substitute.For<IDatabase>();
        db.StringSetAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<RedisValue>(),
                Arg.Any<TimeSpan?>(),
                Arg.Any<When>(),
                Arg.Any<CommandFlags>())
            .Returns(true);
        UnifiedCache cache = CreateCache(memory, db);
        byte[] source = [1, 2, 3];
        await cache.SetRawAsync(CachePolicyId.ArticleListFrame, "v:7:home", source);
        source[0] = 9;

        CacheReadResult<byte[]> callerOwned = await cache.TryGetRawAsync(CachePolicyId.ArticleListFrame, "v:7:home");
        callerOwned.Value![1] = 8;
        CacheReadResult<ReadOnlyMemory<byte>> readonlyFrame = await cache.TryGetRawReadonlyAsync(CachePolicyId.ArticleListFrame, "v:7:home");

        Assert.Equal(new byte[] { 1, 2, 3 }, readonlyFrame.Value.ToArray());
        Assert.Equal(new byte[] { 1, 8, 3 }, callerOwned.Value);
    }

    [Fact]
    public void StructuredL1Key_BindsVersionWithoutChangingRedisIntegerCompatibility()
    {
        CacheL1Key v1 = CacheL1Key.ForInteger("runtime", CachePolicyId.ArticleDetailFrame, 42, "v1");
        CacheL1Key v2 = CacheL1Key.ForInteger("runtime", CachePolicyId.ArticleDetailFrame, 42, "v2");
        Assert.NotEqual(v1, v2);

        using var memory = new MemoryCache(new MemoryCacheOptions());
        UnifiedCache cache = CreateCache(memory, Substitute.For<IDatabase>());
        Assert.Equal(
            cache.BuildKey(CachePolicyId.ArticleDetailFrame, "42", "v1"),
            cache.BuildKey(CachePolicyId.ArticleDetailFrame, 42, "v1"));
    }

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
    public async Task RemoveManyAsync_DeletesRedisKeysAndRegistryMembersAtomically()
    {
        using var memory = new MemoryCache(new MemoryCacheOptions());
        var db = Substitute.For<IDatabase>();
        string? capturedScript = null;
        RedisKey[]? capturedKeys = null;
        RedisValue[]? capturedValues = null;
        db.ScriptEvaluateAsync(
                Arg.Any<string>(),
                Arg.Any<RedisKey[]>(),
                Arg.Any<RedisValue[]>(),
                Arg.Any<CommandFlags>())
            .Returns(call =>
            {
                capturedScript = call.ArgAt<string>(0);
                capturedKeys = call.ArgAt<RedisKey[]>(1);
                capturedValues = call.ArgAt<RedisValue[]>(2);
                return Task.FromResult(RedisResult.Create((RedisValue)2L));
            });
        UnifiedCache cache = CreateCache(memory, db);
        string firstKey = cache.BuildKey(CachePolicyId.ArticleHot, "article:42:root:1");
        string secondKey = cache.BuildKey(CachePolicyId.ArticleHot, "article:42:page:1");
        memory.Set(firstKey, new byte[] { 1 });
        memory.Set(secondKey, new byte[] { 2 });

        await cache.RemoveManyAsync(
            [
                new(CachePolicyId.ArticleHot, "article:42:root:1"),
                new(CachePolicyId.ArticleHot, "article:42:page:1")
            ]);

        Assert.False(memory.TryGetValue(firstKey, out _));
        Assert.False(memory.TryGetValue(secondKey, out _));
        Assert.NotNull(capturedScript);
        Assert.Contains("redis.call('DEL'", capturedScript, StringComparison.Ordinal);
        Assert.Contains("redis.call('SREM'", capturedScript, StringComparison.Ordinal);
        Assert.NotNull(capturedKeys);
        Assert.Equal(UnifiedCache.BuildRegistryKeyForTests(CachePolicyId.ArticleHot), capturedKeys[0].ToString());
        Assert.True(ContainsAll(capturedKeys, firstKey, secondKey));
        Assert.NotNull(capturedValues);
        Assert.Empty(capturedValues);
        await db.DidNotReceive().KeyDeleteAsync(Arg.Any<RedisKey[]>(), Arg.Any<CommandFlags>());
        await db.DidNotReceive().SetRemoveAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue[]>(), Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task RemoveManyAsync_SourceUsesSingleLuaScriptForDeleteAndRegistryRemoval()
    {
        await RemoveManyAsync_DeletesRedisKeysAndRegistryMembersAtomically();
    }

    [Fact]
    public async Task RemoveByPrefixMany_SourceGroupsByPolicyAndScansRegistryOnce()
    {
        using var memory = new RemoveTrackingMemoryCache();
        var db = Substitute.For<IDatabase>();
        UnifiedCache cache = CreateCache(memory, db);
        string registryKey = UnifiedCache.BuildRegistryKeyForTests(CachePolicyId.PublicAotDocument);
        string first = cache.BuildKey(CachePolicyId.PublicAotDocument, "route:home:v1");
        string second = cache.BuildKey(CachePolicyId.PublicAotDocument, "route:archive:v1");
        string untouched = cache.BuildKey(CachePolicyId.PublicAotDocument, "route:article:42");
        db.KeyExistsAsync(Arg.Is<RedisKey>(key => key.ToString() == registryKey), Arg.Any<CommandFlags>())
            .Returns(Task.FromResult(true));
        db.SetScan(
                Arg.Is<RedisKey>(key => key.ToString() == registryKey),
                Arg.Any<RedisValue>(),
                Arg.Any<int>(),
                Arg.Any<long>(),
                Arg.Any<int>(),
                Arg.Any<CommandFlags>())
            .Returns([(RedisValue)first, (RedisValue)second, (RedisValue)untouched]);
        db.KeyDeleteAsync(Arg.Any<RedisKey[]>(), Arg.Any<CommandFlags>()).Returns(Task.FromResult(2L));
        db.SetRemoveAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue[]>(), Arg.Any<CommandFlags>()).Returns(Task.FromResult(2L));

        await cache.RemoveByPrefixManyAsync(
        [
            new(CachePolicyId.PublicAotDocument, "route:home:"),
            new(CachePolicyId.PublicAotDocument, "route:archive:")
        ]);

        _ = db.Received(1).SetScan(
            Arg.Is<RedisKey>(key => key.ToString() == registryKey),
            Arg.Any<RedisValue>(),
            Arg.Any<int>(),
            Arg.Any<long>(),
            Arg.Any<int>(),
            Arg.Any<CommandFlags>());
        await db.Received(1).KeyDeleteAsync(
            Arg.Is<RedisKey[]>(keys => keys.Length == 2
                && keys.Any(key => key.ToString() == first)
                && keys.Any(key => key.ToString() == second)
                && keys.All(key => key.ToString() != untouched)),
            Arg.Any<CommandFlags>());
        Assert.Contains(first, memory.RemovedKeys);
        Assert.Contains(second, memory.RemovedKeys);
        Assert.DoesNotContain(untouched, memory.RemovedKeys);
    }

    [Fact]
    public async Task RemoveByPrefix_SourceUsesPagedSetScanInsteadOfSetMembers()
    {
        await RemoveByPrefixMany_SourceGroupsByPolicyAndScansRegistryOnce();
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

        Assert.True(registry.TryGet(CachePolicyId.CommentCursor, out CachePolicy commentCursor));
        Assert.False(commentCursor.RegisterKeysForPrefixInvalidation);

        Assert.True(registry.TryGet(CachePolicyId.UserCommentCursor, out CachePolicy userCommentCursor));
        Assert.False(userCommentCursor.RegisterKeysForPrefixInvalidation);

        Assert.True(registry.TryGet(CachePolicyId.CommentCursorFrame, out CachePolicy commentFrame));
        Assert.False(commentFrame.RegisterKeysForPrefixInvalidation);

        Assert.True(registry.TryGet(CachePolicyId.UserCommentCursorFrame, out CachePolicy userCommentFrame));
        Assert.False(userCommentFrame.RegisterKeysForPrefixInvalidation);
    }

    [Fact]
    public async Task CommentMutationInvalidation_UsesVersionBumpsInsteadOfCursorPrefixScans()
    {
        var cache = Substitute.For<IUnifiedCache>();
        cache.IncrementAsync(Arg.Any<CachePolicyId>(), Arg.Any<string>(), Arg.Any<long>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(1L));
        var dispatcher = new CacheInvalidationDispatcher(cache, Substitute.For<IHttpCacheInvalidator>());

        await dispatcher.InvalidateCommentMutationAsync(new CommentCacheInvalidationScope(
            ArticleId: 42,
            RootId: 7,
            AccountId: 9,
            PublicArticleChanged: true,
            UserCommentsChanged: true));

        await cache.Received(1).IncrementAsync(CachePolicyId.CommentCursorVersion, "article:42", 1, Arg.Any<CancellationToken>());
        await cache.Received(1).IncrementAsync(CachePolicyId.CommentCursorVersion, "article:42:root:7", 1, Arg.Any<CancellationToken>());
        await cache.Received(1).IncrementAsync(CachePolicyId.UserCommentCursorVersion, "account:9", 1, Arg.Any<CancellationToken>());
        await cache.DidNotReceive().RemoveByPrefixAsync(
            Arg.Is<CachePolicyId>(policy => policy == CachePolicyId.CommentCursor
                || policy == CachePolicyId.UserCommentCursor),
            Arg.Any<string>(),
            Arg.Any<CancellationToken>());
        await cache.DidNotReceive().RemoveByPrefixManyAsync(Arg.Any<IReadOnlyList<CachePrefixIdentity>>(), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task BackendQpsCommentCursorEvidence_TracksVersionedInvalidationContract()
    {
        var cache = Substitute.For<IUnifiedCache>();
        cache.IncrementAsync(Arg.Any<CachePolicyId>(), Arg.Any<string>(), Arg.Any<long>(), Arg.Any<CancellationToken>())
            .Returns(Task.FromResult(1L));
        var dispatcher = new CacheInvalidationDispatcher(cache, Substitute.For<IHttpCacheInvalidator>());

        await dispatcher.InvalidateCommentMutationAsync();

        await cache.Received(1).IncrementAsync(CachePolicyId.CommentCursorVersion, "global", 1, Arg.Any<CancellationToken>());
        await cache.Received(1).IncrementAsync(CachePolicyId.UserCommentCursorVersion, "global", 1, Arg.Any<CancellationToken>());
        await cache.DidNotReceive().RemoveAsync(CachePolicyId.CommentCursorFrame, Arg.Any<string>(), Arg.Any<CancellationToken>());
        await cache.DidNotReceive().RemoveAsync(CachePolicyId.UserCommentCursorFrame, Arg.Any<string>(), Arg.Any<CancellationToken>());
        var registry = new CachePolicyRegistry();
        Assert.False(AssertPolicy(registry, CachePolicyId.CommentCursorFrame).RegisterKeysForPrefixInvalidation);
        Assert.False(AssertPolicy(registry, CachePolicyId.UserCommentCursorFrame).RegisterKeysForPrefixInvalidation);
        Assert.False(AssertPolicy(registry, CachePolicyId.CommentCursorVersion).RegisterKeysForPrefixInvalidation);
        Assert.False(AssertPolicy(registry, CachePolicyId.UserCommentCursorVersion).RegisterKeysForPrefixInvalidation);
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
    public async Task TrySetStringIfValueAsync_UsesRedisConditionAndPublishesL1OnlyAfterCommit()
    {
        using var memory = new RemoveTrackingMemoryCache();
        var db = Substitute.For<IDatabase>();
        var transaction = Substitute.For<ITransaction>();
        db.CreateTransaction(Arg.Any<object?>()).Returns(transaction);
        transaction.StringSetAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<RedisValue>(),
                Arg.Any<TimeSpan?>(),
                Arg.Any<When>(),
                Arg.Any<CommandFlags>())
            .Returns(Task.FromResult(true));
        transaction.ExecuteAsync(Arg.Any<CommandFlags>()).Returns(Task.FromResult(true));
        UnifiedCache cache = CreateCache(memory, db);
        string targetKey = cache.BuildKey(CachePolicyId.CommentCursorVersion, "article:42");

        bool updated = await cache.TrySetStringIfValueAsync(
            CachePolicyId.CommentCursorVersion,
            "article:42",
            "8",
            "article:42:expected",
            "7");

        Assert.True(updated);
        transaction.Received(1).AddCondition(Arg.Any<Condition>());
        await transaction.Received(1).StringSetAsync(
            Arg.Is<RedisKey>(key => key.ToString() == targetKey),
            Arg.Is<RedisValue>(value => Encoding.UTF8.GetString((byte[])value!) == "8"),
            Arg.Any<TimeSpan?>(),
            When.Always,
            CommandFlags.None);
        await transaction.Received(1).ExecuteAsync(CommandFlags.None);
        db.ClearReceivedCalls();
        Assert.Equal("8", await cache.GetStringAsync(CachePolicyId.CommentCursorVersion, "article:42"));
        await db.DidNotReceive().StringGetAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>());
        await db.DidNotReceive().StringSetAsync(
            Arg.Any<RedisKey>(),
            Arg.Any<RedisValue>(),
            Arg.Any<TimeSpan?>(),
            Arg.Any<When>(),
            Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task TrySetVersionedStringAsync_UsesLuaVersionGuardAndUpdatesL1OnlyOnSuccess()
    {
        using var memory = new RemoveTrackingMemoryCache();
        var db = Substitute.For<IDatabase>();
        UnifiedCache cache = CreateCache(memory, db);
        string key = cache.BuildKey(CachePolicyId.SecurityBlacklistUser, "account:abc");
        string? capturedScript = null;
        RedisKey[]? capturedKeys = null;
        RedisValue[]? capturedValues = null;
        db.ScriptEvaluateAsync(
                Arg.Any<string>(),
                Arg.Any<RedisKey[]>(),
                Arg.Any<RedisValue[]>(),
                Arg.Any<CommandFlags>())
            .Returns(call =>
            {
                capturedScript = call.ArgAt<string>(0);
                capturedKeys = call.ArgAt<RedisKey[]>(1);
                capturedValues = call.ArgAt<RedisValue[]>(2);
                return Task.FromResult(RedisResult.Create((RedisValue)1L));
            });

        bool updated = await cache.TrySetVersionedStringAsync(
            CachePolicyId.SecurityBlacklistUser,
            "account:abc",
            "v1|7|1|YmFu",
            "7");

        Assert.True(updated);
        Assert.True(memory.Removed);
        Assert.Equal(key, memory.RemovedKey);
        Assert.NotNull(capturedScript);
        Assert.Contains("currentVersion ~= ARGV[2]", capturedScript, StringComparison.Ordinal);
        Assert.Contains("return 0", capturedScript, StringComparison.Ordinal);
        Assert.NotNull(capturedKeys);
        Assert.Equal([new RedisKey(key)], capturedKeys);
        Assert.NotNull(capturedValues);
        Assert.Equal((RedisValue)"v1|7|1|YmFu", capturedValues![0]);
        Assert.Equal((RedisValue)"7", capturedValues[1]);
        Assert.Equal((RedisValue)(-1L), capturedValues[2]);
        Assert.Equal((RedisValue)"0", capturedValues[3]);
    }

    [Fact]
    public async Task TrySetVersionedStringAsync_ConflictDoesNotSetL1()
    {
        using var memory = new RemoveTrackingMemoryCache();
        var db = Substitute.For<IDatabase>();
        db.ScriptEvaluateAsync(
                Arg.Any<string>(),
                Arg.Any<RedisKey[]>(),
                Arg.Any<RedisValue[]>(),
                Arg.Any<CommandFlags>())
            .Returns(Task.FromResult(RedisResult.Create((RedisValue)0L)));
        UnifiedCache cache = CreateCache(memory, db);

        bool updated = await cache.TrySetVersionedStringAsync(
            CachePolicyId.SecurityBlacklistUser,
            "account:abc",
            "v1|7|1|YmFu",
            "7");

        Assert.False(updated);
        Assert.True(memory.Removed);
        Assert.Empty(memory.CreatedKeys);
    }

    [Fact]
    public async Task IncrementAsync_RemovesL1BeforeRedisIncrement()
    {
        using var memory = new RemoveTrackingMemoryCache();
        var db = Substitute.For<IDatabase>();
        UnifiedCache cache = CreateCache(memory, db);
        string key = cache.BuildKey(CachePolicyId.MessageUnread, "42");
        db.StringIncrementAsync(
                Arg.Any<RedisKey>(),
                Arg.Any<long>(),
                Arg.Any<CommandFlags>())
            .Returns(_ =>
            {
                Assert.True(memory.Removed);
                Assert.Equal(key, memory.RemovedKey);
                return Task.FromResult(5L);
            });

        long updated = await cache.IncrementAsync(CachePolicyId.MessageUnread, "42");

        Assert.Equal(5L, updated);
    }

    [Fact]
    public async Task IncrementManyAsync_UsesSingleRedisScriptAndReturnsAtomicSnapshot()
    {
        using var memory = new RemoveTrackingMemoryCache();
        var db = Substitute.For<IDatabase>();
        UnifiedCache cache = CreateCache(memory, db);
        string ticketKey = cache.BuildKey(CachePolicyId.SecurityMfaChallenge, "fail:ticket:t1");
        string subjectKey = cache.BuildKey(CachePolicyId.SecurityMfaChallenge, "fail:subject:s1");
        string ipKey = cache.BuildKey(CachePolicyId.SecurityMfaChallenge, "fail:ip:i1");
        string? capturedScript = null;
        RedisKey[]? capturedKeys = null;
        RedisValue[]? capturedValues = null;
        db.ScriptEvaluateAsync(
                Arg.Any<string>(),
                Arg.Any<RedisKey[]>(),
                Arg.Any<RedisValue[]>(),
                Arg.Any<CommandFlags>())
            .Returns(call =>
            {
                capturedScript = call.ArgAt<string>(0);
                capturedKeys = call.ArgAt<RedisKey[]>(1);
                capturedValues = call.ArgAt<RedisValue[]>(2);
                return Task.FromResult(RedisResult.Create(
                    [
                        RedisResult.Create((RedisValue)1L),
                        RedisResult.Create((RedisValue)10L),
                        RedisResult.Create((RedisValue)3L)
                    ]));
            });

        long[] updated = await cache.IncrementManyAsync(
            CachePolicyId.SecurityMfaChallenge,
            ["fail:ticket:t1", "fail:subject:s1", "fail:ip:i1"]);

        Assert.Equal([1L, 10L, 3L], updated);
        Assert.NotNull(capturedScript);
        Assert.Contains("INCRBY", capturedScript, StringComparison.OrdinalIgnoreCase);
        Assert.NotNull(capturedKeys);
        Assert.Equal([new RedisKey(ticketKey), new RedisKey(subjectKey), new RedisKey(ipKey)], capturedKeys);
        Assert.NotNull(capturedValues);
        Assert.Equal((RedisValue)1L, capturedValues![0]);
        Assert.Equal(ipKey, memory.RemovedKeys.Last());
        await db.DidNotReceive().StringIncrementAsync(
            Arg.Any<RedisKey>(),
            Arg.Any<long>(),
            Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task IncrementManyWithExpiryAsync_UsesSingleRedisScriptWithExpiryForEveryKey()
    {
        using var memory = new RemoveTrackingMemoryCache();
        var db = Substitute.For<IDatabase>();
        UnifiedCache cache = CreateCache(memory, db);
        string ticketKey = cache.BuildKey(CachePolicyId.SecurityMfaChallenge, "fail:ticket:t1");
        string subjectKey = cache.BuildKey(CachePolicyId.SecurityMfaChallenge, "fail:subject:s1");
        string ipKey = cache.BuildKey(CachePolicyId.SecurityMfaChallenge, "fail:ip:i1");
        string? capturedScript = null;
        RedisKey[]? capturedKeys = null;
        RedisValue[]? capturedValues = null;
        db.ScriptEvaluateAsync(
                Arg.Any<string>(),
                Arg.Any<RedisKey[]>(),
                Arg.Any<RedisValue[]>(),
                Arg.Any<CommandFlags>())
            .Returns(call =>
            {
                capturedScript = call.ArgAt<string>(0);
                capturedKeys = call.ArgAt<RedisKey[]>(1);
                capturedValues = call.ArgAt<RedisValue[]>(2);
                return Task.FromResult(RedisResult.Create(
                    [
                        RedisResult.Create((RedisValue)2L),
                        RedisResult.Create((RedisValue)11L),
                        RedisResult.Create((RedisValue)4L),
                        RedisResult.Create((RedisValue)3L)
                    ]));
            });
        var method = typeof(UnifiedCache).GetMethod(
            "IncrementManyWithExpiryAsync",
            [
                typeof(CachePolicyId),
                typeof(IReadOnlyList<string>),
                typeof(TimeSpan),
                typeof(long),
                typeof(CancellationToken)
            ]);

        Assert.NotNull(method);
        var task = Assert.IsAssignableFrom<Task<long[]>>(method.Invoke(
            cache,
            [CachePolicyId.SecurityMfaChallenge, new[] { "fail:ticket:t1", "fail:subject:s1", "fail:ip:i1" }, TimeSpan.FromMinutes(10), 1L, CancellationToken.None]));
        long[] updated = await task;

        Assert.Equal([2L, 11L, 4L], updated);
        Assert.NotNull(capturedScript);
        Assert.Contains("INCRBY", capturedScript, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("PTTL", capturedScript, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("PEXPIRE", capturedScript, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("< 0", capturedScript, StringComparison.OrdinalIgnoreCase);
        Assert.NotNull(capturedKeys);
        Assert.Equal([new RedisKey(ticketKey), new RedisKey(subjectKey), new RedisKey(ipKey)], capturedKeys);
        Assert.NotNull(capturedValues);
        Assert.Equal((RedisValue)1L, capturedValues![0]);
        Assert.Equal((RedisValue)600000L, capturedValues![1]);
        Assert.Equal(ipKey, memory.RemovedKeys.Last());
    }

    [Fact]
    public async Task IncrementWithExpiryAsync_UsesAtomicRedisScriptWithExpiryAndBypassesL1()
    {
        using var memory = new RemoveTrackingMemoryCache();
        var db = Substitute.For<IDatabase>();
        UnifiedCache cache = CreateCache(memory, db);
        string key = cache.BuildKey(CachePolicyId.SecurityPowRisk, "verify:identity");
        string? capturedScript = null;
        RedisKey[]? capturedKeys = null;
        RedisValue[]? capturedValues = null;
        db.ScriptEvaluateAsync(
                Arg.Any<string>(),
                Arg.Any<RedisKey[]>(),
                Arg.Any<RedisValue[]>(),
                Arg.Any<CommandFlags>())
            .Returns(call =>
            {
                Assert.True(memory.Removed);
                Assert.Equal(key, memory.RemovedKey);
                capturedScript = call.ArgAt<string>(0);
                capturedKeys = call.ArgAt<RedisKey[]>(1);
                capturedValues = call.ArgAt<RedisValue[]>(2);
                return Task.FromResult(RedisResult.Create((RedisValue)4L));
            });
        var method = typeof(UnifiedCache).GetMethod(
            "IncrementWithExpiryAsync",
            [
                typeof(CachePolicyId),
                typeof(string),
                typeof(TimeSpan),
                typeof(long),
                typeof(CancellationToken)
            ]);

        Assert.NotNull(method);
        var task = Assert.IsAssignableFrom<Task<long>>(method.Invoke(
            cache,
            [CachePolicyId.SecurityPowRisk, "verify:identity", TimeSpan.FromMinutes(1), 1L, CancellationToken.None]));
        long updated = await task;

        Assert.Equal(4L, updated);
        Assert.NotNull(capturedScript);
        Assert.Contains("INCRBY", capturedScript, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("PEXPIRE", capturedScript, StringComparison.OrdinalIgnoreCase);
        Assert.NotNull(capturedKeys);
        Assert.NotNull(capturedValues);
        Assert.Equal([new RedisKey(key)], capturedKeys!);
        Assert.Equal((RedisValue)1L, capturedValues![0]);
        Assert.Equal((RedisValue)60000L, capturedValues[1]);
        await db.DidNotReceive().StringIncrementAsync(
            Arg.Any<RedisKey>(),
            Arg.Any<long>(),
            Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task IncrementClampedWithExpiryAsync_UsesAtomicRedisScriptWithClampExpiryAndBypassesL1()
    {
        using var memory = new RemoveTrackingMemoryCache();
        var db = Substitute.For<IDatabase>();
        UnifiedCache cache = CreateCache(memory, db);
        string key = cache.BuildKey(CachePolicyId.SecurityPowRisk, "risk:identity");
        string? capturedScript = null;
        RedisKey[]? capturedKeys = null;
        RedisValue[]? capturedValues = null;
        db.ScriptEvaluateAsync(
                Arg.Any<string>(),
                Arg.Any<RedisKey[]>(),
                Arg.Any<RedisValue[]>(),
                Arg.Any<CommandFlags>())
            .Returns(call =>
            {
                Assert.True(memory.Removed);
                Assert.Equal(key, memory.RemovedKey);
                capturedScript = call.ArgAt<string>(0);
                capturedKeys = call.ArgAt<RedisKey[]>(1);
                capturedValues = call.ArgAt<RedisValue[]>(2);
                return Task.FromResult(RedisResult.Create((RedisValue)100L));
            });

        long updated = await cache.IncrementClampedWithExpiryAsync(
            CachePolicyId.SecurityPowRisk,
            "risk:identity",
            75,
            100,
            TimeSpan.FromMinutes(2),
            CancellationToken.None);

        Assert.Equal(100L, updated);
        Assert.NotNull(capturedScript);
        Assert.Contains("GET", capturedScript, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("SET", capturedScript, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("PEXPIRE", capturedScript, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("maxValue", capturedScript, StringComparison.Ordinal);
        Assert.NotNull(capturedKeys);
        Assert.NotNull(capturedValues);
        Assert.Equal([new RedisKey(key)], capturedKeys!);
        Assert.Equal((RedisValue)75L, capturedValues![0]);
        Assert.Equal((RedisValue)100L, capturedValues[1]);
        Assert.Equal((RedisValue)120000L, capturedValues[2]);
        await db.DidNotReceive().StringGetAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>());
        await db.DidNotReceive().StringSetAsync(
            Arg.Any<RedisKey>(),
            Arg.Any<RedisValue>(),
            Arg.Any<TimeSpan?>(),
            Arg.Any<bool>(),
            Arg.Any<When>(),
            Arg.Any<CommandFlags>());
        await db.DidNotReceive().StringIncrementAsync(
            Arg.Any<RedisKey>(),
            Arg.Any<long>(),
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
    public async Task ConsumeOnceAndGetAsync_RemovesL1BeforeRedisGetDeleteAndReturnsPayload()
    {
        using var memory = new RemoveTrackingMemoryCache();
        var db = Substitute.For<IDatabase>();
        UnifiedCache cache = CreateCache(memory, db);
        string key = cache.BuildKey(CachePolicyId.SecurityPasskeyAuthChallenge, "challenge-1");
        db.StringGetDeleteAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>())
            .Returns(_ =>
            {
                Assert.True(memory.Removed);
                Assert.Equal(key, memory.RemovedKey);
                return Task.FromResult((RedisValue)Encoding.UTF8.GetBytes("payload"));
            });

        CacheReadResult<string> read = await cache.ConsumeOnceAndGetAsync(
            CachePolicyId.SecurityPasskeyAuthChallenge,
            "challenge-1",
            static bytes => (true, Encoding.UTF8.GetString(bytes.Span)));

        Assert.True(read.Hit);
        Assert.Equal("payload", read.Value);
        await db.Received(1).StringGetDeleteAsync(
            Arg.Is<RedisKey>(redisKey => redisKey.ToString() == key),
            Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task ConsumeOnceAndGetAsync_RedisMissDoesNotDecodeOrUnregister()
    {
        using var memory = new MemoryCache(new MemoryCacheOptions());
        var db = Substitute.For<IDatabase>();
        db.StringGetDeleteAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>())
            .Returns(Task.FromResult(RedisValue.Null));
        UnifiedCache cache = CreateCache(memory, db);
        bool decoded = false;

        CacheReadResult<string> read = await cache.ConsumeOnceAndGetAsync<string>(
            CachePolicyId.SecurityPasskeyAuthChallenge,
            "challenge-1",
            bytes =>
            {
                decoded = true;
                return (true, Encoding.UTF8.GetString(bytes.Span));
            });

        Assert.False(read.Hit);
        Assert.False(decoded);
        await db.DidNotReceive().SetRemoveAsync(
            Arg.Any<RedisKey>(),
            Arg.Any<RedisValue>(),
            Arg.Any<CommandFlags>());
    }

    [Fact]
    public async Task ConsumeOnceAndGetAsync_PreCanceledTokenDoesNotCallRedis()
    {
        using var memory = new MemoryCache(new MemoryCacheOptions());
        var db = Substitute.For<IDatabase>();
        UnifiedCache cache = CreateCache(memory, db);
        using var cts = new CancellationTokenSource();
        cts.Cancel();

        await Assert.ThrowsAsync<OperationCanceledException>(
            () => cache.ConsumeOnceAndGetAsync<string>(
                CachePolicyId.SecurityPasskeyAuthChallenge,
                "challenge-1",
                static bytes => (true, Encoding.UTF8.GetString(bytes.Span)),
                cts.Token));

        await db.DidNotReceive().StringGetDeleteAsync(Arg.Any<RedisKey>(), Arg.Any<CommandFlags>());
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

    [Fact]
    public async Task SingleFlightEntry_TryRetireIfIdle_DoesNotDisposeReferencedSemaphore()
    {
        var entry = new UnifiedCache.SingleFlightEntry();

        Assert.True(entry.TryAddReference());
        Assert.False(entry.TryRetireIfIdle());

        await entry.Semaphore.WaitAsync();
        entry.Semaphore.Release();

        Assert.True(entry.ReleaseReference(retireWhenIdle: true));
        await Assert.ThrowsAsync<ObjectDisposedException>(async () => await entry.Semaphore.WaitAsync());
    }

    [Fact]
    public async Task AcquireSingleFlightAsync_RemovesEntryAfterOperationCompletes()
    {
        using var memory = new MemoryCache(new MemoryCacheOptions());
        var db = Substitute.For<IDatabase>();
        UnifiedCache cache = CreateCache(memory, db);

        await using (await cache.AcquireSingleFlightAsync(CachePolicyId.ArticleListFrame, "article:list:1"))
        {
            Assert.Equal(1, GetSingleFlightEntryCount(cache));
        }

        Assert.Equal(0, GetSingleFlightEntryCount(cache));
    }

    [Fact]
    public async Task AcquireSingleFlightAsync_ManyUniqueKeysKeepsEntryCountBounded()
    {
        using var memory = new MemoryCache(new MemoryCacheOptions());
        var db = Substitute.For<IDatabase>();
        UnifiedCache cache = CreateCache(memory, db);

        for (int i = 0; i < 100_000; i++)
        {
            await using IAsyncDisposable lease = await cache.AcquireSingleFlightAsync(CachePolicyId.ArticleListFrame, $"article:list:{i}");
        }

        Assert.Equal(0, GetSingleFlightEntryCount(cache));
    }

    [Fact]
    public async Task AcquireSingleFlightAsync_DoesNotUseMemoryCacheEvictionForSingleFlight()
    {
        using var memory = new RemoveTrackingMemoryCache();
        UnifiedCache cache = CreateCache(memory, Substitute.For<IDatabase>());

        await using (await cache.AcquireSingleFlightAsync(CachePolicyId.ArticleListFrame, "article:list:memory-owner"))
        {
            Assert.Equal(1, GetSingleFlightEntryCount(cache));
            Assert.Empty(memory.CreatedKeys);
        }

        Assert.Equal(0, GetSingleFlightEntryCount(cache));
        Assert.Empty(memory.CreatedKeys);
    }

    [Fact]
    public async Task AcquireSingleFlightAsync_SourceBacksOffAndConditionallyRemovesRetiredEntry()
    {
        using var memory = new MemoryCache(new MemoryCacheOptions());
        UnifiedCache cache = CreateCache(memory, Substitute.For<IDatabase>());
        Task[] contenders = Enumerable.Range(0, 64).Select(async _ =>
        {
            await using IAsyncDisposable lease = await cache.AcquireSingleFlightAsync(
                CachePolicyId.ArticleListFrame,
                "article:list:contended");
            await Task.Yield();
        }).ToArray();

        await Task.WhenAll(contenders).WaitAsync(TimeSpan.FromSeconds(10));
        Assert.Equal(0, GetSingleFlightEntryCount(cache));
    }

    [Fact]
    public async Task SingleFlightEntry_SourceUsesInterlockedReferenceCounting()
    {
        var entry = new UnifiedCache.SingleFlightEntry();
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        const int Contenders = 64;
        var acquired = new CountdownEvent(Contenders);
        Task[] holders = Enumerable.Range(0, Contenders).Select(async _ =>
        {
            Assert.True(entry.TryAddReference());
            acquired.Signal();
            await release.Task;
            entry.ReleaseReference();
        }).ToArray();
        Assert.True(acquired.Wait(TimeSpan.FromSeconds(5)));

        entry.MarkRetired();
        Assert.False(entry.TryAddReference());
        await entry.Semaphore.WaitAsync();
        entry.Semaphore.Release();
        release.SetResult();
        await Task.WhenAll(holders);
        await Assert.ThrowsAsync<ObjectDisposedException>(async () => await entry.Semaphore.WaitAsync());
    }

    private static CachePolicy AssertPolicy(CachePolicyRegistry registry, CachePolicyId policyId)
    {
        Assert.True(registry.TryGet(policyId, out CachePolicy policy));
        return policy;
    }

    private static UnifiedCache CreateCache(
        IMemoryCache memory,
        IDatabase db,
        IRuntimeKeyScope? keyScope = null,
        ICachePolicyRegistry? policyRegistry = null)
    {
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(db);
        return new UnifiedCache(
            memory,
            redis,
            policyRegistry ?? new CachePolicyRegistry(),
            keyScope ?? new DefaultRuntimeKeyScope(),
            NullLogger<UnifiedCache>.Instance);
    }

    private sealed class FixedPolicyRegistry(CachePolicy policy) : ICachePolicyRegistry
    {
        public bool TryGet(CachePolicyId id, out CachePolicy resolved)
        {
            resolved = policy;
            return id == policy.Id;
        }
    }

    private sealed class CountingRuntimeKeyScope(string prefix, string scopeToken) : IRuntimeKeyScope
    {
        public int PrefixKeyCalls
        {
            get; private set;
        }
        public string ScopeToken => scopeToken;

        public string PrefixKey(string key)
        {
            PrefixKeyCalls++;
            return string.Concat(prefix, key);
        }

        public void Reset() => PrefixKeyCalls = 0;
    }

    private static int GetSingleFlightEntryCount(UnifiedCache cache)
    {
        var field = typeof(UnifiedCache).GetField("_singleFlightEntries", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic);
        Assert.NotNull(field);
        var entries = Assert.IsType<ConcurrentDictionary<string, UnifiedCache.SingleFlightEntry>>(field.GetValue(cache));
        return entries.Count;
    }

    private sealed class RemoveTrackingMemoryCache : IMemoryCache
    {
        public bool Removed
        {
            get; private set;
        }
        public object? RemovedKey
        {
            get; private set;
        }
        public List<object> RemovedKeys { get; } = [];
        public List<object> CreatedKeys { get; } = [];

        public bool TryGetValue(object key, out object? value)
        {
            value = null;
            return false;
        }

        public ICacheEntry CreateEntry(object key)
        {
            CreatedKeys.Add(key);
            return new TestCacheEntry(key);
        }

        public void Remove(object key)
        {
            Removed = true;
            RemovedKey = key;
            RemovedKeys.Add(key);
        }

        public void Dispose()
        {
        }
    }

    private sealed class TestCacheEntry(object key) : ICacheEntry
    {
        public object Key { get; } = key;
        public object? Value
        {
            get; set;
        }
        public DateTimeOffset? AbsoluteExpiration
        {
            get; set;
        }
        public TimeSpan? AbsoluteExpirationRelativeToNow
        {
            get; set;
        }
        public TimeSpan? SlidingExpiration
        {
            get; set;
        }
        public IList<IChangeToken> ExpirationTokens { get; } = new List<IChangeToken>();
        public IList<PostEvictionCallbackRegistration> PostEvictionCallbacks { get; } = new List<PostEvictionCallbackRegistration>();
        public CacheItemPriority Priority
        {
            get; set;
        }
        public long? Size
        {
            get; set;
        }

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
