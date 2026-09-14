using System.Buffers;
using System.Text;

using Microsoft.Extensions.Caching.Distributed;

using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.Cache;

internal sealed record SharedRedisDistributedCacheOptions(string InstanceName);

/// <summary>
/// Implements the standard distributed-cache wire shape without owning the shared Redis connection.
/// </summary>
internal sealed class SharedRedisDistributedCache : IBufferDistributedCache
{
    private const string AbsoluteExpirationKey = "absexp";
    private const string SlidingExpirationKey = "sldexp";
    private const string DataKey = "data";
    private const long NotPresent = -1;

    private static readonly RedisValue[] s_metadataAndDataFields =
        [AbsoluteExpirationKey, SlidingExpirationKey, DataKey];
    private static readonly RedisValue[] s_metadataFields =
        [AbsoluteExpirationKey, SlidingExpirationKey];

    private readonly IRedisOperationExecutor _redisOperations;
    private readonly IConnectionMultiplexer? _testConnection;
    private readonly RedisKey _instancePrefix;

    public SharedRedisDistributedCache(
        IRedisOperationExecutor redisOperations,
        SharedRedisDistributedCacheOptions options)
    {
        _redisOperations = redisOperations;
        if (!string.IsNullOrEmpty(options.InstanceName))
        {
            _instancePrefix = Encoding.UTF8.GetBytes(options.InstanceName);
        }
    }

    internal SharedRedisDistributedCache(
        IConnectionMultiplexer connection,
        SharedRedisDistributedCacheOptions options)
        : this(
            new RedisOperationExecutor(
                new DirectConnectionProvider(connection),
                new RedisOperationBudgetCatalog(),
                TimeProvider.System),
            options)
    {
        _testConnection = connection;
    }

    internal IConnectionMultiplexer Connection
        => _testConnection ?? throw new InvalidOperationException("shared_redis_connection_is_executor_owned");

    public byte[]? Get(string key)
    {
        ArgumentNullException.ThrowIfNull(key);
        throw SyncOperationNotSupported();
    }

    public async Task<byte[]?> GetAsync(string key, CancellationToken token = default)
    {
        ArgumentNullException.ThrowIfNull(key);
        token.ThrowIfCancellationRequested();
        return await GetAndRefreshAsync(key, getData: true, token).ConfigureAwait(false);
    }

    public void Set(string key, byte[] value, DistributedCacheEntryOptions options)
    {
        ArgumentNullException.ThrowIfNull(key);
        ArgumentNullException.ThrowIfNull(value);
        ArgumentNullException.ThrowIfNull(options);
        throw SyncOperationNotSupported();
    }

    void IBufferDistributedCache.Set(
        string key,
        ReadOnlySequence<byte> value,
        DistributedCacheEntryOptions options)
        => throw SyncOperationNotSupported();

    public async Task SetAsync(
        string key,
        byte[] value,
        DistributedCacheEntryOptions options,
        CancellationToken token = default)
    {
        ArgumentNullException.ThrowIfNull(value);
        await SetCoreAsync(key, new ReadOnlySequence<byte>(value), options, token).ConfigureAwait(false);
    }

    ValueTask IBufferDistributedCache.SetAsync(
        string key,
        ReadOnlySequence<byte> value,
        DistributedCacheEntryOptions options,
        CancellationToken token)
        => new(SetCoreAsync(key, value, options, token));

    bool IBufferDistributedCache.TryGet(string key, IBufferWriter<byte> destination)
    {
        ArgumentNullException.ThrowIfNull(key);
        ArgumentNullException.ThrowIfNull(destination);

        throw SyncOperationNotSupported();
    }

    async ValueTask<bool> IBufferDistributedCache.TryGetAsync(
        string key,
        IBufferWriter<byte> destination,
        CancellationToken token)
    {
        ArgumentNullException.ThrowIfNull(key);
        ArgumentNullException.ThrowIfNull(destination);
        token.ThrowIfCancellationRequested();

        byte[]? data = await GetAndRefreshAsync(key, getData: true, token).ConfigureAwait(false);
        if (data is null)
        {
            return false;
        }

        token.ThrowIfCancellationRequested();
        destination.Write(data);
        return true;
    }

