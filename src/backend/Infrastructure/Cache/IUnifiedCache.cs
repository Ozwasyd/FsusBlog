using System.Diagnostics;
using Microsoft.Extensions.Caching.Memory;
using StackExchange.Redis;
using System.Net;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Observability;

namespace FsusBlog.Server.Infrastructure.Cache;

public readonly record struct CacheReadResult<T>(bool Hit, T? Value);

public interface IUnifiedCache
    {
        Task<CacheReadResult<T>> TryGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default);
    /// <summary>
    /// Returns a caller-owned byte array. Callers may pass it to serializers or streams without retaining cache ownership;
    /// mutating the returned array must not mutate L1/L2 cache state.
    /// </summary>
    Task<CacheReadResult<byte[]>> TryGetRawAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default);
    /// <summary>
    /// Stores a defensive copy of <paramref name="value"/> so later caller mutations cannot corrupt cache state.
    /// </summary>
    Task SetRawAsync(CachePolicyId policyId, string identity, byte[] value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default);
    Task SetNegativeAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default);
    Task<string?> GetStringAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default);
    Task SetStringAsync(CachePolicyId policyId, string identity, string value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default);
    Task<long> IncrementAsync(CachePolicyId policyId, string identity, long value = 1, CancellationToken cancellationToken = default);
    Task<bool> TryAcquireLeaseAsync(CachePolicyId policyId, string identity, string value, TimeSpan ttl, CancellationToken cancellationToken = default);
    Task<bool> ConsumeOnceAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default);
    Task RemoveAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default);
    Task RemoveByPrefixAsync(CachePolicyId policyId, string identityPrefix, CancellationToken cancellationToken = default);
    Task<IAsyncDisposable> AcquireSingleFlightAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default);
    string BuildKey(CachePolicyId policyId, string identity, string? version = null);
}

