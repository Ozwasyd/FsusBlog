using FsusBlog.Server.Infrastructure.Cache;

using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using StackExchange.Redis;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PolicyShardedCacheL1StoreTests
{
    [Theory]
    [InlineData(1024)]
    [InlineData(64 * 1024)]
    [InlineData(84_999)]
    [InlineData(85_000)]
    [InlineData(85_001)]
    public void SetTransfersExactlyOnePayloadAcrossSmallAndLohBoundaries(int length)
    {
        CachePolicy policy = Policy(CachePolicyId.ArticleDetail, maxEntries: 8, maxBytes: 256 * 1024);
        using var store = new PolicyShardedCacheL1Store(new FixedRegistry(policy));
        byte[] payload = new byte[length];
        CacheL1Key key = Key(policy.Id, length.ToString(System.Globalization.CultureInfo.InvariantCulture));

        Assert.True(store.TrySetOwned(policy, key, policy.BuildKey(length), payload));
        Assert.True(store.TryAcquire(key, out PolicyShardedCacheL1Store.CacheL1ReadLease lease));
        using (lease)
        {
            Assert.False(System.Runtime.InteropServices.MemoryMarshal.TryGetArray(lease.Memory, out _));
            Assert.Equal(payload, lease.Memory.ToArray());
        }
        CacheL1PolicyResidencySnapshot snapshot = Assert.Single(store.SnapshotPolicyResidency());
        Assert.Equal(length, snapshot.LogicalBytes);
        Assert.Equal(
            PolicyShardedCacheL1Store.MeasureCapacityBytes(key, policy.BuildKey(length), payload),
            snapshot.CapacityBytes);
    }

    [Fact]
    public void SetHitReplaceOversizeAndHighCardinalityRemainWithinAllBudgets()
    {
        CachePolicy article = Policy(CachePolicyId.ArticleDetail, maxEntries: 64, maxBytes: 128);
        using var store = new PolicyShardedCacheL1Store(new FixedRegistry(article));
        byte[] first = [1, 2, 3];
        CacheL1Key firstKey = Key(article.Id, "first");

        Assert.True(store.TrySetOwned(article, firstKey, article.BuildKey("first"), first));
        Assert.True(store.TryAcquire(firstKey, out PolicyShardedCacheL1Store.CacheL1ReadLease lease));
        using (lease)
        {
            Assert.False(System.Runtime.InteropServices.MemoryMarshal.TryGetArray(lease.Memory, out _));
            Assert.Equal(first, lease.Memory.ToArray());
        }
        Assert.True(store.TrySetOwned(article, firstKey, article.BuildKey("first"), [3, 2, 1]));

        byte[] oversize = new byte[129];
        oversize.AsSpan().Fill(0x7f);
        Assert.False(store.TrySetOwned(article, Key(article.Id, "oversize"), article.BuildKey("oversize"), oversize));
        Assert.All(oversize, static value => Assert.Equal(0x7f, value));

        for (int index = 0; index < 100_000; index++)
        {
            byte[] payload = [(byte)index];
            Assert.True(store.TrySetOwned(article, Key(article.Id, $"key-{index}"), article.BuildKey($"key-{index}"), payload));
        }

        CacheL1PolicyResidencySnapshot snapshot = Assert.Single(store.SnapshotPolicyResidency());
        Assert.InRange(snapshot.Entries, 0, snapshot.MaxEntries);
        Assert.InRange(snapshot.LogicalBytes, 0, snapshot.MaxLogicalBytes);
        Assert.InRange(snapshot.CapacityBytes, 0, snapshot.MaxCapacityBytes);
        Assert.True(snapshot.CapacityEvictions > 0);
        Assert.True(snapshot.ReplacedEvictions > 0);
        Assert.Equal(1, snapshot.AdmissionRejects);
    }

    [Fact]
    public void ContinuousOverwriteKeepsSingleResidentOwnerWithinBudget()
    {
        CachePolicy policy = Policy(CachePolicyId.ArticleDetail, maxEntries: 2, maxBytes: 64);
        using var store = new PolicyShardedCacheL1Store(new FixedRegistry(policy));
        CacheL1Key key = Key(policy.Id, "same");

        for (int index = 0; index < 100_000; index++)
        {
            Assert.True(store.TrySetOwned(policy, key, policy.BuildKey("same"), [(byte)index]));
        }

        CacheL1PolicyResidencySnapshot snapshot = Assert.Single(store.SnapshotPolicyResidency());
        Assert.Equal(1, snapshot.Entries);
        Assert.Equal(1, snapshot.LogicalBytes);
        Assert.Equal(
            PolicyShardedCacheL1Store.MeasureCapacityBytes(key, policy.BuildKey("same"), [0]),
            snapshot.CapacityBytes);
        Assert.Equal(99_999, snapshot.ReplacedEvictions);
    }

    [Fact]
    public void TtlAndExactInvalidationAffectOnlyTheTargetPartition()
    {
        var time = new ManualTimeProvider();
        CachePolicy article = Policy(CachePolicyId.ArticleDetail, maxEntries: 8, maxBytes: 64);
        CachePolicy seo = Policy(CachePolicyId.SystemSeo, maxEntries: 8, maxBytes: 64);
        using var store = new PolicyShardedCacheL1Store(new FixedRegistry(article, seo), time);
        CacheL1Key articleKey = Key(article.Id, "42");
        CacheL1Key seoKey = Key(seo.Id, "main");
        Assert.True(store.TrySetOwned(article, articleKey, article.BuildKey("42"), [4, 2]));
        Assert.True(store.TrySetOwned(seo, seoKey, seo.BuildKey("main"), [9]));

        CacheL1InvalidationReceipt receipt = store.InvalidateLocal([new(article.Id, "42")]);

        Assert.Equal(1, receipt.EntryCount);
        Assert.False(store.TryGet(articleKey, out _));
        Assert.True(store.TryGet(seoKey, out _));
        time.Advance(TimeSpan.FromMinutes(2));
        Assert.False(store.TryGet(seoKey, out _));
        CacheL1PolicyResidencySnapshot seoSnapshot = store.SnapshotPolicyResidency().Single(item => item.PolicyId == seo.Id);
        Assert.Equal(1, seoSnapshot.ExpiredEvictions);
        CacheL1PolicyResidencySnapshot articleSnapshot = store.SnapshotPolicyResidency().Single(item => item.PolicyId == article.Id);
        Assert.Equal(1, articleSnapshot.InvalidatedEvictions);
    }

    [Fact]
    public void VersionedGenerationInvalidationRemovesOnlyExactGeneration()
    {
        CachePolicy policy = Policy(CachePolicyId.ArticleDetail, maxEntries: 4, maxBytes: 64);
        using var store = new PolicyShardedCacheL1Store(new FixedRegistry(policy));
        CacheL1Key first = CacheL1Key.ForString("default", policy.Id, "42", "v1");
        CacheL1Key second = CacheL1Key.ForString("default", policy.Id, "42", "v2");
        Assert.True(store.TrySetOwned(policy, first, policy.BuildKey("42", "v1"), [1]));
        Assert.True(store.TrySetOwned(policy, second, policy.BuildKey("42", "v2"), [2]));

        CacheL1InvalidationReceipt receipt = store.InvalidateLocal([new(policy.Id, "42", "v1")]);

        Assert.Equal(1, receipt.EntryCount);
        Assert.False(store.TryGet(first, out _));
        Assert.True(store.TryGet(second, out byte[] survivor));
        Assert.Equal(new byte[] { 2 }, survivor);
    }

    [Fact]
    public void NonDefaultScopeInvalidationRemovesOnlyMatchingScopedIdentity()
    {
        CachePolicy policy = Policy(CachePolicyId.ArticleDetail, maxEntries: 4, maxBytes: 64);
        var scope = new TestRuntimeKeyScope("tenant-a");
        using var store = new PolicyShardedCacheL1Store(new FixedRegistry(policy), scope);
        CacheL1Key scoped = CacheL1Key.ForString(scope.ScopeToken, policy.Id, "42");
        CacheL1Key misleadingDefault = CacheL1Key.ForString("default", policy.Id, "42");
        Assert.True(store.TrySetOwned(policy, scoped, policy.BuildKey("42"), [1]));

        CacheL1InvalidationReceipt receipt = store.InvalidateLocal([new(policy.Id, "42")]);

        Assert.Equal(1, receipt.EntryCount);
        Assert.False(store.TryGet(scoped, out _));
        Assert.False(store.TryGet(misleadingDefault, out _));
    }

    [Fact]
    public void RedisKeyRoutingInvalidationDoesNotTraverseOrMutateUnrelatedPolicy()
    {
        CachePolicy article = Policy(CachePolicyId.ArticleDetail, maxEntries: 4, maxBytes: 64);
        CachePolicy seo = Policy(CachePolicyId.SystemSeo, maxEntries: 4, maxBytes: 64);
        using var store = new PolicyShardedCacheL1Store(new FixedRegistry(article, seo));
        CacheL1Key articleKey = Key(article.Id, "42");
        CacheL1Key seoKey = Key(seo.Id, "main");
        string articleRedisKey = article.BuildKey("42");
        Assert.True(store.TrySetOwned(article, articleKey, articleRedisKey, [1]));
        Assert.True(store.TrySetOwned(seo, seoKey, seo.BuildKey("main"), [2]));
        CacheL1PolicyResidencySnapshot before = store.SnapshotPolicyResidency().Single(item => item.PolicyId == seo.Id);

        store.RemoveByRedisKey(articleRedisKey);

        CacheL1PolicyResidencySnapshot after = store.SnapshotPolicyResidency().Single(item => item.PolicyId == seo.Id);
        Assert.False(store.TryGet(articleKey, out _));
        Assert.True(store.TryGet(seoKey, out _));
        Assert.Equal(before.Entries, after.Entries);
        Assert.Equal(before.LogicalBytes, after.LogicalBytes);
        Assert.Equal(before.CapacityBytes, after.CapacityBytes);
        Assert.Equal(before.InvalidatedEvictions, after.InvalidatedEvictions);
    }

    [Fact]
    public void SensitiveReplaceEvictAndShutdownClearEveryOwnedBacking()
    {
        CachePolicy policy = Policy(
            CachePolicyId.SecurityBlockedUser,
            maxEntries: 1,
            maxBytes: 16,
            securityCritical: true);
        var store = new PolicyShardedCacheL1Store(new FixedRegistry(policy));
        byte[] replaced = [1, 2, 3];
        byte[] evicted = [4, 5, 6];
        byte[] shutdown = [7, 8, 9];
        CacheL1Key key = Key(policy.Id, "account");

        Assert.True(store.TrySetOwned(policy, key, policy.BuildKey("account"), replaced));
        Assert.True(store.TrySetOwned(policy, key, policy.BuildKey("account"), evicted));
        Assert.All(replaced, static value => Assert.Equal(0, value));
        Assert.True(store.TrySetOwned(policy, Key(policy.Id, "other"), policy.BuildKey("other"), shutdown));
        Assert.All(evicted, static value => Assert.Equal(0, value));

        store.Dispose();

        Assert.All(shutdown, static value => Assert.Equal(0, value));
    }

    [Fact]
    public void Shutdown_DefersSensitiveClearUntilActiveLeaseReturns()
    {
        CachePolicy policy = Policy(
            CachePolicyId.SecurityBlockedUser,
            maxEntries: 1,
            maxBytes: 16,
            securityCritical: true);
        var store = new PolicyShardedCacheL1Store(new FixedRegistry(policy));
        byte[] payload = [7, 8, 9];
        CacheL1Key key = Key(policy.Id, "account");
        Assert.True(store.TrySetOwned(policy, key, policy.BuildKey("account"), payload));
        Assert.True(store.TryAcquire(key, out PolicyShardedCacheL1Store.CacheL1ReadLease lease));

        store.Dispose();

        Assert.Equal(new byte[] { 7, 8, 9 }, lease.Memory.ToArray());
        Assert.Equal(new byte[] { 7, 8, 9 }, payload);
        lease.Dispose();
        Assert.All(payload, static value => Assert.Equal(0, value));
    }

    [Fact]
    public void SensitiveBacking_IsClearedOnlyAfterLastReadonlyLeaseReturns()
    {
        CachePolicy policy = Policy(
            CachePolicyId.SecurityBlockedUser,
            maxEntries: 1,
            maxBytes: 16,
            securityCritical: true);
        using var store = new PolicyShardedCacheL1Store(new FixedRegistry(policy));
        byte[] payload = [1, 2, 3];
        CacheL1Key key = Key(policy.Id, "account");
        Assert.True(store.TrySetOwned(policy, key, policy.BuildKey("account"), payload));
        Assert.True(store.TryAcquire(key, out PolicyShardedCacheL1Store.CacheL1ReadLease lease));

        CacheL1InvalidationPolicyReceipt removed = store.Remove(key);

        Assert.Equal(1, removed.EntryCount);
        Assert.Equal(new byte[] { 1, 2, 3 }, lease.Memory.ToArray());
        Assert.Equal(new byte[] { 1, 2, 3 }, payload);
        lease.Dispose();
        Assert.All(payload, static value => Assert.Equal(0, value));
    }

    [Fact]
    public void ReleasedLeaseInvalidatesCapturedMemoryAndNeverExposesArrayBacking()
    {
        CachePolicy policy = Policy(CachePolicyId.ArticleDetail, maxEntries: 1, maxBytes: 16);
        using var store = new PolicyShardedCacheL1Store(new FixedRegistry(policy));
        CacheL1Key key = Key(policy.Id, "42");
        Assert.True(store.TrySetOwned(policy, key, policy.BuildKey("42"), [1, 2, 3]));
        Assert.True(store.TryAcquire(key, out PolicyShardedCacheL1Store.CacheL1ReadLease lease));
        ReadOnlyMemory<byte> captured = lease.Memory;

        Assert.False(System.Runtime.InteropServices.MemoryMarshal.TryGetArray(captured, out _));
        lease.Dispose();

        Assert.Throws<ObjectDisposedException>(() => lease.Memory.ToArray());
        Assert.Throws<ObjectDisposedException>(() => captured.ToArray());
    }

    [Fact]
    public void PinnedLeaseDefersSensitiveReleaseButCapturedMemoryStillExpiresWithLease()
    {
        CachePolicy policy = Policy(
            CachePolicyId.SecurityBlockedUser,
            maxEntries: 1,
            maxBytes: 16,
            securityCritical: true);
        using var store = new PolicyShardedCacheL1Store(new FixedRegistry(policy));
        byte[] payload = [1, 2, 3];
        CacheL1Key key = Key(policy.Id, "account");
        Assert.True(store.TrySetOwned(policy, key, policy.BuildKey("account"), payload));
        Assert.True(store.TryAcquire(key, out PolicyShardedCacheL1Store.CacheL1ReadLease lease));
        ReadOnlyMemory<byte> captured = lease.Memory;
        System.Buffers.MemoryHandle handle = captured.Pin();

        Assert.Equal(1, store.Remove(key).EntryCount);
        lease.Dispose();

        Assert.Equal(new byte[] { 1, 2, 3 }, payload);
        Assert.Throws<ObjectDisposedException>(() => captured.ToArray());
        handle.Dispose();
        Assert.All(payload, static value => Assert.Equal(0, value));
    }

    [Fact]
    public void ReadLeaseHitAllocationStaysWithinExplicitFixedBudget()
    {
        const int Iterations = 50_000;
        CachePolicy policy = Policy(CachePolicyId.ArticleDetail, maxEntries: 1, maxBytes: 16);
        using var store = new PolicyShardedCacheL1Store(new FixedRegistry(policy));
        CacheL1Key key = Key(policy.Id, "42");
        Assert.True(store.TrySetOwned(policy, key, policy.BuildKey("42"), [1, 2, 3]));

        for (int index = 0; index < 1_000; index++)
        {
            if (!store.TryAcquire(key, out PolicyShardedCacheL1Store.CacheL1ReadLease warmupLease))
            {
                throw new InvalidOperationException("cache_l1_warmup_miss");
            }

            warmupLease.Dispose();
        }

        long before = GC.GetAllocatedBytesForCurrentThread();
        long observedLength = 0;
        for (int index = 0; index < Iterations; index++)
        {
            if (!store.TryAcquire(key, out PolicyShardedCacheL1Store.CacheL1ReadLease lease))
            {
                throw new InvalidOperationException("cache_l1_measured_miss");
            }

            observedLength += lease.Memory.Length;
            lease.Dispose();
        }

        long allocatedBytes = GC.GetAllocatedBytesForCurrentThread() - before;
        long allocatedBytesPerHit = allocatedBytes / Iterations;
        Assert.Equal(Iterations * 3L, observedLength);
        Assert.InRange(
            allocatedBytesPerHit,
            0,
            PolicyShardedCacheL1Store.ReadLeaseAllocationBudgetBytes);
    }

    [Fact]
    public void ReplacingSameBacking_DoesNotClearNewOwnerWhenOldLeaseReturns()
    {
        CachePolicy policy = Policy(
            CachePolicyId.SecurityBlockedUser,
            maxEntries: 1,
            maxBytes: 16,
            securityCritical: true);
        using var store = new PolicyShardedCacheL1Store(new FixedRegistry(policy));
        byte[] payload = [4, 5, 6];
        CacheL1Key key = Key(policy.Id, "account");
        Assert.True(store.TrySetOwned(policy, key, policy.BuildKey("account"), payload));
        Assert.True(store.TryAcquire(key, out PolicyShardedCacheL1Store.CacheL1ReadLease oldLease));

        Assert.True(store.TrySetOwned(policy, key, policy.BuildKey("account"), payload));
        oldLease.Dispose();

        Assert.Equal(new byte[] { 4, 5, 6 }, payload);
        Assert.True(store.TryAcquire(key, out PolicyShardedCacheL1Store.CacheL1ReadLease currentLease));
        currentLease.Dispose();
    }

    [Fact]
    public async Task TypedDecoderException_ReleasesSensitiveReadonlyLease()
    {
        CachePolicy policy = Policy(
            CachePolicyId.SecurityBlockedUser,
            maxEntries: 1,
            maxBytes: 16,
            securityCritical: true);
        var policies = new FixedRegistry(policy);
        var scope = new DefaultRuntimeKeyScope();
        var resolver = new CacheKeyResolver(policies, scope, NullLogger<CacheKeyResolver>.Instance);
        var store = new PolicyShardedCacheL1Store(policies);
        using var memory = new MemoryCache(new MemoryCacheOptions());
        var database = Substitute.For<IDatabase>();
        var redis = Substitute.For<IConnectionMultiplexer>();
        redis.GetDatabase(Arg.Any<int>(), Arg.Any<object?>()).Returns(database);
        using var cache = new UnifiedCache(
            memory,
            store,
            redis,
            policies,
            scope,
            resolver,
            new CacheSingleFlightCoordinator(resolver),
            new CacheTelemetry(),
            NullLogger<UnifiedCache>.Instance);
        byte[] payload = [1, 2, 3];
        CacheL1Key key = CacheL1Key.ForString(scope.ScopeToken, policy.Id, "account");
        Assert.True(store.TrySetOwned(policy, key, resolver.BuildKey(policy.Id, "account"), payload));

        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => cache.TryGetAsync<object>(
            policy.Id,
            "account",
            static _ => throw new InvalidOperationException("decoder_must_not_run"),
            cancellation.Token));

        await Assert.ThrowsAsync<InvalidOperationException>(() => cache.TryGetAsync<object>(
            policy.Id,
            "account",
            static _ => throw new InvalidOperationException("decode_failed")));

        Assert.Equal(1, store.Remove(key).EntryCount);
        Assert.All(payload, static value => Assert.Equal(0, value));
    }

    [Fact]
    public async Task DistinctPoliciesUseIndependentMutationGatesAndStayBoundedUnderConcurrency()
    {
        CachePolicy article = Policy(CachePolicyId.ArticleDetail, maxEntries: 256, maxBytes: 4096);
        CachePolicy seo = Policy(CachePolicyId.SystemSeo, maxEntries: 256, maxBytes: 4096);
        using var store = new PolicyShardedCacheL1Store(new FixedRegistry(article, seo));

        await Task.WhenAll(
            WriteManyAsync(store, article, 20_000),
            WriteManyAsync(store, seo, 20_000));

        CacheL1PolicyResidencySnapshot[] snapshots = store.SnapshotPolicyResidency().ToArray();
        Assert.Equal(2, snapshots.Length);
        Assert.All(snapshots, static snapshot =>
        {
            Assert.InRange(snapshot.Entries, 0, snapshot.MaxEntries);
            Assert.InRange(snapshot.LogicalBytes, 0, snapshot.MaxLogicalBytes);
            Assert.InRange(snapshot.CapacityBytes, 0, snapshot.MaxCapacityBytes);
        });
        Assert.DoesNotContain(
            typeof(PolicyShardedCacheL1Store).GetFields(System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic),
            static field => field.Name.Contains("mutationLock", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task BlockedArticlePartitionDoesNotDelaySeoPartitionWrite()
    {
        CachePolicy article = Policy(CachePolicyId.ArticleDetail, maxEntries: 8, maxBytes: 256);
        CachePolicy seo = Policy(CachePolicyId.SystemSeo, maxEntries: 8, maxBytes: 256);
        using var store = new PolicyShardedCacheL1Store(new FixedRegistry(article, seo));
        var partitions = (PolicyShardedCacheL1Store.Partition?[])typeof(PolicyShardedCacheL1Store)
            .GetField("_partitions", System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!
            .GetValue(store)!;
        object articleGate = partitions[(int)article.Id]!.Gate;
        using var entered = new ManualResetEventSlim(false);
        using var release = new ManualResetEventSlim(false);
        Task blocker = Task.Run(() =>
        {
            lock (articleGate)
            {
                entered.Set();
                release.Wait();
            }
        });
        Assert.True(entered.Wait(TimeSpan.FromSeconds(2)));

        Task<bool> independentWrite = Task.Run(() => store.TrySetOwned(
            seo,
            Key(seo.Id, "main"),
            seo.BuildKey("main"),
            [1, 2, 3]));
        Task winner = await Task.WhenAny(independentWrite, Task.Delay(TimeSpan.FromMilliseconds(500)));

        release.Set();
        await blocker;
        Assert.Same(independentWrite, winner);
        Assert.True(await independentWrite);
    }

    [Fact]
    public void EffectivePolicyCapacitySumDoesNotExceedGcDerivedGlobalBudget()
    {
        var registry = new CachePolicyRegistry();
        using var store = new PolicyShardedCacheL1Store(registry);
        long configured = store.SnapshotPolicyResidency().Sum(static item => item.MaxCapacityBytes);
        long available = Math.Max(1L, GC.GetGCMemoryInfo().TotalAvailableMemoryBytes);
        long globalBudget = Math.Max(1L, Math.Min(256L * 1024 * 1024, available / 20));

        Assert.InRange(configured, 1, globalBudget);
    }

    private static Task WriteManyAsync(PolicyShardedCacheL1Store store, CachePolicy policy, int count)
        => Task.Run(() =>
        {
            for (int index = 0; index < count; index++)
            {
                string identity = index.ToString(System.Globalization.CultureInfo.InvariantCulture);
                Assert.True(store.TrySetOwned(policy, Key(policy.Id, identity), policy.BuildKey(identity), new byte[16]));
            }
        });

    private static CachePolicy Policy(
        CachePolicyId id,
        int maxEntries,
        long maxBytes,
        bool securityCritical = false)
        => new(
            id,
            "test",
            id.ToString(),
            TimeSpan.FromMinutes(1),
            TimeSpan.FromMinutes(5),
            SecurityCritical: securityCritical,
            L1MaxEntries: maxEntries,
            L1MaxLogicalBytes: maxBytes,
            L1MaxCapacityBytes: checked(maxBytes + (maxEntries * 512L)));

    private static CacheL1Key Key(CachePolicyId policyId, string identity)
        => CacheL1Key.ForString("default", policyId, identity);

    private sealed class FixedRegistry(params CachePolicy[] policies) : ICachePolicyRegistry
    {
        private readonly IReadOnlyDictionary<CachePolicyId, CachePolicy> _policies =
            policies.ToDictionary(static policy => policy.Id);

        public bool TryGet(CachePolicyId id, out CachePolicy policy)
            => _policies.TryGetValue(id, out policy!);
    }

    private sealed class ManualTimeProvider : TimeProvider
    {
        private long _timestamp;

        public override long TimestampFrequency => TimeSpan.TicksPerSecond;

        public override long GetTimestamp() => Volatile.Read(ref _timestamp);

        internal void Advance(TimeSpan elapsed)
            => Interlocked.Add(ref _timestamp, elapsed.Ticks);
    }

    private sealed class TestRuntimeKeyScope(string scopeToken) : IRuntimeKeyScope
    {
        public string ScopeToken { get; } = scopeToken;

        public string PrefixKey(string key) => string.Concat(ScopeToken, ':', key);
    }
}