    private async Task SetCoreAsync(
        string key,
        ReadOnlySequence<byte> value,
        DistributedCacheEntryOptions options,
        CancellationToken token)
    {
        ArgumentNullException.ThrowIfNull(key);
        ArgumentNullException.ThrowIfNull(options);
        token.ThrowIfCancellationRequested();

        DateTimeOffset creationTime = DateTimeOffset.UtcNow;
        DateTimeOffset? absoluteExpiration = GetAbsoluteExpiration(creationTime, options);
        RedisKey redisKey = BuildKey(key);
        ReadOnlyMemory<byte> payload = Linearize(value, out byte[]? lease);
        HashEntry[] fields = GetHashFields(payload, absoluteExpiration, options.SlidingExpiration);
        long? ttlSeconds = GetExpirationInSeconds(creationTime, absoluteExpiration, options);
        try
        {
            _ = await _redisOperations.ExecuteAsync(
                RedisOperationPort.SharedDistributedCacheWrite,
                async (multiplexer, commandCancellation) =>
                {
                    commandCancellation.ThrowIfCancellationRequested();
                    IDatabase database = multiplexer.GetDatabase();
                    await database.HashSetAsync(redisKey, fields).ConfigureAwait(false);
                    if (ttlSeconds.HasValue)
                    {
                        _ = await database.KeyExpireAsync(
                            redisKey,
                            TimeSpan.FromSeconds(ttlSeconds.Value)).ConfigureAwait(false);
                    }
                    return true;
                },
                token).ConfigureAwait(false);
        }
        catch (RedisOperationUnavailableException exception)
            when (exception.Port.OperationClass == RedisOperationClass.ContentCacheWrite)
        {
            // IDistributedCache is a best-effort cache boundary. The classified
            // executor records the degraded write and the caller's business result
            // remains authoritative.
        }
        finally
        {
            Recycle(lease);
        }
    }

    public void Refresh(string key)
    {
        ArgumentNullException.ThrowIfNull(key);
        throw SyncOperationNotSupported();
    }

    public async Task RefreshAsync(string key, CancellationToken token = default)
    {
        ArgumentNullException.ThrowIfNull(key);
        token.ThrowIfCancellationRequested();
        _ = await GetAndRefreshAsync(key, getData: false, token).ConfigureAwait(false);
    }

    public void Remove(string key)
    {
        ArgumentNullException.ThrowIfNull(key);
        throw SyncOperationNotSupported();
    }

    public async Task RemoveAsync(string key, CancellationToken token = default)
    {
        ArgumentNullException.ThrowIfNull(key);
        token.ThrowIfCancellationRequested();
        try
        {
            _ = await _redisOperations.ExecuteAsync(
                RedisOperationPort.SharedDistributedCacheWrite,
                (multiplexer, _) => multiplexer.GetDatabase().KeyDeleteAsync(BuildKey(key)),
                token).ConfigureAwait(false);
        }
        catch (RedisOperationUnavailableException exception)
            when (exception.Port.OperationClass == RedisOperationClass.ContentCacheWrite)
        {
            // Deletion failure leaves only stale cache state; the executor exposes
            // the degraded action without failing the business request.
        }
    }

    private async Task<byte[]?> GetAndRefreshAsync(string key, bool getData, CancellationToken token)
    {
        RedisKey redisKey = BuildKey(key);
        RedisValue[] values;
        try
        {
            values = await _redisOperations.ExecuteAsync(
                RedisOperationPort.SharedDistributedCacheRead,
                (multiplexer, _) => multiplexer.GetDatabase().HashGetAsync(
                    redisKey,
                    getData ? s_metadataAndDataFields : s_metadataFields),
                token).ConfigureAwait(false);
        }
        catch (RedisOperationUnavailableException exception)
            when (exception.Port.OperationClass == RedisOperationClass.ContentCacheRead)
        {
            return null;
        }
        token.ThrowIfCancellationRequested();
        await RefreshSlidingExpirationAsync(redisKey, values, token).ConfigureAwait(false);
        return getData && values.Length >= 3 && !values[2].IsNull
            ? (byte[]?)values[2]
            : null;
    }

    private async Task RefreshSlidingExpirationAsync(
        RedisKey key,
        RedisValue[] values,
        CancellationToken cancellationToken)
    {
        MapMetadata(values, out DateTimeOffset? absoluteExpiration, out TimeSpan? slidingExpiration);
        if (slidingExpiration.HasValue)
        {
            try
            {
                _ = await _redisOperations.ExecuteAsync(
                    RedisOperationPort.SharedDistributedCacheWrite,
                    (multiplexer, _) => multiplexer.GetDatabase().KeyExpireAsync(
                        key,
                        ResolveRefreshTtl(absoluteExpiration, slidingExpiration.Value)),
                    cancellationToken).ConfigureAwait(false);
            }
            catch (RedisOperationUnavailableException exception)
                when (exception.Port.OperationClass == RedisOperationClass.ContentCacheWrite)
            {
                // Refresh is optional once the cached value has already been read.
            }
        }
    }

