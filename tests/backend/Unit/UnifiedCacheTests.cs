using System.Collections.Concurrent;
using FsusBlog.Server.Infrastructure.Cache;
using System.Text;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Primitives;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using StackExchange.Redis;
using FsusBlog.Server.Tests.TestInfrastructure;

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
        Assert.NotNull(capturedScript);
        Assert.Contains("redis.call('DEL'", capturedScript, StringComparison.Ordinal);
        Assert.Contains("redis.call('SREM'", capturedScript, StringComparison.Ordinal);
        Assert.NotNull(capturedKeys);
        Assert.Equal(UnifiedCache.BuildRegistryKeyForTests(CachePolicyId.CommentCursor), capturedKeys[0].ToString());
        Assert.True(ContainsAll(capturedKeys, firstKey, secondKey));
        Assert.NotNull(capturedValues);
        Assert.Empty(capturedValues);
        await db.DidNotReceive().KeyDeleteAsync(Arg.Any<RedisKey[]>(), Arg.Any<CommandFlags>());
        await db.DidNotReceive().SetRemoveAsync(Arg.Any<RedisKey>(), Arg.Any<RedisValue[]>(), Arg.Any<CommandFlags>());
    }

    [Fact]
    public void RemoveManyAsync_SourceUsesSingleLuaScriptForDeleteAndRegistryRemoval()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Infrastructure/Cache/IUnifiedCache.cs"));
        string method = ExtractMethodBlock(source, "public async Task RemoveManyAsync");
        string helper = ExtractMethodBlock(source, "private async Task<int> DeleteKeysAndRegistryMembersAtomicAsync");

        Assert.Contains("DeleteKeysAndRegistryMembersAtomicAsync", method, StringComparison.Ordinal);
        Assert.Contains("ScriptEvaluateAsync", helper, StringComparison.Ordinal);
        Assert.Contains("DeleteKeysAndRegistryMembersScript", helper, StringComparison.Ordinal);
        Assert.DoesNotContain("KeyDeleteAsync(redisKeys.ToArray())", method, StringComparison.Ordinal);
        Assert.DoesNotContain("SetRemoveAsync(ResolveRegistryKey(policyId), members.ToArray())", method, StringComparison.Ordinal);
    }

    [Fact]
    public void RemoveByPrefixMany_SourceGroupsByPolicyAndScansRegistryOnce()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Infrastructure/Cache/IUnifiedCache.cs"));

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
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Infrastructure/Cache/IUnifiedCache.cs"));

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
    public void AcquireSingleFlightAsync_DoesNotUseMemoryCacheEvictionForSingleFlight()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src", "backend", "Infrastructure", "Cache", "IUnifiedCache.cs"));
        string method = ExtractMethodBlock(source, "public async Task<IAsyncDisposable> AcquireSingleFlightAsync");

        Assert.DoesNotContain("memoryCache.GetOrCreate(lockKey", method, StringComparison.Ordinal);
        Assert.DoesNotContain("RegisterPostEvictionCallback", method, StringComparison.Ordinal);
        Assert.Contains("_singleFlightEntries.GetOrAdd", method, StringComparison.Ordinal);
    }

    [Fact]
    public void AcquireSingleFlightAsync_SourceBacksOffAndConditionallyRemovesRetiredEntry()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src", "backend", "Infrastructure", "Cache", "IUnifiedCache.cs"));
        string method = ExtractMethodBlock(source, "public async Task<IAsyncDisposable> AcquireSingleFlightAsync");

        Assert.Contains("await Task.Yield()", method, StringComparison.Ordinal);
        Assert.Contains("singleFlight.TryRetireIfIdle()", method, StringComparison.Ordinal);
        Assert.DoesNotContain("_singleFlightEntries.TryRemove(new KeyValuePair<string, SingleFlightEntry>(lockKey, singleFlight));\n                continue;", method, StringComparison.Ordinal);
    }

    [Fact]
    public void SingleFlightEntry_SourceUsesInterlockedReferenceCounting()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src", "backend", "Infrastructure", "Cache", "IUnifiedCache.cs"));
        string type = ExtractTypeBlock(source, "internal sealed class SingleFlightEntry");

        Assert.Contains("Interlocked.CompareExchange(ref _referenceCount", type, StringComparison.Ordinal);
        Assert.Contains("Volatile.Read(ref _referenceCount)", type, StringComparison.Ordinal);
        Assert.DoesNotContain("lock (_sync)", type, StringComparison.Ordinal);
    }

    private static string ExtractMethodBlock(string source, string signature)
    {
        int start = source.IndexOf(signature, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Unable to locate method signature: {signature}");
        int braceStart = source.IndexOf('{', start);
        Assert.True(braceStart > start, $"Unable to locate method body: {signature}");

        int depth = 0;
        for (int i = braceStart; i < source.Length; i++)
        {
            if (source[i] == '{')
            {
                depth++;
            }
            else if (source[i] == '}')
            {
                depth--;
                if (depth == 0)
                {
                    return source[start..(i + 1)];
                }
            }
        }

        throw new InvalidOperationException($"Unable to extract method body: {signature}");
    }

    private static string ExtractTypeBlock(string source, string signature)
        => ExtractMethodBlock(source, signature);

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

    private static int GetSingleFlightEntryCount(UnifiedCache cache)
    {
        var field = typeof(UnifiedCache).GetField("_singleFlightEntries", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic);
        Assert.NotNull(field);
        var entries = Assert.IsType<ConcurrentDictionary<string, UnifiedCache.SingleFlightEntry>>(field.GetValue(cache));
        return entries.Count;
    }

    private sealed class RemoveTrackingMemoryCache : IMemoryCache
    {
        public bool Removed { get; private set; }
        public object? RemovedKey { get; private set; }
        public List<object> RemovedKeys { get; } = [];

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
            RemovedKeys.Add(key);
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
