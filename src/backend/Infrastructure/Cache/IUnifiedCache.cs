using System.Collections.Concurrent;
using System.Diagnostics;
using Microsoft.Extensions.Caching.Memory;
using StackExchange.Redis;
using System.Net;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Observability;

namespace FsusBlog.Server.Infrastructure.Cache;

public readonly record struct CacheReadResult<T>(bool Hit, T? Value);
public readonly record struct CacheKeyIdentity(CachePolicyId PolicyId, string Identity);
public readonly record struct CachePrefixIdentity(CachePolicyId PolicyId, string IdentityPrefix);

public interface IUnifiedCache
{
    Task<CacheReadResult<T>> TryGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default);
    /// <summary>
    /// Returns a caller-owned byte array. Callers may pass it to serializers or streams without retaining cache ownership;
    /// mutating the returned array must not mutate L1/L2 cache state.
    /// </summary>
    Task<CacheReadResult<byte[]>> TryGetRawAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default);
    /// <summary>
    /// Returns an immutable cache-owned raw payload for synchronous response write-through.
    /// Callers must not mutate, retain for cross-request state, or expose the backing buffer as writable.
    /// </summary>
    Task<CacheReadResult<ReadOnlyMemory<byte>>> TryGetRawReadonlyAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default);
    /// <summary>
    /// Stores a defensive copy of <paramref name="value"/> so later caller mutations cannot corrupt cache state.
    /// </summary>
    Task SetRawAsync(CachePolicyId policyId, string identity, byte[] value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default);
    Task SetNegativeAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default);
    Task<string?> GetStringAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default);
    Task SetStringAsync(CachePolicyId policyId, string identity, string value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default);
    Task<bool> TrySetStringIfValueAsync(CachePolicyId policyId, string identity, string value, string compareIdentity, string expectedCompareValue, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default)
        => throw new NotSupportedException("This cache implementation does not support compare-and-set string writes.");
    Task<long> IncrementAsync(CachePolicyId policyId, string identity, long value = 1, CancellationToken cancellationToken = default);
    Task<long> IncrementWithExpiryAsync(CachePolicyId policyId, string identity, TimeSpan ttl, long value = 1, CancellationToken cancellationToken = default)
        => throw new NotSupportedException("This cache implementation does not support atomic expiring counters.");
    Task<bool> TryAcquireLeaseAsync(CachePolicyId policyId, string identity, string value, TimeSpan ttl, CancellationToken cancellationToken = default);
    Task<bool> ConsumeOnceAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default);
    Task<CacheReadResult<T>> ConsumeOnceAndGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default);
    Task RemoveAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default);
    Task RemoveManyAsync(IReadOnlyList<CacheKeyIdentity> keys, CancellationToken cancellationToken = default);
    Task RemoveByPrefixAsync(CachePolicyId policyId, string identityPrefix, CancellationToken cancellationToken = default);
    Task RemoveByPrefixManyAsync(IReadOnlyList<CachePrefixIdentity> prefixes, CancellationToken cancellationToken = default);
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
    private const string DeleteKeysAndRegistryMembersScript = """
        for i = 2, #KEYS do
            redis.call('DEL', KEYS[i])
            redis.call('SREM', KEYS[1], KEYS[i])
        end
        return #KEYS - 1
        """;

    private readonly IConnectionMultiplexer _redis = redis;
    private readonly IDatabase _db = redis.GetDatabase();
    private readonly ConcurrentDictionary<string, SingleFlightEntry> _singleFlightEntries = new(StringComparer.Ordinal);

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
        cancellationToken.ThrowIfCancellationRequested();
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
            cancellationToken.ThrowIfCancellationRequested();
            await _db.KeyDeleteAsync(key).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            await UnregisterKeyAsync(policyId, key).ConfigureAwait(false);
            FsusObservability.RecordCacheOperation("get", policyId.ToString(), "l1", "decode_failed", FsusObservability.GetElapsed(startedAt));
            return new CacheReadResult<T>(false, default);
        }

        cancellationToken.ThrowIfCancellationRequested();
        RedisValue l2Value = await _db.StringGetAsync(key).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
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
            cancellationToken.ThrowIfCancellationRequested();
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
        cancellationToken.ThrowIfCancellationRequested();
        if (memoryCache.TryGetValue(key, out byte[]? l1Bytes) && l1Bytes is not null)
        {
            FsusObservability.RecordCacheOperation("get_raw", policyId.ToString(), "l1", "hit", FsusObservability.GetElapsed(startedAt));
            return new CacheReadResult<byte[]>(true, CopyRawBytes(l1Bytes));
        }

        RedisValue l2Value = await _db.StringGetAsync(key).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
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

    public async Task<CacheReadResult<ReadOnlyMemory<byte>>> TryGetRawReadonlyAsync(
        CachePolicyId policyId,
        string identity,
        CancellationToken cancellationToken = default)
    {
        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.get_raw_readonly", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "get_raw_readonly");
        FsusObservability.SetTag(activity, "fsus.cache.policy", policyId.ToString());
        string key = BuildKey(policyId, identity);
        cancellationToken.ThrowIfCancellationRequested();
        if (memoryCache.TryGetValue(key, out byte[]? l1Bytes) && l1Bytes is not null)
        {
            FsusObservability.RecordCacheOperation("get_raw_readonly", policyId.ToString(), "l1", "hit", FsusObservability.GetElapsed(startedAt));
            return new CacheReadResult<ReadOnlyMemory<byte>>(true, l1Bytes);
        }

        RedisValue l2Value = await _db.StringGetAsync(key).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (!l2Value.HasValue)
        {
            FsusObservability.RecordCacheOperation("get_raw_readonly", policyId.ToString(), "l2", "miss", FsusObservability.GetElapsed(startedAt));
            return new CacheReadResult<ReadOnlyMemory<byte>>(false, default);
        }

        byte[] bytes = (byte[])l2Value!;
        SetL1(policyId, key, bytes);
        FsusObservability.RecordCacheOperation("get_raw_readonly", policyId.ToString(), "l2", "hit", FsusObservability.GetElapsed(startedAt));
        return new CacheReadResult<ReadOnlyMemory<byte>>(true, bytes);
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
        cancellationToken.ThrowIfCancellationRequested();
        CachePolicy policy = ResolvePolicy(policyId);
        TimeSpan? l2Ttl = ResolveL2Expiry(key, policy, l2TtlOverride);
        byte[] cachedValue = CopyRawBytes(value);
        cancellationToken.ThrowIfCancellationRequested();
        await _db.StringSetAsync(key, cachedValue, l2Ttl, When.Always, CommandFlags.None).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        await RegisterKeyAsync(policyId, key).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
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

    public async Task<bool> TrySetStringIfValueAsync(
        CachePolicyId policyId,
        string identity,
        string value,
        string compareIdentity,
        string expectedCompareValue,
        TimeSpan? l2TtlOverride = null,
        CancellationToken cancellationToken = default)
    {
        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.set_cas", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "set_cas");
        FsusObservability.SetTag(activity, "fsus.cache.policy", policyId.ToString());
        string key = BuildKey(policyId, identity);
        string compareKey = BuildKey(policyId, compareIdentity);
        cancellationToken.ThrowIfCancellationRequested();
        CachePolicy policy = ResolvePolicy(policyId);
        TimeSpan? l2Ttl = ResolveL2Expiry(key, policy, l2TtlOverride);
        byte[] cachedValue = System.Text.Encoding.UTF8.GetBytes(value);
        memoryCache.Remove(key);
        cancellationToken.ThrowIfCancellationRequested();
        ITransaction transaction = _db.CreateTransaction();
        transaction.AddCondition(Condition.StringEqual(compareKey, expectedCompareValue));
        Task<bool> setTask = transaction.StringSetAsync(key, cachedValue, l2Ttl, When.Always, CommandFlags.None);
        bool committed = await transaction.ExecuteAsync(CommandFlags.None).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (!committed || !await setTask.ConfigureAwait(false))
        {
            FsusObservability.RecordCacheOperation("set_cas", policyId.ToString(), "l2", "conflict", FsusObservability.GetElapsed(startedAt));
            return false;
        }

        await RegisterKeyAsync(policyId, key).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        SetL1(policyId, key, cachedValue);
        FsusObservability.RecordCacheOperation("set_cas", policyId.ToString(), "l2", "ok", FsusObservability.GetElapsed(startedAt));
        return true;
    }

    public async Task<long> IncrementAsync(CachePolicyId policyId, string identity, long value = 1, CancellationToken cancellationToken = default)
    {
        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.increment", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "increment");
        FsusObservability.SetTag(activity, "fsus.cache.policy", policyId.ToString());
        cancellationToken.ThrowIfCancellationRequested();
        string key = BuildKey(policyId, identity);
        memoryCache.Remove(key);
        cancellationToken.ThrowIfCancellationRequested();
        long updated = await _db.StringIncrementAsync(key, value).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        await RegisterKeyAsync(policyId, key).ConfigureAwait(false);
        FsusObservability.RecordCacheOperation("increment", policyId.ToString(), "l2", "ok", FsusObservability.GetElapsed(startedAt));
        return updated;
    }

    public async Task<long> IncrementWithExpiryAsync(
        CachePolicyId policyId,
        string identity,
        TimeSpan ttl,
        long value = 1,
        CancellationToken cancellationToken = default)
    {
        if (ttl <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(ttl), "Counter expiry must be positive.");
        }

        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.increment_expiring", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "increment_expiring");
        FsusObservability.SetTag(activity, "fsus.cache.policy", policyId.ToString());
        cancellationToken.ThrowIfCancellationRequested();
        string key = BuildKey(policyId, identity);
        memoryCache.Remove(key);
        cancellationToken.ThrowIfCancellationRequested();
        const string script = """
local current = redis.call('INCRBY', KEYS[1], ARGV[1])
if redis.call('PTTL', KEYS[1]) < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return current
""";
        long ttlMilliseconds = Math.Max(1L, (long)Math.Ceiling(ttl.TotalMilliseconds));
        RedisResult result = await _db.ScriptEvaluateAsync(
                script,
                [key],
                [value, ttlMilliseconds],
                CommandFlags.None)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        await RegisterKeyAsync(policyId, key).ConfigureAwait(false);
        FsusObservability.RecordCacheOperation("increment_expiring", policyId.ToString(), "l2", "ok", FsusObservability.GetElapsed(startedAt));
        return (long)result;
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
        cancellationToken.ThrowIfCancellationRequested();
        string key = BuildKey(policyId, identity);
        memoryCache.Remove(key);
        cancellationToken.ThrowIfCancellationRequested();
        var tran = _db.CreateTransaction();
        _ = tran.AddCondition(Condition.KeyExists(key));
        _ = tran.KeyDeleteAsync(key);
        bool ok = await tran.ExecuteAsync(CommandFlags.None).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (ok)
        {
            await UnregisterKeyAsync(policyId, key, cancellationToken).ConfigureAwait(false);
        }

        FsusObservability.RecordCacheOperation("consume_once", policyId.ToString(), "l2", ok ? "consumed" : "miss", FsusObservability.GetElapsed(startedAt));
        return ok;
    }

    public async Task<CacheReadResult<T>> ConsumeOnceAndGetAsync<T>(
        CachePolicyId policyId,
        string identity,
        Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder,
        CancellationToken cancellationToken = default)
    {
        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.consume_once_get", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "consume_once_get");
        FsusObservability.SetTag(activity, "fsus.cache.policy", policyId.ToString());
        cancellationToken.ThrowIfCancellationRequested();
        string key = BuildKey(policyId, identity);
        memoryCache.Remove(key);
        cancellationToken.ThrowIfCancellationRequested();
        RedisValue value = await _db.StringGetDeleteAsync(key).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (!value.HasValue)
        {
            FsusObservability.RecordCacheOperation("consume_once_get", policyId.ToString(), "l2", "miss", FsusObservability.GetElapsed(startedAt));
            return new CacheReadResult<T>(false, default);
        }

        byte[] bytes = (byte[])value!;
        if (bytes.Length == 0)
        {
            await UnregisterKeyAsync(policyId, key, cancellationToken).ConfigureAwait(false);
            FsusObservability.RecordCacheOperation("consume_once_get", policyId.ToString(), "l2", "hit_negative", FsusObservability.GetElapsed(startedAt));
            return new CacheReadResult<T>(true, default);
        }

        var (success, decoded) = decoder(bytes);
        if (!success)
        {
            await UnregisterKeyAsync(policyId, key, cancellationToken).ConfigureAwait(false);
            FsusObservability.RecordCacheOperation("consume_once_get", policyId.ToString(), "l2", "decode_failed", FsusObservability.GetElapsed(startedAt));
            return new CacheReadResult<T>(false, default);
        }

        await UnregisterKeyAsync(policyId, key, cancellationToken).ConfigureAwait(false);
        FsusObservability.RecordCacheOperation("consume_once_get", policyId.ToString(), "l2", "consumed", FsusObservability.GetElapsed(startedAt));
        return new CacheReadResult<T>(true, decoded);
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

    public async Task RemoveManyAsync(IReadOnlyList<CacheKeyIdentity> keys, CancellationToken cancellationToken = default)
    {
        if (keys.Count == 0)
        {
            return;
        }

        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.remove_many", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "remove_many");
        FsusObservability.SetTag(activity, "fsus.cache.policy", "mixed");

        var unregisteredRedisKeys = new List<RedisKey>(keys.Count);
        var registryMembersByPolicy = new Dictionary<CachePolicyId, List<RedisValue>>();
        var seenKeys = new HashSet<string>(StringComparer.Ordinal);
        foreach (CacheKeyIdentity identity in keys)
        {
            cancellationToken.ThrowIfCancellationRequested();
            CachePolicy policy = ResolvePolicy(identity.PolicyId);
            string key = keyScope.PrefixKey(policy.BuildKey(identity.Identity));
            if (!seenKeys.Add(key))
            {
                continue;
            }

            memoryCache.Remove(key);
            if (policy.RegisterKeysForPrefixInvalidation)
            {
                if (!registryMembersByPolicy.TryGetValue(identity.PolicyId, out List<RedisValue>? members))
                {
                    members = [];
                    registryMembersByPolicy[identity.PolicyId] = members;
                }

                members.Add(key);
                continue;
            }

            unregisteredRedisKeys.Add(key);
        }

        int redisBatches = 0;
        if (unregisteredRedisKeys.Count > 0)
        {
            await _db.KeyDeleteAsync(unregisteredRedisKeys.ToArray()).ConfigureAwait(false);
            redisBatches++;
        }

        foreach ((CachePolicyId policyId, List<RedisValue> members) in registryMembersByPolicy)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (members.Count == 0)
            {
                continue;
            }

            redisBatches += await DeleteKeysAndRegistryMembersAtomicAsync(policyId, members, cancellationToken).ConfigureAwait(false);
        }

        TimeSpan elapsed = FsusObservability.GetElapsed(startedAt);
        FsusObservability.RecordCacheOperation("remove_many", "mixed", "l2", "ok", elapsed);
        FsusObservability.RecordCacheRemoveMany(seenKeys.Count, redisBatches, elapsed);
    }

    private async Task<int> DeleteKeysAndRegistryMembersAtomicAsync(
        CachePolicyId policyId,
        List<RedisValue> members,
        CancellationToken cancellationToken)
    {
        string registryKey = ResolveRegistryKey(policyId);
        int batches = 0;
        for (int offset = 0; offset < members.Count; offset += PrefixInvalidationBatchSize)
        {
            cancellationToken.ThrowIfCancellationRequested();
            int take = Math.Min(PrefixInvalidationBatchSize, members.Count - offset);
            RedisKey[] scriptKeys = new RedisKey[take + 1];
            scriptKeys[0] = registryKey;
            for (int i = 0; i < take; i++)
            {
                scriptKeys[i + 1] = members[offset + i].ToString();
            }

            await _db.ScriptEvaluateAsync(
                    DeleteKeysAndRegistryMembersScript,
                    scriptKeys,
                    Array.Empty<RedisValue>())
                .ConfigureAwait(false);
            batches++;
        }

        return batches;
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
            await DeleteRegisteredKeysByPrefixAsync(registryKey, prefix, cancellationToken).ConfigureAwait(false);
            FsusObservability.RecordCacheOperation("remove_prefix", policyId.ToString(), "l2", "ok", FsusObservability.GetElapsed(startedAt));

            return;
        }

        logger.LogInformation(
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

    public async Task RemoveByPrefixManyAsync(IReadOnlyList<CachePrefixIdentity> prefixes, CancellationToken cancellationToken = default)
    {
        if (prefixes.Count == 0)
        {
            return;
        }

        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.remove_prefix_many", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "remove_prefix_many");
        FsusObservability.SetTag(activity, "fsus.cache.policy", "mixed");

        int registryScans = 0;
        int deletedKeys = 0;
        foreach (IGrouping<CachePolicyId, CachePrefixIdentity> group in prefixes.GroupBy(static item => item.PolicyId))
        {
            cancellationToken.ThrowIfCancellationRequested();
            CachePolicy policy = ResolvePolicy(group.Key);
            string[] resolvedPrefixes = group
                .Select(item => keyScope.PrefixKey(policy.BuildKey(item.IdentityPrefix)))
                .Distinct(StringComparer.Ordinal)
                .ToArray();
            if (resolvedPrefixes.Length == 0)
            {
                continue;
            }

            string registryKey = ResolveRegistryKey(group.Key);
            bool registryExists = await _db.KeyExistsAsync(registryKey).ConfigureAwait(false);
            if (registryExists)
            {
                registryScans++;
                deletedKeys += await DeleteRegisteredKeysByPrefixesAsync(registryKey, resolvedPrefixes, cancellationToken).ConfigureAwait(false);
                continue;
            }

            logger.LogInformation(
                "cache-prefix-many-invalidation-registry-missing {PolicyId} {PrefixCount}; using Redis keyspace scan fallback",
                group.Key,
                resolvedPrefixes.Length);
            try
            {
                deletedKeys += await DeleteKeysByPrefixesScanAsync(resolvedPrefixes, cancellationToken).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                logger.LogWarning(
                    ex,
                    "cache-prefix-many-invalidation-scan-failed {PolicyId} {PrefixCount}",
                    group.Key,
                    resolvedPrefixes.Length);
                FsusObservability.RecordCacheOperation("remove_prefix_many", group.Key.ToString(), "l2", "registry_missing_scan_failed", FsusObservability.GetElapsed(startedAt));
            }
        }

        TimeSpan elapsed = FsusObservability.GetElapsed(startedAt);
        FsusObservability.RecordCacheOperation("remove_prefix_many", "mixed", "l2", "ok", elapsed);
        FsusObservability.RecordCacheRemovePrefixMany(prefixes.Count, registryScans, deletedKeys, elapsed);
    }

    private async Task DeleteRegisteredKeysByPrefixAsync(
        string registryKey,
        string prefix,
        CancellationToken cancellationToken)
    {
        List<RedisKey> deleteKeys = new(PrefixInvalidationBatchSize);
        List<RedisValue> registryMembers = new(PrefixInvalidationBatchSize);
        foreach (RedisValue registeredKey in _db.SetScan(registryKey, pageSize: PrefixInvalidationBatchSize))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (registeredKey.IsNullOrEmpty)
            {
                continue;
            }

            string value = registeredKey.ToString();
            if (!value.StartsWith(prefix, StringComparison.Ordinal))
            {
                continue;
            }

            deleteKeys.Add(value);
            registryMembers.Add(value);
            memoryCache.Remove(value);

            if (deleteKeys.Count >= PrefixInvalidationBatchSize)
            {
                _ = await FlushRegisteredDeleteBatchAsync(registryKey, deleteKeys, registryMembers).ConfigureAwait(false);
            }
        }

        if (deleteKeys.Count > 0)
        {
            _ = await FlushRegisteredDeleteBatchAsync(registryKey, deleteKeys, registryMembers).ConfigureAwait(false);
        }
    }

    private async Task<int> DeleteRegisteredKeysByPrefixesAsync(
        string registryKey,
        IReadOnlyList<string> prefixes,
        CancellationToken cancellationToken)
    {
        var deleteKeys = new List<RedisKey>(PrefixInvalidationBatchSize);
        var registryMembers = new List<RedisValue>(PrefixInvalidationBatchSize);
        int deleted = 0;
        foreach (RedisValue registeredKey in _db.SetScan(registryKey, pageSize: PrefixInvalidationBatchSize))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (registeredKey.IsNullOrEmpty)
            {
                continue;
            }

            string value = registeredKey.ToString();
            if (!StartsWithAny(value, prefixes))
            {
                continue;
            }

            deleteKeys.Add(value);
            registryMembers.Add(value);
            memoryCache.Remove(value);

            if (deleteKeys.Count >= PrefixInvalidationBatchSize)
            {
                deleted += await FlushRegisteredDeleteBatchAsync(registryKey, deleteKeys, registryMembers).ConfigureAwait(false);
            }
        }

        if (deleteKeys.Count > 0)
        {
            deleted += await FlushRegisteredDeleteBatchAsync(registryKey, deleteKeys, registryMembers).ConfigureAwait(false);
        }

        return deleted;
    }

    private async Task<int> FlushRegisteredDeleteBatchAsync(
        string registryKey,
        List<RedisKey> deleteKeys,
        List<RedisValue> registryMembers)
    {
        int count = deleteKeys.Count;
        await _db.KeyDeleteAsync(deleteKeys.ToArray()).ConfigureAwait(false);
        await _db.SetRemoveAsync(registryKey, registryMembers.ToArray()).ConfigureAwait(false);
        deleteKeys.Clear();
        registryMembers.Clear();
        return count;
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

    private async Task<int> DeleteKeysByPrefixesScanAsync(IReadOnlyList<string> prefixes, CancellationToken cancellationToken)
    {
        string scanPrefix = BuildCommonPrefix(prefixes);
        string pattern = scanPrefix + "*";
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
                if (!seen.Add(keyText) || !StartsWithAny(keyText, prefixes))
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
            var singleFlight = _singleFlightEntries.GetOrAdd(lockKey, static _ => new SingleFlightEntry());

            if (!singleFlight.TryAddReference())
            {
                if (singleFlight.TryRetireIfIdle())
                {
                    _singleFlightEntries.TryRemove(new KeyValuePair<string, SingleFlightEntry>(lockKey, singleFlight));
                }

                await Task.Yield();
                continue;
            }

            try
            {
                await singleFlight.Semaphore.WaitAsync(cancellationToken).ConfigureAwait(false);
                return new AsyncReleaser(this, lockKey, singleFlight);
            }
            catch
            {
                ReleaseSingleFlightReference(lockKey, singleFlight);
                throw;
            }
        }
    }

    private void ReleaseSingleFlightReference(string lockKey, SingleFlightEntry singleFlight)
    {
        if (!singleFlight.ReleaseReference(retireWhenIdle: true))
        {
            return;
        }

        _singleFlightEntries.TryRemove(new KeyValuePair<string, SingleFlightEntry>(lockKey, singleFlight));
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

    internal static ReadOnlyMemory<byte> BorrowRawBytesReadonlyForTests(byte[] bytes)
        => bytes;

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

    private static TimeSpan? ResolveL2Expiry(string cacheKey, CachePolicy policy, TimeSpan? l2TtlOverride)
    {
        if (l2TtlOverride.HasValue)
        {
            return ToRedisExpiry(l2TtlOverride.Value);
        }

        return ToRedisExpiry(ApplyDeterministicJitter(cacheKey, policy.L2Ttl, policy.L2JitterRatio));
    }

    private static TimeSpan? ToRedisExpiry(TimeSpan ttl)
        => ttl == Timeout.InfiniteTimeSpan ? null : ttl;

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

    internal static IReadOnlyList<string> FilterRegistryKeysByPrefixes(IReadOnlyList<string> prefixes, ReadOnlySpan<RedisValue> registeredKeys)
    {
        var matches = new List<string>(registeredKeys.Length);
        foreach (RedisValue key in registeredKeys)
        {
            if (key.IsNullOrEmpty)
            {
                continue;
            }

            string value = key.ToString();
            if (StartsWithAny(value, prefixes))
            {
                matches.Add(value);
            }
        }

        return matches;
    }

    internal static string BuildCommonPrefixForTests(IReadOnlyList<string> prefixes)
        => BuildCommonPrefix(prefixes);

    private static bool StartsWithAny(string value, IReadOnlyList<string> prefixes)
    {
        foreach (string prefix in prefixes)
        {
            if (value.StartsWith(prefix, StringComparison.Ordinal))
            {
                return true;
            }
        }

        return false;
    }

    private static string BuildCommonPrefix(IReadOnlyList<string> prefixes)
    {
        if (prefixes.Count == 0)
        {
            return string.Empty;
        }

        string common = prefixes[0];
        for (int i = 1; i < prefixes.Count && common.Length > 0; i++)
        {
            string current = prefixes[i];
            int length = Math.Min(common.Length, current.Length);
            int index = 0;
            while (index < length && common[index] == current[index])
            {
                index++;
            }

            common = common[..index];
        }

        return common;
    }

    private async Task RegisterKeyAsync(CachePolicyId policyId, string key)
    {
        if (!ResolvePolicy(policyId).RegisterKeysForPrefixInvalidation)
        {
            return;
        }

        await BoundaryExecutor.ExecuteAsync(
            async () => _ = await _db.SetAddAsync(ResolveRegistryKey(policyId), key).ConfigureAwait(false),
            logger,
            $"cache-register:{policyId}:{key}",
            LogLevel.Debug);
    }

    private async Task UnregisterKeyAsync(CachePolicyId policyId, string key, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!ResolvePolicy(policyId).RegisterKeysForPrefixInvalidation)
        {
            return;
        }

        await BoundaryExecutor.ExecuteAsync(
            async () =>
            {
                cancellationToken.ThrowIfCancellationRequested();
                _ = await _db.SetRemoveAsync(ResolveRegistryKey(policyId), key).ConfigureAwait(false);
                cancellationToken.ThrowIfCancellationRequested();
            },
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
        private int _disposed;
        private int _retired;

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

                if (Volatile.Read(ref _retired) == 0 && Volatile.Read(ref _disposed) == 0)
                {
                    return true;
                }

                ReleaseReference();
                return false;
            }
        }

        public bool ReleaseReference(bool retireWhenIdle = false)
        {
            int remaining;
            while (true)
            {
                int current = Volatile.Read(ref _referenceCount);
                if (current <= 0)
                {
                    throw new InvalidOperationException("Single-flight reference count is already zero.");
                }

                remaining = current - 1;
                if (Interlocked.CompareExchange(ref _referenceCount, remaining, current) == current)
                {
                    break;
                }
            }

            if (retireWhenIdle && remaining == 0)
            {
                Volatile.Write(ref _retired, 1);
            }

            if (Volatile.Read(ref _retired) == 1 && remaining == 0)
            {
                Dispose();
                return true;
            }

            return false;
        }

        public void MarkRetired()
            => _ = TryRetireIfIdle(force: true);

        public bool TryRetireIfIdle()
            => TryRetireIfIdle(force: false);

        private bool TryRetireIfIdle(bool force)
        {
            if (!force && Volatile.Read(ref _referenceCount) != 0)
            {
                return false;
            }

            Volatile.Write(ref _retired, 1);
            if (Volatile.Read(ref _referenceCount) == 0)
            {
                Dispose();
                return true;
            }

            return false;
        }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) == 0)
            {
                Semaphore.Dispose();
            }
        }
    }

    private sealed class AsyncReleaser(UnifiedCache owner, string lockKey, SingleFlightEntry entry) : IAsyncDisposable
    {
        public ValueTask DisposeAsync()
        {
            entry.Semaphore.Release();
            owner.ReleaseSingleFlightReference(lockKey, entry);
            return ValueTask.CompletedTask;
        }
    }
}