    private RedisKey BuildKey(string key)
        => _instancePrefix.Append(key);

    private static NotSupportedException SyncOperationNotSupported()
        => new("redis_sync_operation_forbidden");

    private static ReadOnlyMemory<byte> Linearize(ReadOnlySequence<byte> value, out byte[]? lease)
    {
        if (value.IsSingleSegment)
        {
            lease = null;
            return value.First;
        }

        int length = checked((int)value.Length);
        lease = ArrayPool<byte>.Shared.Rent(length);
        value.CopyTo(lease);
        return new ReadOnlyMemory<byte>(lease, 0, length);
    }

    private static void Recycle(byte[]? lease)
    {
        if (lease is not null)
        {
            ArrayPool<byte>.Shared.Return(lease);
        }
    }

    private static HashEntry[] GetHashFields(
        RedisValue value,
        DateTimeOffset? absoluteExpiration,
        TimeSpan? slidingExpiration)
        =>
        [
            new HashEntry(AbsoluteExpirationKey, absoluteExpiration?.Ticks ?? NotPresent),
            new HashEntry(SlidingExpirationKey, slidingExpiration?.Ticks ?? NotPresent),
            new HashEntry(DataKey, value)
        ];

    private static void MapMetadata(
        RedisValue[] values,
        out DateTimeOffset? absoluteExpiration,
        out TimeSpan? slidingExpiration)
    {
        absoluteExpiration = null;
        slidingExpiration = null;
        if (values.Length < 2)
        {
            return;
        }

        long? absoluteExpirationTicks = (long?)values[0];
        if (absoluteExpirationTicks.HasValue && absoluteExpirationTicks.Value != NotPresent)
        {
            absoluteExpiration = new DateTimeOffset(absoluteExpirationTicks.Value, TimeSpan.Zero);
        }

        long? slidingExpirationTicks = (long?)values[1];
        if (slidingExpirationTicks.HasValue && slidingExpirationTicks.Value != NotPresent)
        {
            slidingExpiration = new TimeSpan(slidingExpirationTicks.Value);
        }
    }

    private static TimeSpan ResolveRefreshTtl(DateTimeOffset? absoluteExpiration, TimeSpan slidingExpiration)
    {
        if (!absoluteExpiration.HasValue)
        {
            return slidingExpiration;
        }

        TimeSpan remaining = absoluteExpiration.Value - DateTimeOffset.UtcNow;
        return remaining <= slidingExpiration ? remaining : slidingExpiration;
    }

    private static long? GetExpirationInSeconds(
        DateTimeOffset creationTime,
        DateTimeOffset? absoluteExpiration,
        DistributedCacheEntryOptions options)
    {
        if (absoluteExpiration.HasValue && options.SlidingExpiration.HasValue)
        {
            return (long)Math.Min(
                (absoluteExpiration.Value - creationTime).TotalSeconds,
                options.SlidingExpiration.Value.TotalSeconds);
        }

        if (absoluteExpiration.HasValue)
        {
            return (long)(absoluteExpiration.Value - creationTime).TotalSeconds;
        }

        if (options.SlidingExpiration.HasValue)
        {
            return (long)options.SlidingExpiration.Value.TotalSeconds;
        }

        return null;
    }

    private static DateTimeOffset? GetAbsoluteExpiration(
        DateTimeOffset creationTime,
        DistributedCacheEntryOptions options)
    {
        if (options.AbsoluteExpiration.HasValue && options.AbsoluteExpiration <= creationTime)
        {
            throw new ArgumentOutOfRangeException(
                nameof(DistributedCacheEntryOptions.AbsoluteExpiration),
                options.AbsoluteExpiration.Value,
                "The absolute expiration value must be in the future.");
        }

        return options.AbsoluteExpirationRelativeToNow.HasValue
            ? creationTime + options.AbsoluteExpirationRelativeToNow
            : options.AbsoluteExpiration;
    }

    private sealed class DirectConnectionProvider(IConnectionMultiplexer connection) : IRedisConnectionProvider
    {
        public Task<IConnectionMultiplexer> WaitAsync() => Task.FromResult(connection);
    }
}