public sealed class UnifiedCache(
    IMemoryCache memoryCache,
    IConnectionMultiplexer redis,
    ICachePolicyRegistry policyRegistry,
    IRuntimeKeyScope keyScope,
    ILogger<UnifiedCache> logger) : IUnifiedCache
    {
        private static readonly TimeSpan MissingPolicyL2Ttl = TimeSpan.FromMinutes(5);
        private const string RegistryKeyPrefix = "cache:registry:";
        private const int PrefixInvalidationBatchSize = 256;

    private readonly IConnectionMultiplexer _redis = redis;
    private readonly IDatabase _db = redis.GetDatabase();

    public string BuildKey(CachePolicyId policyId, string identity, string? version = null)
    {
        return keyScope.PrefixKey(ResolvePolicy(policyId).BuildKey(identity, version));
    }

    public async Task<CacheReadResult<T>> TryGetAsync<T>(
        CachePolicyId policyId,
        string identity,
        Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder,
        CancellationToken cancellationToken = default)
    {
        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.get", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "get");
        FsusObservability.SetTag(activity, "fsus.cache.policy", policyId.ToString());
        string key = BuildKey(policyId, identity);
        if (memoryCache.TryGetValue(key, out byte[]? l1Bytes) && l1Bytes is not null)
        {
            if (l1Bytes.Length == 0)
            {
                FsusObservability.RecordCacheOperation("get", policyId.ToString(), "l1", "hit_negative", FsusObservability.GetElapsed(startedAt));
                return new CacheReadResult<T>(true, default);
            }

            var (l1Success, l1Value) = decoder(l1Bytes);
            if (l1Success)
            {
                FsusObservability.RecordCacheOperation("get", policyId.ToString(), "l1", "hit", FsusObservability.GetElapsed(startedAt));
                return new CacheReadResult<T>(true, l1Value);
            }

            memoryCache.Remove(key);
            await _db.KeyDeleteAsync(key).ConfigureAwait(false);
            await UnregisterKeyAsync(policyId, key).ConfigureAwait(false);
            FsusObservability.RecordCacheOperation("get", policyId.ToString(), "l1", "decode_failed", FsusObservability.GetElapsed(startedAt));
            return new CacheReadResult<T>(false, default);
        }

        RedisValue l2Value = await _db.StringGetAsync(key).ConfigureAwait(false);
        if (!l2Value.HasValue)
        {
            FsusObservability.RecordCacheOperation("get", policyId.ToString(), "l2", "miss", FsusObservability.GetElapsed(startedAt));
            return new CacheReadResult<T>(false, default);
        }

        byte[] bytes = (byte[])l2Value!;
        if (bytes.Length == 0)
        {
            SetL1(policyId, key, bytes);
            FsusObservability.RecordCacheOperation("get", policyId.ToString(), "l2", "hit_negative", FsusObservability.GetElapsed(startedAt));
            return new CacheReadResult<T>(true, default);
        }

        var (success, value) = decoder(bytes);
        if (!success)
        {
            await _db.KeyDeleteAsync(key).ConfigureAwait(false);
            await UnregisterKeyAsync(policyId, key).ConfigureAwait(false);
            FsusObservability.RecordCacheOperation("get", policyId.ToString(), "l2", "decode_failed", FsusObservability.GetElapsed(startedAt));
            return new CacheReadResult<T>(false, default);
        }

        SetL1(policyId, key, bytes);
        FsusObservability.RecordCacheOperation("get", policyId.ToString(), "l2", "hit", FsusObservability.GetElapsed(startedAt));
        return new CacheReadResult<T>(true, value);
    }

    public async Task<CacheReadResult<byte[]>> TryGetRawAsync(
        CachePolicyId policyId,
        string identity,
        CancellationToken cancellationToken = default)
    {
        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.get_raw", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "get_raw");
        FsusObservability.SetTag(activity, "fsus.cache.policy", policyId.ToString());
        string key = BuildKey(policyId, identity);
        if (memoryCache.TryGetValue(key, out byte[]? l1Bytes) && l1Bytes is not null)
        {
            FsusObservability.RecordCacheOperation("get_raw", policyId.ToString(), "l1", "hit", FsusObservability.GetElapsed(startedAt));
            return new CacheReadResult<byte[]>(true, CopyRawBytes(l1Bytes));
        }

        RedisValue l2Value = await _db.StringGetAsync(key).ConfigureAwait(false);
        if (!l2Value.HasValue)
        {
            FsusObservability.RecordCacheOperation("get_raw", policyId.ToString(), "l2", "miss", FsusObservability.GetElapsed(startedAt));
            return new CacheReadResult<byte[]>(false, default);
        }

        byte[] bytes = (byte[])l2Value!;
        SetL1(policyId, key, bytes);
        FsusObservability.RecordCacheOperation("get_raw", policyId.ToString(), "l2", "hit", FsusObservability.GetElapsed(startedAt));
        return new CacheReadResult<byte[]>(true, CopyRawBytes(bytes));
    }

    public async Task SetRawAsync(
        CachePolicyId policyId,
        string identity,
        byte[] value,
        TimeSpan? l2TtlOverride = null,
        CancellationToken cancellationToken = default)
    {
        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.set", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "set");
        FsusObservability.SetTag(activity, "fsus.cache.policy", policyId.ToString());
        string key = BuildKey(policyId, identity);
        CachePolicy policy = ResolvePolicy(policyId);
        TimeSpan l2Ttl = l2TtlOverride ?? ApplyDeterministicJitter(key, policy.L2Ttl, policy.L2JitterRatio);
        byte[] cachedValue = CopyRawBytes(value);
        await _db.StringSetAsync(key, cachedValue, l2Ttl).ConfigureAwait(false);
        await RegisterKeyAsync(policyId, key).ConfigureAwait(false);
        SetL1(policyId, key, cachedValue);
        FsusObservability.RecordCacheOperation("set", policyId.ToString(), "l2", "ok", FsusObservability.GetElapsed(startedAt));
    }

    public Task SetNegativeAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
        => SetNegativeCoreAsync(policyId, identity, cancellationToken);

    public async Task<string?> GetStringAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
    {
        CacheReadResult<string> read = await TryGetAsync<string>(policyId, identity, static bytes => (true, System.Text.Encoding.UTF8.GetString(bytes.Span)), cancellationToken);
        return read.Hit ? read.Value : null;
    }

    public async Task SetStringAsync(CachePolicyId policyId, string identity, string value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default)
    {
        await SetRawAsync(policyId, identity, System.Text.Encoding.UTF8.GetBytes(value), l2TtlOverride, cancellationToken);
    }

    public async Task<long> IncrementAsync(CachePolicyId policyId, string identity, long value = 1, CancellationToken cancellationToken = default)
    {
        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.increment", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "increment");
        FsusObservability.SetTag(activity, "fsus.cache.policy", policyId.ToString());
        string key = BuildKey(policyId, identity);
        long updated = await _db.StringIncrementAsync(key, value).ConfigureAwait(false);
        await RegisterKeyAsync(policyId, key).ConfigureAwait(false);
        memoryCache.Remove(key);
        FsusObservability.RecordCacheOperation("increment", policyId.ToString(), "l2", "ok", FsusObservability.GetElapsed(startedAt));
        return updated;
    }

    public async Task<bool> TryAcquireLeaseAsync(CachePolicyId policyId, string identity, string value, TimeSpan ttl, CancellationToken cancellationToken = default)
    {
        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.lease", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "lease");
        FsusObservability.SetTag(activity, "fsus.cache.policy", policyId.ToString());
        string key = BuildKey(policyId, identity);
        bool acquired = await _db.StringSetAsync(key, value, ttl, When.NotExists).ConfigureAwait(false);
        FsusObservability.RecordCacheOperation("lease", policyId.ToString(), "l2", acquired ? "acquired" : "contended", FsusObservability.GetElapsed(startedAt));
        return acquired;
    }

    public async Task<bool> ConsumeOnceAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
    {
        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.consume_once", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "consume_once");
        FsusObservability.SetTag(activity, "fsus.cache.policy", policyId.ToString());
        string key = BuildKey(policyId, identity);
        var tran = _db.CreateTransaction();
        _ = tran.AddCondition(Condition.KeyExists(key));
        _ = tran.KeyDeleteAsync(key);
        bool ok = await tran.ExecuteAsync().ConfigureAwait(false);
        if (ok)
        {
            memoryCache.Remove(key);
            await UnregisterKeyAsync(policyId, key).ConfigureAwait(false);
        }

        FsusObservability.RecordCacheOperation("consume_once", policyId.ToString(), "l2", ok ? "consumed" : "miss", FsusObservability.GetElapsed(startedAt));
        return ok;
    }

    public async Task RemoveAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
    {
        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.remove", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "remove");
        FsusObservability.SetTag(activity, "fsus.cache.policy", policyId.ToString());
        string key = BuildKey(policyId, identity);
        memoryCache.Remove(key);
        await _db.KeyDeleteAsync(key).ConfigureAwait(false);
        await UnregisterKeyAsync(policyId, key).ConfigureAwait(false);
        FsusObservability.RecordCacheOperation("remove", policyId.ToString(), "l2", "ok", FsusObservability.GetElapsed(startedAt));
    }

    public async Task RemoveByPrefixAsync(CachePolicyId policyId, string identityPrefix, CancellationToken cancellationToken = default)
    {
        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.remove_prefix", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "remove_prefix");
        FsusObservability.SetTag(activity, "fsus.cache.policy", policyId.ToString());
        CachePolicy policy = ResolvePolicy(policyId);
        string prefix = keyScope.PrefixKey(policy.BuildKey(identityPrefix));
        string registryKey = ResolveRegistryKey(policyId);
        bool registryExists = await _db.KeyExistsAsync(registryKey).ConfigureAwait(false);
        if (registryExists)
        {
            RedisValue[] registeredKeys = await _db.SetMembersAsync(registryKey).ConfigureAwait(false);
            await DeleteRegisteredKeysByPrefixAsync(registryKey, prefix, registeredKeys, cancellationToken).ConfigureAwait(false);
            FsusObservability.RecordCacheOperation("remove_prefix", policyId.ToString(), "l2", "ok", FsusObservability.GetElapsed(startedAt));

            return;
        }

        logger.LogWarning(
            "cache-prefix-invalidation-registry-missing {PolicyId} {IdentityPrefix}; using Redis keyspace scan fallback",
            policyId,
            identityPrefix);
        try
        {
            int recoveredKeys = await DeleteKeysByPrefixScanAsync(prefix, cancellationToken).ConfigureAwait(false);
            FsusObservability.RecordCacheOperation(
                "remove_prefix",
                policyId.ToString(),
                "l2",
                recoveredKeys > 0 ? "registry_missing_scan_recovered" : "registry_missing_scan_empty",
                FsusObservability.GetElapsed(startedAt));
        }
        catch (Exception ex)
        {
            logger.LogWarning(
                ex,
                "cache-prefix-invalidation-scan-failed {PolicyId} {IdentityPrefix}",
                policyId,
                identityPrefix);
            FsusObservability.RecordCacheOperation("remove_prefix", policyId.ToString(), "l2", "registry_missing_scan_failed", FsusObservability.GetElapsed(startedAt));
        }
    }

    private async Task DeleteRegisteredKeysByPrefixAsync(
        string registryKey,
        string prefix,
        ReadOnlyMemory<RedisValue> registeredKeys,
        CancellationToken cancellationToken)
    {
        List<RedisKey> deleteKeys = new(PrefixInvalidationBatchSize);
        List<RedisValue> registryMembers = new(PrefixInvalidationBatchSize);
        foreach (string value in FilterRegistryKeys(prefix, registeredKeys.Span))
        {
            cancellationToken.ThrowIfCancellationRequested();
            deleteKeys.Add(value);
            registryMembers.Add(value);
            memoryCache.Remove(value);

            if (deleteKeys.Count >= PrefixInvalidationBatchSize)
            {
                await FlushRegisteredDeleteBatchAsync(registryKey, deleteKeys, registryMembers).ConfigureAwait(false);
            }
        }

        if (deleteKeys.Count > 0)
        {
            await FlushRegisteredDeleteBatchAsync(registryKey, deleteKeys, registryMembers).ConfigureAwait(false);
        }
    }

    private async Task FlushRegisteredDeleteBatchAsync(
        string registryKey,
        List<RedisKey> deleteKeys,
        List<RedisValue> registryMembers)
    {
        await _db.KeyDeleteAsync(deleteKeys.ToArray()).ConfigureAwait(false);
        await _db.SetRemoveAsync(registryKey, registryMembers.ToArray()).ConfigureAwait(false);
        deleteKeys.Clear();
        registryMembers.Clear();
    }

    private async Task<int> DeleteKeysByPrefixScanAsync(string prefix, CancellationToken cancellationToken)
    {
        string pattern = prefix + "*";
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var deleteKeys = new List<RedisKey>(PrefixInvalidationBatchSize);
        int deleted = 0;

        foreach (EndPoint endpoint in _redis.GetEndPoints())
        {
            cancellationToken.ThrowIfCancellationRequested();
            IServer server = _redis.GetServer(endpoint);
            if (!server.IsConnected)
            {
                continue;
            }

            foreach (RedisKey key in server.Keys(_db.Database, pattern, pageSize: PrefixInvalidationBatchSize))
            {
                cancellationToken.ThrowIfCancellationRequested();
                string keyText = key.ToString();
                if (!seen.Add(keyText))
                {
                    continue;
                }

                deleteKeys.Add(key);
                memoryCache.Remove(keyText);

                if (deleteKeys.Count >= PrefixInvalidationBatchSize)
                {
                    deleted += await FlushScanDeleteBatchAsync(deleteKeys).ConfigureAwait(false);
                }
            }
        }

        if (deleteKeys.Count > 0)
        {
            deleted += await FlushScanDeleteBatchAsync(deleteKeys).ConfigureAwait(false);
        }

        return deleted;
    }

    private async Task<int> FlushScanDeleteBatchAsync(List<RedisKey> deleteKeys)
    {
        int count = deleteKeys.Count;
        await _db.KeyDeleteAsync(deleteKeys.ToArray()).ConfigureAwait(false);
        deleteKeys.Clear();
        return count;
    }

    public async Task<IAsyncDisposable> AcquireSingleFlightAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
    {
        string lockKey = $"singleflight:{BuildKey(policyId, identity)}";
        while (true)
        {
            var singleFlight = memoryCache.GetOrCreate(lockKey, entry =>
            {
                entry.SlidingExpiration = TimeSpan.FromMinutes(2);
                entry.RegisterPostEvictionCallback(static (_, value, _, _) =>
                {
                    if (value is SingleFlightEntry singleFlightEntry)
                    {
                        singleFlightEntry.MarkRetired();
                    }
                });
                return new SingleFlightEntry();
            })!;

            if (!singleFlight.TryAddReference())
            {
                continue;
            }

            try
            {
                await singleFlight.Semaphore.WaitAsync(cancellationToken).ConfigureAwait(false);
                return new AsyncReleaser(singleFlight);
            }
            catch
            {
                singleFlight.ReleaseReference();
                throw;
            }
        }
    }

    private void SetL1(CachePolicyId policyId, string key, byte[] bytes)
    {
        CachePolicy policy = ResolvePolicy(policyId);
        if (policy.L1Ttl <= TimeSpan.Zero)
        {
            return;
        }

        memoryCache.Set(key, CopyRawBytes(bytes), policy.L1Ttl);
    }

    private static byte[] CopyRawBytes(byte[] bytes)
        => bytes.Length == 0 ? Array.Empty<byte>() : bytes.ToArray();

    internal static byte[] CopyRawBytesForTests(byte[] bytes)
        => CopyRawBytes(bytes);

    private async Task SetNegativeCoreAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken)
    {
        CachePolicy policy = ResolvePolicy(policyId);
        if (!policy.NegativeTtl.HasValue || policy.NegativeTtl.Value <= TimeSpan.Zero)
        {
            return;
        }

        string key = BuildKey(policyId, identity);
        await _db.StringSetAsync(key, Array.Empty<byte>(), policy.NegativeTtl).ConfigureAwait(false);
        await RegisterKeyAsync(policyId, key).ConfigureAwait(false);
        SetL1(policyId, key, Array.Empty<byte>());
    }

    private static TimeSpan ApplyDeterministicJitter(string cacheKey, TimeSpan baseTtl, double jitterRatio)
    {
        if (baseTtl <= TimeSpan.Zero || jitterRatio <= 0d)
        {
            return baseTtl;
        }

        long jitterWindow = (long)(baseTtl.Ticks * jitterRatio);
        if (jitterWindow <= 0)
        {
            return baseTtl;
        }

        ulong hash = ComputeDeterministicHash(cacheKey);
        ulong span = (ulong)(jitterWindow * 2L) + 1UL;
        long offset = (long)(hash % span) - jitterWindow;
        long adjustedTicks = Math.Max(1L, baseTtl.Ticks + offset);
        return TimeSpan.FromTicks(adjustedTicks);
    }

    private static ulong ComputeDeterministicHash(ReadOnlySpan<char> input)
    {
        const ulong Offset = 14695981039346656037UL;
        const ulong Prime = 1099511628211UL;

        ulong hash = Offset;
        for (int i = 0; i < input.Length; i++)
        {
            hash ^= input[i];
            hash *= Prime;
        }

        return hash;
    }

    private static string BuildRegistryKey(CachePolicyId policyId)
        => $"{RegistryKeyPrefix}{(int)policyId}";

    private string ResolveRegistryKey(CachePolicyId policyId)
        => keyScope.PrefixKey(BuildRegistryKey(policyId));

    internal static string BuildRegistryKeyForTests(CachePolicyId policyId)
        => BuildRegistryKey(policyId);

    internal static TimeSpan ApplyDeterministicJitterForTests(TimeSpan baseTtl, double jitterRatio, string cacheKey)
        => ApplyDeterministicJitter(cacheKey, baseTtl, jitterRatio);

    internal static IReadOnlyList<string> FilterRegistryKeys(string prefix, ReadOnlySpan<RedisValue> registeredKeys)
    {
        var matches = new List<string>(registeredKeys.Length);
        foreach (RedisValue key in registeredKeys)
        {
            if (key.IsNullOrEmpty)
            {
                continue;
            }

            string value = key.ToString();
            if (value.StartsWith(prefix, StringComparison.Ordinal))
            {
                matches.Add(value);
            }
        }

        return matches;
    }

    private async Task RegisterKeyAsync(CachePolicyId policyId, string key)
    {
        await BoundaryExecutor.ExecuteAsync(
            async () => _ = await _db.SetAddAsync(ResolveRegistryKey(policyId), key).ConfigureAwait(false),
            logger,
            $"cache-register:{policyId}:{key}",
            LogLevel.Debug);
    }

    private async Task UnregisterKeyAsync(CachePolicyId policyId, string key)
    {
        await BoundaryExecutor.ExecuteAsync(
            async () => _ = await _db.SetRemoveAsync(ResolveRegistryKey(policyId), key).ConfigureAwait(false),
            logger,
            $"cache-unregister:{policyId}:{key}",
            LogLevel.Debug);
    }

    private CachePolicy ResolvePolicy(CachePolicyId policyId)
    {
        if (policyRegistry.TryGet(policyId, out CachePolicy policy))
        {
            return policy;
        }

        logger.LogError("Cache policy missing: {PolicyId}", policyId);
        return new CachePolicy(
            policyId,
            "missing",
            $"policy-{policyId}",
            TimeSpan.Zero,
            MissingPolicyL2Ttl,
            null,
            null,
            true);
    }

    internal sealed class SingleFlightEntry : IDisposable
    {
        private int _referenceCount;
        private int _retired;
        private int _disposed;

        public SemaphoreSlim Semaphore { get; } = new(1, 1);

        public bool TryAddReference()
        {
            while (true)
            {
                if (Volatile.Read(ref _retired) == 1 || Volatile.Read(ref _disposed) == 1)
                {
                    return false;
                }

                int current = Volatile.Read(ref _referenceCount);
                if (Interlocked.CompareExchange(ref _referenceCount, current + 1, current) != current)
                {
                    continue;
                }

                if (Volatile.Read(ref _retired) == 1 || Volatile.Read(ref _disposed) == 1)
                {
                    ReleaseReference();
                    return false;
                }

                return true;
            }
        }

        public void ReleaseReference()
        {
            Interlocked.Decrement(ref _referenceCount);
            TryDispose();
        }

        public void MarkRetired()
        {
            Volatile.Write(ref _retired, 1);
            TryDispose();
        }

        public void Dispose() => TryDispose(force: true);

        private void TryDispose(bool force = false)
        {
            if (!force)
            {
                if (Volatile.Read(ref _retired) == 0 || Volatile.Read(ref _referenceCount) != 0)
                {
                    return;
                }
            }

            if (Interlocked.Exchange(ref _disposed, 1) == 0)
            {
                Semaphore.Dispose();
            }
        }
    }

    private sealed class AsyncReleaser(SingleFlightEntry entry) : IAsyncDisposable
    {
        public ValueTask DisposeAsync()
        {
            entry.Semaphore.Release();
            entry.ReleaseReference();
            return ValueTask.CompletedTask;
        }
    }
}
