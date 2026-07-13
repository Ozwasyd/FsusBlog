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
public sealed record CachePolicyStorageSnapshot(CachePolicyId PolicyId, long KeyCount, long Bytes);

public interface IUnifiedCache
{
    Task<CacheReadResult<T>> TryGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default);
    Task<CacheReadResult<T>> TryGetAsync<T>(CachePolicyId policyId, int identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default)
        => TryGetAsync(policyId, identity.ToString(System.Globalization.CultureInfo.InvariantCulture), decoder, cancellationToken);
    /// <summary>
    /// Returns a caller-owned byte array. Callers may pass it to serializers or streams without retaining cache ownership;
    /// mutating the returned array must not mutate L1/L2 cache state.
    /// </summary>
    Task<CacheReadResult<byte[]>> TryGetRawAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default);
    Task<CacheReadResult<byte[]>> TryGetRawAsync(CachePolicyId policyId, int identity, CancellationToken cancellationToken = default)
        => TryGetRawAsync(policyId, identity.ToString(System.Globalization.CultureInfo.InvariantCulture), cancellationToken);
    /// <summary>
    /// Returns an immutable cache-owned raw payload for synchronous response write-through.
    /// Callers must not mutate, retain for cross-request state, or expose the backing buffer as writable.
    /// </summary>
    Task<CacheReadResult<ReadOnlyMemory<byte>>> TryGetRawReadonlyAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default);
    Task<CacheReadResult<ReadOnlyMemory<byte>>> TryGetRawReadonlyAsync(CachePolicyId policyId, int identity, CancellationToken cancellationToken = default)
        => TryGetRawReadonlyAsync(policyId, identity.ToString(System.Globalization.CultureInfo.InvariantCulture), cancellationToken);
    /// <summary>
    /// Stores a defensive copy of <paramref name="value"/> so later caller mutations cannot corrupt cache state.
    /// </summary>
    Task SetRawAsync(CachePolicyId policyId, string identity, byte[] value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default);
    Task SetRawAsync(CachePolicyId policyId, int identity, byte[] value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default)
        => SetRawAsync(policyId, identity.ToString(System.Globalization.CultureInfo.InvariantCulture), value, l2TtlOverride, cancellationToken);
    Task SetNegativeAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default);
    Task<string?> GetStringAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default);
    Task SetStringAsync(CachePolicyId policyId, string identity, string value, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default);
    Task<bool> TrySetStringIfValueAsync(CachePolicyId policyId, string identity, string value, string compareIdentity, string expectedCompareValue, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default)
        => throw new NotSupportedException("This cache implementation does not support compare-and-set string writes.");
    Task<bool> TrySetVersionedStringAsync(CachePolicyId policyId, string identity, string value, string version, bool allowOverwrite = false, TimeSpan? l2TtlOverride = null, CancellationToken cancellationToken = default)
        => throw new NotSupportedException("This cache implementation does not support version-guarded string writes.");
    Task<long> IncrementAsync(CachePolicyId policyId, string identity, long value = 1, CancellationToken cancellationToken = default);
    Task<long[]> IncrementManyAsync(CachePolicyId policyId, IReadOnlyList<string> identities, long value = 1, CancellationToken cancellationToken = default)
        => throw new NotSupportedException("This cache implementation does not support atomic multi-counter increments.");
    Task<long> IncrementWithExpiryAsync(CachePolicyId policyId, string identity, TimeSpan ttl, long value = 1, CancellationToken cancellationToken = default)
        => throw new NotSupportedException("This cache implementation does not support atomic expiring counters.");
    Task<long[]> IncrementManyWithExpiryAsync(CachePolicyId policyId, IReadOnlyList<string> identities, TimeSpan ttl, long value = 1, CancellationToken cancellationToken = default)
        => throw new NotSupportedException("This cache implementation does not support atomic multi-counter expiring increments.");
    Task<long> IncrementClampedWithExpiryAsync(CachePolicyId policyId, string identity, long delta, long maxValue, TimeSpan ttl, CancellationToken cancellationToken = default)
        => throw new NotSupportedException("This cache implementation does not support atomic clamped expiring counters.");
    Task<bool> TryAcquireLeaseAsync(CachePolicyId policyId, string identity, string value, TimeSpan ttl, CancellationToken cancellationToken = default);
    Task<bool> ConsumeOnceAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default);
    Task<CacheReadResult<T>> ConsumeOnceAndGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default);
    Task RemoveAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default);
    Task RemoveAsync(CachePolicyId policyId, int identity, CancellationToken cancellationToken = default)
        => RemoveAsync(policyId, identity.ToString(System.Globalization.CultureInfo.InvariantCulture), cancellationToken);
    Task RemoveManyAsync(IReadOnlyList<CacheKeyIdentity> keys, CancellationToken cancellationToken = default);
    Task RemoveByPrefixAsync(CachePolicyId policyId, string identityPrefix, CancellationToken cancellationToken = default);
    Task RemoveByPrefixManyAsync(IReadOnlyList<CachePrefixIdentity> prefixes, CancellationToken cancellationToken = default);
    Task<IReadOnlyList<CachePolicyStorageSnapshot>> GetPolicyStorageSnapshotsAsync(IReadOnlyList<CachePolicyId> policyIds, CancellationToken cancellationToken = default)
        => Task.FromResult<IReadOnlyList<CachePolicyStorageSnapshot>>(
            policyIds.Select(static policyId => new CachePolicyStorageSnapshot(policyId, 0, 0)).ToArray());
    Task<IAsyncDisposable> AcquireSingleFlightAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default);
    string BuildKey(CachePolicyId policyId, string identity, string? version = null);
    string BuildKey(CachePolicyId policyId, int identity, string? version = null)
        => BuildKey(policyId, identity.ToString(System.Globalization.CultureInfo.InvariantCulture), version);
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
    private readonly ConcurrentDictionary<CacheL1Key, L1IndexEntry> _l1Entries = new();
    private readonly ConcurrentDictionary<string, L1IndexEntry> _l1KeysByRedisKey = new(StringComparer.Ordinal);
    private readonly object _l1MutationLock = new();

    public string BuildKey(CachePolicyId policyId, string identity, string? version = null)
    {
        return keyScope.PrefixKey(ResolvePolicy(policyId).BuildKey(identity, version));
    }

    public string BuildKey(CachePolicyId policyId, int identity, string? version = null)
    {
        return keyScope.PrefixKey(ResolvePolicy(policyId).BuildKey(identity, version));
    }

    public Task<CacheReadResult<T>> TryGetAsync<T>(
        CachePolicyId policyId,
        string identity,
        Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder,
        CancellationToken cancellationToken = default)
        => TryGetCoreAsync(policyId, CacheIdentity.FromString(identity), decoder, cancellationToken);

    public Task<CacheReadResult<T>> TryGetAsync<T>(
        CachePolicyId policyId,
        int identity,
        Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder,
        CancellationToken cancellationToken = default)
        => TryGetCoreAsync(policyId, CacheIdentity.FromInteger(identity), decoder, cancellationToken);

    private async Task<CacheReadResult<T>> TryGetCoreAsync<T>(
        CachePolicyId policyId,
        CacheIdentity identity,
        Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder,
        CancellationToken cancellationToken)
    {
        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.get", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "get");
        string policyName = CachePolicyTelemetry.Name(policyId);
        FsusObservability.SetTag(activity, "fsus.cache.policy", policyName);
        CachePolicy policy = ResolvePolicy(policyId);
        CacheL1Key l1Key = identity.ToL1Key(keyScope.ScopeToken, policyId);
        cancellationToken.ThrowIfCancellationRequested();
        if (TryGetL1(l1Key, out byte[] l1Bytes))
        {
            if (l1Bytes.Length == 0)
            {
                FsusObservability.RecordCacheOperation("get", policyName, "l1", "hit_negative", FsusObservability.GetElapsed(startedAt));
                return new CacheReadResult<T>(true, default);
            }

            var (l1Success, l1Value) = decoder(l1Bytes);
            if (l1Success)
            {
                FsusObservability.RecordCacheOperation("get", policyName, "l1", "hit", FsusObservability.GetElapsed(startedAt));
                return new CacheReadResult<T>(true, l1Value);
            }

            string corruptRedisKey = BuildRedisKey(policy, identity);
            RemoveL1(l1Key, corruptRedisKey);
            cancellationToken.ThrowIfCancellationRequested();
            await _db.KeyDeleteAsync(corruptRedisKey).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            await UnregisterKeyAsync(policyId, corruptRedisKey).ConfigureAwait(false);
            activity?.SetStatus(ActivityStatusCode.Error, "cache_decode_failed");
            logger.LogWarning("Cache decode failed for policy {PolicyId} at {CacheLayer}", policyName, "l1");
            FsusObservability.RecordCacheOperation("get", policyName, "l1", "decode_failed", FsusObservability.GetElapsed(startedAt));
            return new CacheReadResult<T>(false, default);
        }

        string key = BuildRedisKey(policy, identity);
        cancellationToken.ThrowIfCancellationRequested();
        RedisValue l2Value = await ReadRedisAsync(key, "get", policyName, activity, startedAt, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (!l2Value.HasValue)
        {
            FsusObservability.RecordCacheOperation("get", policyName, "l2", "miss", FsusObservability.GetElapsed(startedAt));
            return new CacheReadResult<T>(false, default);
        }

        byte[] bytes = (byte[])l2Value!;
        if (bytes.Length == 0)
        {
            SetL1(policy, l1Key, key, bytes);
            FsusObservability.RecordCacheOperation("get", policyName, "l2", "hit_negative", FsusObservability.GetElapsed(startedAt));
            return new CacheReadResult<T>(true, default);
        }

        var (success, value) = decoder(bytes);
        if (!success)
        {
            await _db.KeyDeleteAsync(key).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            await UnregisterKeyAsync(policyId, key).ConfigureAwait(false);
            activity?.SetStatus(ActivityStatusCode.Error, "cache_decode_failed");
            logger.LogWarning("Cache decode failed for policy {PolicyId} at {CacheLayer}", policyName, "l2");
            FsusObservability.RecordCacheOperation("get", policyName, "l2", "decode_failed", FsusObservability.GetElapsed(startedAt));
            return new CacheReadResult<T>(false, default);
        }

        SetL1(policy, l1Key, key, bytes);
        FsusObservability.RecordCacheOperation("get", policyName, "l2", "hit", FsusObservability.GetElapsed(startedAt));
        return new CacheReadResult<T>(true, value);
    }

    public Task<CacheReadResult<byte[]>> TryGetRawAsync(
        CachePolicyId policyId,
        string identity,
        CancellationToken cancellationToken = default)
        => TryGetRawCoreAsync(policyId, CacheIdentity.FromString(identity), cancellationToken);

    public Task<CacheReadResult<byte[]>> TryGetRawAsync(
        CachePolicyId policyId,
        int identity,
        CancellationToken cancellationToken = default)
        => TryGetRawCoreAsync(policyId, CacheIdentity.FromInteger(identity), cancellationToken);

    private async Task<CacheReadResult<byte[]>> TryGetRawCoreAsync(
        CachePolicyId policyId,
        CacheIdentity identity,
        CancellationToken cancellationToken)
    {
        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.get_raw", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "get_raw");
        string policyName = CachePolicyTelemetry.Name(policyId);
        FsusObservability.SetTag(activity, "fsus.cache.policy", policyName);
        CachePolicy policy = ResolvePolicy(policyId);
        CacheL1Key l1Key = identity.ToL1Key(keyScope.ScopeToken, policyId);
        cancellationToken.ThrowIfCancellationRequested();
        if (TryGetL1(l1Key, out byte[] l1Bytes))
        {
            FsusObservability.RecordCacheOperation("get_raw", policyName, "l1", "hit", FsusObservability.GetElapsed(startedAt));
            return new CacheReadResult<byte[]>(true, CopyRawBytes(l1Bytes));
        }

        string key = BuildRedisKey(policy, identity);
        RedisValue l2Value = await ReadRedisAsync(key, "get_raw", policyName, activity, startedAt, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (!l2Value.HasValue)
        {
            FsusObservability.RecordCacheOperation("get_raw", policyName, "l2", "miss", FsusObservability.GetElapsed(startedAt));
            return new CacheReadResult<byte[]>(false, default);
        }

        byte[] bytes = (byte[])l2Value!;
        SetL1(policy, l1Key, key, bytes);
        FsusObservability.RecordCacheOperation("get_raw", policyName, "l2", "hit", FsusObservability.GetElapsed(startedAt));
        return new CacheReadResult<byte[]>(true, CopyRawBytes(bytes));
    }

    public Task<CacheReadResult<ReadOnlyMemory<byte>>> TryGetRawReadonlyAsync(
        CachePolicyId policyId,
        string identity,
        CancellationToken cancellationToken = default)
        => TryGetRawReadonlyCoreAsync(policyId, CacheIdentity.FromString(identity), cancellationToken);

    public Task<CacheReadResult<ReadOnlyMemory<byte>>> TryGetRawReadonlyAsync(
        CachePolicyId policyId,
        int identity,
        CancellationToken cancellationToken = default)
        => TryGetRawReadonlyCoreAsync(policyId, CacheIdentity.FromInteger(identity), cancellationToken);

    private async Task<CacheReadResult<ReadOnlyMemory<byte>>> TryGetRawReadonlyCoreAsync(
        CachePolicyId policyId,
        CacheIdentity identity,
        CancellationToken cancellationToken)
    {
        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.get_raw_readonly", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "get_raw_readonly");
        string policyName = CachePolicyTelemetry.Name(policyId);
        FsusObservability.SetTag(activity, "fsus.cache.policy", policyName);
        CachePolicy policy = ResolvePolicy(policyId);
        CacheL1Key l1Key = identity.ToL1Key(keyScope.ScopeToken, policyId);
        cancellationToken.ThrowIfCancellationRequested();
        if (TryGetL1(l1Key, out byte[] l1Bytes))
        {
            FsusObservability.RecordCacheOperation("get_raw_readonly", policyName, "l1", "hit", FsusObservability.GetElapsed(startedAt));
            return new CacheReadResult<ReadOnlyMemory<byte>>(true, l1Bytes);
        }

        string key = BuildRedisKey(policy, identity);
        RedisValue l2Value = await ReadRedisAsync(key, "get_raw_readonly", policyName, activity, startedAt, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (!l2Value.HasValue)
        {
            FsusObservability.RecordCacheOperation("get_raw_readonly", policyName, "l2", "miss", FsusObservability.GetElapsed(startedAt));
            return new CacheReadResult<ReadOnlyMemory<byte>>(false, default);
        }

        byte[] bytes = (byte[])l2Value!;
        SetL1(policy, l1Key, key, bytes);
        FsusObservability.RecordCacheOperation("get_raw_readonly", policyName, "l2", "hit", FsusObservability.GetElapsed(startedAt));
        return new CacheReadResult<ReadOnlyMemory<byte>>(true, bytes);
    }

    public Task SetRawAsync(
        CachePolicyId policyId,
        string identity,
        byte[] value,
        TimeSpan? l2TtlOverride = null,
        CancellationToken cancellationToken = default)
        => SetRawCoreAsync(policyId, CacheIdentity.FromString(identity), value, l2TtlOverride, cancellationToken);

    public Task SetRawAsync(
        CachePolicyId policyId,
        int identity,
        byte[] value,
        TimeSpan? l2TtlOverride = null,
        CancellationToken cancellationToken = default)
        => SetRawCoreAsync(policyId, CacheIdentity.FromInteger(identity), value, l2TtlOverride, cancellationToken);

    private async Task SetRawCoreAsync(
        CachePolicyId policyId,
        CacheIdentity identity,
        byte[] value,
        TimeSpan? l2TtlOverride,
        CancellationToken cancellationToken)
    {
        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.set", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "set");
        string policyName = CachePolicyTelemetry.Name(policyId);
        FsusObservability.SetTag(activity, "fsus.cache.policy", policyName);
        cancellationToken.ThrowIfCancellationRequested();
        CachePolicy policy = ResolvePolicy(policyId);
        CacheL1Key l1Key = identity.ToL1Key(keyScope.ScopeToken, policyId);
        string key = BuildRedisKey(policy, identity);
        TimeSpan? l2Ttl = ResolveL2Expiry(key, policy, l2TtlOverride);
        byte[] cachedValue = CopyRawBytes(value);
        cancellationToken.ThrowIfCancellationRequested();
        await _db.StringSetAsync(key, cachedValue, l2Ttl, When.Always, CommandFlags.None).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        await RegisterKeyAsync(policyId, key).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        SetL1(policy, l1Key, key, cachedValue);
        FsusObservability.RecordCacheOperation("set", policyName, "l2", "ok", FsusObservability.GetElapsed(startedAt));
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
        string policyName = CachePolicyTelemetry.Name(policyId);
        FsusObservability.SetTag(activity, "fsus.cache.policy", policyName);
        CacheIdentity cacheIdentity = CacheIdentity.FromString(identity);
        CacheL1Key l1Key = cacheIdentity.ToL1Key(keyScope.ScopeToken, policyId);
        CachePolicy policy = ResolvePolicy(policyId);
        string key = BuildRedisKey(policy, cacheIdentity);
        string compareKey = BuildKey(policyId, compareIdentity);
        cancellationToken.ThrowIfCancellationRequested();
        TimeSpan? l2Ttl = ResolveL2Expiry(key, policy, l2TtlOverride);
        byte[] cachedValue = System.Text.Encoding.UTF8.GetBytes(value);
        RemoveL1(l1Key, key);
        cancellationToken.ThrowIfCancellationRequested();
        ITransaction transaction = _db.CreateTransaction();
        transaction.AddCondition(Condition.StringEqual(compareKey, expectedCompareValue));
        Task<bool> setTask = transaction.StringSetAsync(key, cachedValue, l2Ttl, When.Always, CommandFlags.None);
        bool committed = await transaction.ExecuteAsync(CommandFlags.None).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (!committed || !await setTask.ConfigureAwait(false))
        {
            FsusObservability.RecordCacheOperation("set_cas", policyName, "l2", "conflict", FsusObservability.GetElapsed(startedAt));
            return false;
        }

        await RegisterKeyAsync(policyId, key).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        SetL1(policy, l1Key, key, cachedValue);
        FsusObservability.RecordCacheOperation("set_cas", policyName, "l2", "ok", FsusObservability.GetElapsed(startedAt));
        return true;
    }

    public async Task<bool> TrySetVersionedStringAsync(
        CachePolicyId policyId,
        string identity,
        string value,
        string version,
        bool allowOverwrite = false,
        TimeSpan? l2TtlOverride = null,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(version))
        {
            throw new ArgumentException("Cache version must be non-empty.", nameof(version));
        }

        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.set_versioned", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "set_versioned");
        string policyName = CachePolicyTelemetry.Name(policyId);
        FsusObservability.SetTag(activity, "fsus.cache.policy", policyName);
        CacheIdentity cacheIdentity = CacheIdentity.FromString(identity);
        CacheL1Key l1Key = cacheIdentity.ToL1Key(keyScope.ScopeToken, policyId);
        CachePolicy policy = ResolvePolicy(policyId);
        string key = BuildRedisKey(policy, cacheIdentity);
        cancellationToken.ThrowIfCancellationRequested();
        TimeSpan? l2Ttl = ResolveL2Expiry(key, policy, l2TtlOverride);
        long ttlMilliseconds = l2Ttl.HasValue
            ? Math.Max(1L, (long)Math.Ceiling(l2Ttl.Value.TotalMilliseconds))
            : -1L;
        RemoveL1(l1Key, key);
        cancellationToken.ThrowIfCancellationRequested();
        const string script = """
local current = redis.call('GET', KEYS[1])
if current and ARGV[4] == '0' then
  local first = string.find(current, '|', 1, true)
  local second = nil
  if first then
    second = string.find(current, '|', first + 1, true)
  end
  if not first or not second or string.sub(current, 1, first - 1) ~= 'v1' then
    return 0
  end
  local currentVersion = string.sub(current, first + 1, second - 1)
  if currentVersion ~= ARGV[2] then
    return 0
  end
end
if tonumber(ARGV[3]) and tonumber(ARGV[3]) > 0 then
  redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[3])
else
  redis.call('SET', KEYS[1], ARGV[1])
end
return 1
""";
        RedisResult result = await _db.ScriptEvaluateAsync(
                script,
                [key],
                [value, version, ttlMilliseconds, allowOverwrite ? "1" : "0"],
                CommandFlags.None)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        bool updated = (long)result == 1L;
        if (!updated)
        {
            FsusObservability.RecordCacheOperation("set_versioned", policyName, "l2", "conflict", FsusObservability.GetElapsed(startedAt));
            return false;
        }

        await RegisterKeyAsync(policyId, key).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        SetL1(policy, l1Key, key, System.Text.Encoding.UTF8.GetBytes(value));
        FsusObservability.RecordCacheOperation("set_versioned", policyName, "l2", "ok", FsusObservability.GetElapsed(startedAt));
        return true;
    }

    public async Task<long> IncrementAsync(CachePolicyId policyId, string identity, long value = 1, CancellationToken cancellationToken = default)
    {
        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.increment", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "increment");
        FsusObservability.SetTag(activity, "fsus.cache.policy", CachePolicyTelemetry.Name(policyId));
        cancellationToken.ThrowIfCancellationRequested();
        string key = BuildKey(policyId, identity);
        RemoveL1(policyId, CacheIdentity.FromString(identity), key);
        cancellationToken.ThrowIfCancellationRequested();
        long updated = await _db.StringIncrementAsync(key, value).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        await RegisterKeyAsync(policyId, key).ConfigureAwait(false);
        FsusObservability.RecordCacheOperation("increment", CachePolicyTelemetry.Name(policyId), "l2", "ok", FsusObservability.GetElapsed(startedAt));
        return updated;
    }

    public async Task<long[]> IncrementManyAsync(
        CachePolicyId policyId,
        IReadOnlyList<string> identities,
        long value = 1,
        CancellationToken cancellationToken = default)
    {
        if (identities.Count == 0)
        {
            return [];
        }

        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.increment_many", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "increment_many");
        FsusObservability.SetTag(activity, "fsus.cache.policy", CachePolicyTelemetry.Name(policyId));
        cancellationToken.ThrowIfCancellationRequested();
        RedisKey[] keys = new RedisKey[identities.Count];
        string[] keyStrings = new string[identities.Count];
        for (int i = 0; i < identities.Count; i++)
        {
            string key = BuildKey(policyId, identities[i]);
            keyStrings[i] = key;
            keys[i] = key;
            RemoveL1(policyId, CacheIdentity.FromString(identities[i]), key);
        }

        cancellationToken.ThrowIfCancellationRequested();
        const string script = """
local result = {}
for i = 1, #KEYS do
  result[i] = redis.call('INCRBY', KEYS[i], ARGV[1])
end
return result
""";
        RedisResult result = await _db.ScriptEvaluateAsync(
                script,
                keys,
                [value],
                CommandFlags.None)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        RedisResult[] values = (RedisResult[])result!;
        if (values.Length != keys.Length)
        {
            throw new InvalidOperationException("Redis returned an invalid multi-counter increment result.");
        }

        long[] updated = new long[values.Length];
        for (int i = 0; i < keys.Length; i++)
        {
            updated[i] = (long)values[i];
            await RegisterKeyAsync(policyId, keyStrings[i]).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
        }

        FsusObservability.RecordCacheOperation("increment_many", CachePolicyTelemetry.Name(policyId), "l2", "ok", FsusObservability.GetElapsed(startedAt));
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
        FsusObservability.SetTag(activity, "fsus.cache.policy", CachePolicyTelemetry.Name(policyId));
        cancellationToken.ThrowIfCancellationRequested();
        string key = BuildKey(policyId, identity);
        RemoveL1(policyId, CacheIdentity.FromString(identity), key);
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
        FsusObservability.RecordCacheOperation("increment_expiring", CachePolicyTelemetry.Name(policyId), "l2", "ok", FsusObservability.GetElapsed(startedAt));
        return (long)result;
    }

    public async Task<long> IncrementClampedWithExpiryAsync(
        CachePolicyId policyId,
        string identity,
        long delta,
        long maxValue,
        TimeSpan ttl,
        CancellationToken cancellationToken = default)
    {
        if (ttl <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(ttl), "Counter expiry must be positive.");
        }

        if (maxValue < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(maxValue), "Counter max value must be non-negative.");
        }

        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.increment_clamped_expiring", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "increment_clamped_expiring");
        FsusObservability.SetTag(activity, "fsus.cache.policy", CachePolicyTelemetry.Name(policyId));
        cancellationToken.ThrowIfCancellationRequested();
        string key = BuildKey(policyId, identity);
        RemoveL1(policyId, CacheIdentity.FromString(identity), key);
        cancellationToken.ThrowIfCancellationRequested();
        long ttlMilliseconds = Math.Max(1L, (long)Math.Ceiling(ttl.TotalMilliseconds));
        delta = Math.Clamp(delta, -maxValue, maxValue);
        const string script = """
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
local nextValue = current + tonumber(ARGV[1])
local maxValue = tonumber(ARGV[2])
if nextValue < 0 then
  nextValue = 0
end
if nextValue > maxValue then
  nextValue = maxValue
end
redis.call('SET', KEYS[1], tostring(nextValue))
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return nextValue
""";
        RedisResult result = await _db.ScriptEvaluateAsync(
                script,
                [key],
                [delta, maxValue, ttlMilliseconds],
                CommandFlags.None)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        await RegisterKeyAsync(policyId, key).ConfigureAwait(false);
        FsusObservability.RecordCacheOperation("increment_clamped_expiring", CachePolicyTelemetry.Name(policyId), "l2", "ok", FsusObservability.GetElapsed(startedAt));
        return (long)result;
    }

    public async Task<long[]> IncrementManyWithExpiryAsync(
        CachePolicyId policyId,
        IReadOnlyList<string> identities,
        TimeSpan ttl,
        long value = 1,
        CancellationToken cancellationToken = default)
    {
        if (identities.Count == 0)
        {
            return [];
        }

        if (ttl <= TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(nameof(ttl), "Counter expiry must be positive.");
        }

        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.increment_many_expiring", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "increment_many_expiring");
        FsusObservability.SetTag(activity, "fsus.cache.policy", CachePolicyTelemetry.Name(policyId));
        cancellationToken.ThrowIfCancellationRequested();
        RedisKey[] keys = new RedisKey[identities.Count];
        string[] keyStrings = new string[identities.Count];
        for (int i = 0; i < identities.Count; i++)
        {
            string key = BuildKey(policyId, identities[i]);
            keyStrings[i] = key;
            keys[i] = key;
            RemoveL1(policyId, CacheIdentity.FromString(identities[i]), key);
        }

        cancellationToken.ThrowIfCancellationRequested();
        const string script = """
local result = {}
local expiryApplied = 0
for i = 1, #KEYS do
  result[i] = redis.call('INCRBY', KEYS[i], ARGV[1])
  if redis.call('PTTL', KEYS[i]) < 0 then
    redis.call('PEXPIRE', KEYS[i], ARGV[2])
    expiryApplied = expiryApplied + 1
  end
end
result[#KEYS + 1] = expiryApplied
return result
""";
        long ttlMilliseconds = Math.Max(1L, (long)Math.Ceiling(ttl.TotalMilliseconds));
        RedisResult result = await _db.ScriptEvaluateAsync(
                script,
                keys,
                [value, ttlMilliseconds],
                CommandFlags.None)
            .ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        RedisResult[] values = (RedisResult[])result!;
        if (values.Length != keys.Length && values.Length != keys.Length + 1)
        {
            throw new InvalidOperationException("Redis returned an invalid expiring multi-counter increment result.");
        }

        long expiryApplied = values.Length == keys.Length + 1 ? (long)values[^1] : 0;
        long[] updated = new long[keys.Length];
        for (int i = 0; i < keys.Length; i++)
        {
            updated[i] = (long)values[i];
            await RegisterKeyAsync(policyId, keyStrings[i]).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
        }

        TimeSpan elapsed = FsusObservability.GetElapsed(startedAt);
        string policyName = CachePolicyTelemetry.Name(policyId);
        FsusObservability.RecordCacheOperation("increment_many_expiring", policyName, "l2", "ok", elapsed);
        FsusObservability.RecordIncrementManyWithExpiry(policyName, keys.Length, expiryApplied, elapsed);
        if (policyId == CachePolicyId.SecurityMfaChallenge)
        {
            FsusObservability.RecordMfaCounterExpired(expiryApplied);
        }

        return updated;
    }

    public async Task<bool> TryAcquireLeaseAsync(CachePolicyId policyId, string identity, string value, TimeSpan ttl, CancellationToken cancellationToken = default)
    {
        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.lease", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "lease");
        FsusObservability.SetTag(activity, "fsus.cache.policy", CachePolicyTelemetry.Name(policyId));
        string key = BuildKey(policyId, identity);
        bool acquired = await _db.StringSetAsync(key, value, ttl, When.NotExists).ConfigureAwait(false);
        FsusObservability.RecordCacheOperation("lease", CachePolicyTelemetry.Name(policyId), "l2", acquired ? "acquired" : "contended", FsusObservability.GetElapsed(startedAt));
        return acquired;
    }

    public async Task<bool> ConsumeOnceAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
    {
        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.consume_once", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "consume_once");
        FsusObservability.SetTag(activity, "fsus.cache.policy", CachePolicyTelemetry.Name(policyId));
        cancellationToken.ThrowIfCancellationRequested();
        string key = BuildKey(policyId, identity);
        RemoveL1(policyId, CacheIdentity.FromString(identity), key);
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

        FsusObservability.RecordCacheOperation("consume_once", CachePolicyTelemetry.Name(policyId), "l2", ok ? "consumed" : "miss", FsusObservability.GetElapsed(startedAt));
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
        FsusObservability.SetTag(activity, "fsus.cache.policy", CachePolicyTelemetry.Name(policyId));
        cancellationToken.ThrowIfCancellationRequested();
        string key = BuildKey(policyId, identity);
        RemoveL1(policyId, CacheIdentity.FromString(identity), key);
        cancellationToken.ThrowIfCancellationRequested();
        RedisValue value = await _db.StringGetDeleteAsync(key).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        if (!value.HasValue)
        {
            FsusObservability.RecordCacheOperation("consume_once_get", CachePolicyTelemetry.Name(policyId), "l2", "miss", FsusObservability.GetElapsed(startedAt));
            return new CacheReadResult<T>(false, default);
        }

        byte[] bytes = (byte[])value!;
        if (bytes.Length == 0)
        {
            await UnregisterKeyAsync(policyId, key, cancellationToken).ConfigureAwait(false);
            FsusObservability.RecordCacheOperation("consume_once_get", CachePolicyTelemetry.Name(policyId), "l2", "hit_negative", FsusObservability.GetElapsed(startedAt));
            return new CacheReadResult<T>(true, default);
        }

        var (success, decoded) = decoder(bytes);
        if (!success)
        {
            await UnregisterKeyAsync(policyId, key, cancellationToken).ConfigureAwait(false);
            FsusObservability.RecordCacheOperation("consume_once_get", CachePolicyTelemetry.Name(policyId), "l2", "decode_failed", FsusObservability.GetElapsed(startedAt));
            return new CacheReadResult<T>(false, default);
        }

        await UnregisterKeyAsync(policyId, key, cancellationToken).ConfigureAwait(false);
        FsusObservability.RecordCacheOperation("consume_once_get", CachePolicyTelemetry.Name(policyId), "l2", "consumed", FsusObservability.GetElapsed(startedAt));
        return new CacheReadResult<T>(true, decoded);
    }

    public Task RemoveAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
        => RemoveCoreAsync(policyId, CacheIdentity.FromString(identity), cancellationToken);

    public Task RemoveAsync(CachePolicyId policyId, int identity, CancellationToken cancellationToken = default)
        => RemoveCoreAsync(policyId, CacheIdentity.FromInteger(identity), cancellationToken);

    private async Task RemoveCoreAsync(CachePolicyId policyId, CacheIdentity identity, CancellationToken cancellationToken)
    {
        long startedAt = Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.remove", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "remove");
        string policyName = CachePolicyTelemetry.Name(policyId);
        FsusObservability.SetTag(activity, "fsus.cache.policy", policyName);
        CachePolicy policy = ResolvePolicy(policyId);
        string key = BuildRedisKey(policy, identity);
        RemoveL1(policyId, identity, key);
        await _db.KeyDeleteAsync(key).ConfigureAwait(false);
        await UnregisterKeyAsync(policyId, key).ConfigureAwait(false);
        FsusObservability.RecordCacheOperation("remove", policyName, "l2", "ok", FsusObservability.GetElapsed(startedAt));
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

            RemoveL1(identity.PolicyId, CacheIdentity.FromString(identity.Identity), key);
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
        string policyName = CachePolicyTelemetry.Name(policyId);
        FsusObservability.SetTag(activity, "fsus.cache.policy", policyName);
        CachePolicy policy = ResolvePolicy(policyId);
        string prefix = keyScope.PrefixKey(policy.BuildKey(identityPrefix));
        string registryKey = ResolveRegistryKey(policyId);
        bool registryExists = await _db.KeyExistsAsync(registryKey).ConfigureAwait(false);
        if (registryExists)
        {
            await DeleteRegisteredKeysByPrefixAsync(registryKey, prefix, cancellationToken).ConfigureAwait(false);
            FsusObservability.RecordCacheOperation("remove_prefix", policyName, "l2", "ok", FsusObservability.GetElapsed(startedAt));

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
                policyName,
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
            FsusObservability.RecordCacheOperation("remove_prefix", policyName, "l2", "registry_missing_scan_failed", FsusObservability.GetElapsed(startedAt));
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

    public async Task<IReadOnlyList<CachePolicyStorageSnapshot>> GetPolicyStorageSnapshotsAsync(
        IReadOnlyList<CachePolicyId> policyIds,
        CancellationToken cancellationToken = default)
    {
        if (policyIds.Count == 0)
        {
            return Array.Empty<CachePolicyStorageSnapshot>();
        }

        var snapshots = new List<CachePolicyStorageSnapshot>(policyIds.Count);
        foreach (CachePolicyId policyId in policyIds)
        {
            cancellationToken.ThrowIfCancellationRequested();
            string registryKey = ResolveRegistryKey(policyId);
            long keyCount = 0;
            long bytes = 0;
            foreach (RedisValue registeredKey in _db.SetScan(registryKey, pageSize: PrefixInvalidationBatchSize))
            {
                cancellationToken.ThrowIfCancellationRequested();
                if (!registeredKey.HasValue)
                {
                    continue;
                }

                keyCount++;
                bytes += await _db.StringLengthAsync((RedisKey)registeredKey.ToString()).ConfigureAwait(false);
            }

            snapshots.Add(new CachePolicyStorageSnapshot(policyId, keyCount, bytes));
        }

        return snapshots;
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
            RemoveL1ByRedisKey(value);

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
            RemoveL1ByRedisKey(value);

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
                RemoveL1ByRedisKey(keyText);

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
                RemoveL1ByRedisKey(keyText);

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

    private string BuildRedisKey(CachePolicy policy, CacheIdentity identity)
        => keyScope.PrefixKey(identity.BuildRedisKey(policy));

    private async Task<RedisValue> ReadRedisAsync(
        string key,
        string operation,
        string policyName,
        Activity? activity,
        long startedAt,
        CancellationToken cancellationToken)
    {
        try
        {
            return await _db.StringGetAsync(key).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception exception)
        {
            activity?.SetStatus(ActivityStatusCode.Error, "redis_read_failed");
            activity?.AddEvent(new ActivityEvent(
                "redis.read.failed",
                tags: new ActivityTagsCollection
                {
                    ["exception.type"] = exception.GetType().FullName
                }));
            logger.LogError(exception, "Cache Redis read failed for policy {PolicyId} operation {Operation}", policyName, operation);
            FsusObservability.RecordCacheOperation(operation, policyName, "l2", "redis_error", FsusObservability.GetElapsed(startedAt));
            throw;
        }
    }

    private void SetL1(CachePolicy policy, CacheL1Key l1Key, string redisKey, byte[] bytes)
    {
        if (policy.L1Ttl <= TimeSpan.Zero)
        {
            return;
        }

        var options = new MemoryCacheEntryOptions
        {
            AbsoluteExpirationRelativeToNow = policy.L1Ttl
        };
        long ttlTimestampDelta = (long)Math.Ceiling(policy.L1Ttl.TotalSeconds * Stopwatch.Frequency);
        long expiresAtTimestamp = Stopwatch.GetTimestamp() + Math.Max(1L, ttlTimestampDelta);
        var indexEntry = new L1IndexEntry(l1Key, redisKey, CopyRawBytes(bytes), expiresAtTimestamp);
        options.RegisterPostEvictionCallback(
            static (_, _, _, state) =>
            {
                if (state is L1EvictionState eviction)
                {
                    eviction.Owner._l1Entries.TryRemove(
                        new KeyValuePair<CacheL1Key, L1IndexEntry>(eviction.IndexEntry.L1Key, eviction.IndexEntry));
                    eviction.Owner._l1KeysByRedisKey.TryRemove(
                        new KeyValuePair<string, L1IndexEntry>(eviction.RedisKey, eviction.IndexEntry));
                }
            },
            new L1EvictionState(this, redisKey, indexEntry));
        lock (_l1MutationLock)
        {
            _l1Entries.TryGetValue(l1Key, out L1IndexEntry? previousL1Entry);
            _l1KeysByRedisKey.TryGetValue(redisKey, out L1IndexEntry? previousRedisEntry);
            _l1Entries[l1Key] = indexEntry;
            _l1KeysByRedisKey[redisKey] = indexEntry;
            memoryCache.Set(indexEntry, true, options);
            RemoveSupersededL1Entry(previousL1Entry, indexEntry);
            RemoveSupersededL1Entry(previousRedisEntry, indexEntry);
        }
    }

    private bool TryGetL1(CacheL1Key l1Key, out byte[] bytes)
    {
        if (_l1Entries.TryGetValue(l1Key, out L1IndexEntry? entry))
        {
            if (Stopwatch.GetTimestamp() < entry.ExpiresAtTimestamp)
            {
                bytes = entry.Bytes;
                return true;
            }

            _l1Entries.TryRemove(new KeyValuePair<CacheL1Key, L1IndexEntry>(l1Key, entry));
            _l1KeysByRedisKey.TryRemove(new KeyValuePair<string, L1IndexEntry>(entry.RedisKey, entry));
            memoryCache.Remove(entry);
        }

        bytes = null!;
        return false;
    }

    private void RemoveL1(CacheL1Key l1Key, string? redisKey = null)
    {
        lock (_l1MutationLock)
        {
            if (_l1Entries.TryRemove(l1Key, out L1IndexEntry? directEntry))
            {
                memoryCache.Remove(directEntry);
            }

            if (redisKey is not null)
            {
                if (_l1KeysByRedisKey.TryRemove(redisKey, out L1IndexEntry? indexed)
                    && !ReferenceEquals(indexed, directEntry))
                {
                    _l1Entries.TryRemove(new KeyValuePair<CacheL1Key, L1IndexEntry>(indexed.L1Key, indexed));
                    memoryCache.Remove(indexed);
                }

                memoryCache.Remove(redisKey); // rolling-upgrade cleanup for legacy string L1 keys
            }
        }
    }

    private void RemoveL1(CachePolicyId policyId, CacheIdentity identity, string redisKey)
        => RemoveL1(identity.ToL1Key(keyScope.ScopeToken, policyId), redisKey);

    private void RemoveL1ByRedisKey(string redisKey)
    {
        lock (_l1MutationLock)
        {
            if (_l1KeysByRedisKey.TryRemove(redisKey, out L1IndexEntry? indexEntry))
            {
                _l1Entries.TryRemove(new KeyValuePair<CacheL1Key, L1IndexEntry>(indexEntry.L1Key, indexEntry));
                memoryCache.Remove(indexEntry);
            }

            memoryCache.Remove(redisKey); // rolling-upgrade cleanup for legacy string L1 keys
        }
    }

    private void RemoveSupersededL1Entry(L1IndexEntry? previous, L1IndexEntry current)
    {
        if (previous is null || ReferenceEquals(previous, current))
        {
            return;
        }

        _l1Entries.TryRemove(new KeyValuePair<CacheL1Key, L1IndexEntry>(previous.L1Key, previous));
        memoryCache.Remove(previous);
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

        CacheIdentity cacheIdentity = CacheIdentity.FromString(identity);
        CacheL1Key l1Key = cacheIdentity.ToL1Key(keyScope.ScopeToken, policyId);
        string key = BuildRedisKey(policy, cacheIdentity);
        await _db.StringSetAsync(key, Array.Empty<byte>(), policy.NegativeTtl).ConfigureAwait(false);
        await RegisterKeyAsync(policyId, key).ConfigureAwait(false);
        SetL1(policy, l1Key, key, Array.Empty<byte>());
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

    private sealed class L1IndexEntry(CacheL1Key l1Key, string redisKey, byte[] bytes, long expiresAtTimestamp)
    {
        public CacheL1Key L1Key { get; } = l1Key;
        public string RedisKey { get; } = redisKey;
        public byte[] Bytes { get; } = bytes;
        public long ExpiresAtTimestamp { get; } = expiresAtTimestamp;
    }
    private sealed record L1EvictionState(UnifiedCache Owner, string RedisKey, L1IndexEntry IndexEntry);

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
