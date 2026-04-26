using System.Text.Json;
using Microsoft.Extensions.Caching.Memory;
using StackExchange.Redis;
using System.Net;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Execution;

namespace FsusBlog.Server.Infrastructure.Cache;

public readonly record struct CacheReadResult<T>(bool Hit, T? Value);

public interface IUnifiedCache
{
    Task<CacheReadResult<T>> TryGetAsync<T>(CachePolicyId policyId, string identity, Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder, CancellationToken cancellationToken = default);
    Task<CacheReadResult<T>> TryGetJsonAsync<T>(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default);
    Task<T?> GetOrLoadJsonAsync<T>(CachePolicyId policyId, string identity, Func<CancellationToken, Task<T?>> loader, bool cacheNull = false, CancellationToken cancellationToken = default);
    Task SetJsonAsync<T>(CachePolicyId policyId, string identity, T value, CancellationToken cancellationToken = default);
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
    ILogger<UnifiedCache> logger) : IUnifiedCache
{
    private static readonly TimeSpan MissingPolicyL2Ttl = TimeSpan.FromMinutes(5);
    private const string RegistryKeyPrefix = "cache:registry:";
    private static readonly JsonSerializerOptions JsonOptions = new(JsonSerializerDefaults.Web)
    {
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull
    };

    private readonly IDatabase _db = redis.GetDatabase();

    public string BuildKey(CachePolicyId policyId, string identity, string? version = null)
    {
        return ResolvePolicy(policyId).BuildKey(identity, version);
    }

    public async Task<CacheReadResult<T>> TryGetAsync<T>(
        CachePolicyId policyId,
        string identity,
        Func<ReadOnlyMemory<byte>, (bool Success, T? Value)> decoder,
        CancellationToken cancellationToken = default)
    {
        string key = BuildKey(policyId, identity);
        if (memoryCache.TryGetValue(key, out byte[]? l1Bytes) && l1Bytes is not null)
        {
            if (l1Bytes.Length == 0)
            {
                return new CacheReadResult<T>(true, default);
            }

            var (l1Success, l1Value) = decoder(l1Bytes);
            if (l1Success)
            {
                return new CacheReadResult<T>(true, l1Value);
            }

            memoryCache.Remove(key);
            await _db.KeyDeleteAsync(key).ConfigureAwait(false);
            await UnregisterKeyAsync(policyId, key).ConfigureAwait(false);
            return new CacheReadResult<T>(false, default);
        }

        RedisValue l2Value = await _db.StringGetAsync(key).ConfigureAwait(false);
        if (!l2Value.HasValue)
        {
            return new CacheReadResult<T>(false, default);
        }

        byte[] bytes = (byte[])l2Value!;
        if (bytes.Length == 0)
        {
            SetL1(policyId, key, bytes);
            return new CacheReadResult<T>(true, default);
        }

        var (success, value) = decoder(bytes);
        if (!success)
        {
            await _db.KeyDeleteAsync(key).ConfigureAwait(false);
            await UnregisterKeyAsync(policyId, key).ConfigureAwait(false);
            return new CacheReadResult<T>(false, default);
        }

        SetL1(policyId, key, bytes);
        return new CacheReadResult<T>(true, value);
    }

    public async Task<CacheReadResult<T>> TryGetJsonAsync<T>(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
    {
        return await TryGetAsync<T>(policyId, identity, bytes =>
        {
            Result<T?> result = BoundaryExecutor.ExecuteResult(
                () => JsonSerializer.Deserialize<T>(bytes.Span, JsonOptions),
                static _ => ErrorDetail.Create(ErrorCode.Validation, "cache_json_deserialize_failed"),
                logger,
                $"cache-json-deserialize:{typeof(T).Name}",
                LogLevel.Debug);

            return result.IsSuccess
                ? (true, result.Value)
                : (false, default);
        }, cancellationToken);
    }

    public async Task<T?> GetOrLoadJsonAsync<T>(
        CachePolicyId policyId,
        string identity,
        Func<CancellationToken, Task<T?>> loader,
        bool cacheNull = false,
        CancellationToken cancellationToken = default)
    {
        CacheReadResult<T> hit = await TryGetJsonAsync<T>(policyId, identity, cancellationToken);
        if (hit.Hit)
        {
            return hit.Value;
        }

        await using IAsyncDisposable guard = await AcquireSingleFlightAsync(policyId, identity, cancellationToken);
        hit = await TryGetJsonAsync<T>(policyId, identity, cancellationToken);
        if (hit.Hit)
        {
            return hit.Value;
        }

        T? loaded = await loader(cancellationToken);
        if (loaded is null)
        {
            if (cacheNull)
            {
                await SetNegativeAsync(policyId, identity, cancellationToken);
            }

            return default;
        }

        await SetJsonAsync(policyId, identity, loaded, cancellationToken);
        return loaded;
    }

    public async Task SetJsonAsync<T>(CachePolicyId policyId, string identity, T value, CancellationToken cancellationToken = default)
    {
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(value, JsonOptions);
        await SetRawAsync(policyId, identity, bytes, null, cancellationToken);
    }

    public async Task SetRawAsync(
        CachePolicyId policyId,
        string identity,
        byte[] value,
        TimeSpan? l2TtlOverride = null,
        CancellationToken cancellationToken = default)
    {
        string key = BuildKey(policyId, identity);
        CachePolicy policy = ResolvePolicy(policyId);
        TimeSpan l2Ttl = l2TtlOverride ?? ApplyDeterministicJitter(key, policy.L2Ttl, policy.L2JitterRatio);
        await _db.StringSetAsync(key, value, l2Ttl).ConfigureAwait(false);
        await RegisterKeyAsync(policyId, key).ConfigureAwait(false);
        SetL1(policyId, key, value);
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
        string key = BuildKey(policyId, identity);
        long updated = await _db.StringIncrementAsync(key, value).ConfigureAwait(false);
        await RegisterKeyAsync(policyId, key).ConfigureAwait(false);
        memoryCache.Remove(key);
        return updated;
    }

    public async Task<bool> TryAcquireLeaseAsync(CachePolicyId policyId, string identity, string value, TimeSpan ttl, CancellationToken cancellationToken = default)
    {
        string key = BuildKey(policyId, identity);
        return await _db.StringSetAsync(key, value, ttl, When.NotExists).ConfigureAwait(false);
    }

    public async Task<bool> ConsumeOnceAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
    {
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

        return ok;
    }

    public async Task RemoveAsync(CachePolicyId policyId, string identity, CancellationToken cancellationToken = default)
    {
        string key = BuildKey(policyId, identity);
        memoryCache.Remove(key);
        await _db.KeyDeleteAsync(key).ConfigureAwait(false);
        await UnregisterKeyAsync(policyId, key).ConfigureAwait(false);
    }

    public async Task RemoveByPrefixAsync(CachePolicyId policyId, string identityPrefix, CancellationToken cancellationToken = default)
    {
        CachePolicy policy = ResolvePolicy(policyId);
        string prefix = policy.BuildKey(identityPrefix);
        string registryKey = BuildRegistryKey(policyId);
        bool registryExists = await _db.KeyExistsAsync(registryKey).ConfigureAwait(false);
        if (registryExists)
        {
            RedisValue[] registeredKeys = await _db.SetMembersAsync(registryKey).ConfigureAwait(false);
            foreach (string value in FilterRegistryKeys(prefix, registeredKeys))
            {
                cancellationToken.ThrowIfCancellationRequested();
                await _db.KeyDeleteAsync(value).ConfigureAwait(false);
                await _db.SetRemoveAsync(registryKey, value).ConfigureAwait(false);
                memoryCache.Remove(value);
            }

            return;
        }

        EndPoint[] endpoints = redis.GetEndPoints();
        foreach (EndPoint endpoint in endpoints)
        {
            IServer server = redis.GetServer(endpoint);
            if (!server.IsConnected)
            {
                continue;
            }

            IEnumerable<RedisKey> keys = server.Keys(database: _db.Database, pattern: prefix + "*", pageSize: 512);
            foreach (RedisKey key in keys)
            {
                cancellationToken.ThrowIfCancellationRequested();
                await _db.KeyDeleteAsync(key).ConfigureAwait(false);
                memoryCache.Remove((string)key!);
                await UnregisterKeyAsync(policyId, key!).ConfigureAwait(false);
            }
        }
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

        memoryCache.Set(key, bytes, policy.L1Ttl);
    }

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
            async () => _ = await _db.SetAddAsync(BuildRegistryKey(policyId), key).ConfigureAwait(false),
            logger,
            $"cache-register:{policyId}:{key}",
            LogLevel.Debug);
    }

    private async Task UnregisterKeyAsync(CachePolicyId policyId, string key)
    {
        await BoundaryExecutor.ExecuteAsync(
            async () => _ = await _db.SetRemoveAsync(BuildRegistryKey(policyId), key).ConfigureAwait(false),
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
