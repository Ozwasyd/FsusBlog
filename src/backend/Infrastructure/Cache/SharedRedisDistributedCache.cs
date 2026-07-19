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

    private readonly IConnectionMultiplexer _connection;
    private readonly IDatabase _database;
    private readonly RedisKey _instancePrefix;

    public SharedRedisDistributedCache(
        IConnectionMultiplexer connection,
        SharedRedisDistributedCacheOptions options)
    {
        _connection = connection;
        _database = connection.GetDatabase();
        if (!string.IsNullOrEmpty(options.InstanceName))
        {
            _instancePrefix = Encoding.UTF8.GetBytes(options.InstanceName);
        }
    }

    internal IConnectionMultiplexer Connection => _connection;

    public byte[]? Get(string key)
    {
        ArgumentNullException.ThrowIfNull(key);
        return GetAndRefresh(key, getData: true);
    }

    public async Task<byte[]?> GetAsync(string key, CancellationToken token = default)
    {
        ArgumentNullException.ThrowIfNull(key);
        token.ThrowIfCancellationRequested();
        return await GetAndRefreshAsync(key, getData: true, token).ConfigureAwait(false);
    }

    public void Set(string key, byte[] value, DistributedCacheEntryOptions options)
    {
        ArgumentNullException.ThrowIfNull(value);
        SetCore(key, new ReadOnlySequence<byte>(value), options);
    }

    void IBufferDistributedCache.Set(
        string key,
        ReadOnlySequence<byte> value,
        DistributedCacheEntryOptions options)
        => SetCore(key, value, options);

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

        RedisKey redisKey = BuildKey(key);
        Task<RedisValue[]> pendingMetadata = _database.HashGetAsync(redisKey, s_metadataFields);
        using Lease<byte>? data = _database.HashGetLease(redisKey, DataKey);
        RedisValue[] metadata = pendingMetadata.GetAwaiter().GetResult();

        if (data is null)
        {
            return false;
        }

        RefreshSlidingExpiration(redisKey, metadata);
        destination.Write(data.Span);
        return true;
    }

    async ValueTask<bool> IBufferDistributedCache.TryGetAsync(
        string key,
        IBufferWriter<byte> destination,
        CancellationToken token)
    {
        ArgumentNullException.ThrowIfNull(key);
        ArgumentNullException.ThrowIfNull(destination);
        token.ThrowIfCancellationRequested();

        RedisKey redisKey = BuildKey(key);
        Task<RedisValue[]> pendingMetadata = _database.HashGetAsync(redisKey, s_metadataFields);
        using Lease<byte>? data = await _database.HashGetLeaseAsync(redisKey, DataKey).ConfigureAwait(false);
        RedisValue[] metadata = await pendingMetadata.ConfigureAwait(false);

        if (data is null)
        {
            return false;
        }

        token.ThrowIfCancellationRequested();
        await RefreshSlidingExpirationAsync(redisKey, metadata).ConfigureAwait(false);
        destination.Write(data.Span);
        return true;
    }

    private void SetCore(
        string key,
        ReadOnlySequence<byte> value,
        DistributedCacheEntryOptions options)
    {
        ArgumentNullException.ThrowIfNull(key);
        ArgumentNullException.ThrowIfNull(options);

        DateTimeOffset creationTime = DateTimeOffset.UtcNow;
        DateTimeOffset? absoluteExpiration = GetAbsoluteExpiration(creationTime, options);
        RedisKey redisKey = BuildKey(key);
        ReadOnlyMemory<byte> payload = Linearize(value, out byte[]? lease);
        HashEntry[] fields = GetHashFields(payload, absoluteExpiration, options.SlidingExpiration);
        long? ttlSeconds = GetExpirationInSeconds(creationTime, absoluteExpiration, options);
        if (ttlSeconds is null)
        {
            _database.HashSet(redisKey, fields);
            Recycle(lease);
            return;
        }

        IBatch batch = _database.CreateBatch();
        Task setFields = batch.HashSetAsync(redisKey, fields);
        Task setTtl = batch.KeyExpireAsync(redisKey, TimeSpan.FromSeconds(ttlSeconds.Value));
        batch.Execute();
        _database.WaitAll(setFields, setTtl);
        Recycle(lease);
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
        if (ttlSeconds is null)
        {
            await _database.HashSetAsync(redisKey, fields).ConfigureAwait(false);
            Recycle(lease);
            return;
        }

        await Task.WhenAll(
            _database.HashSetAsync(redisKey, fields),
            _database.KeyExpireAsync(redisKey, TimeSpan.FromSeconds(ttlSeconds.Value))).ConfigureAwait(false);
        Recycle(lease);
    }

    public void Refresh(string key)
    {
        ArgumentNullException.ThrowIfNull(key);
        _ = GetAndRefresh(key, getData: false);
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
        _database.KeyDelete(BuildKey(key));
    }

    public async Task RemoveAsync(string key, CancellationToken token = default)
    {
        ArgumentNullException.ThrowIfNull(key);
        token.ThrowIfCancellationRequested();
        await _database.KeyDeleteAsync(BuildKey(key)).ConfigureAwait(false);
    }

    private byte[]? GetAndRefresh(string key, bool getData)
    {
        RedisKey redisKey = BuildKey(key);
        RedisValue[] values = _database.HashGet(
            redisKey,
            getData ? s_metadataAndDataFields : s_metadataFields);
        RefreshSlidingExpiration(redisKey, values);
        return getData && values.Length >= 3 && !values[2].IsNull
            ? (byte[]?)values[2]
            : null;
    }

    private async Task<byte[]?> GetAndRefreshAsync(string key, bool getData, CancellationToken token)
    {
        RedisKey redisKey = BuildKey(key);
        RedisValue[] values = await _database.HashGetAsync(
            redisKey,
            getData ? s_metadataAndDataFields : s_metadataFields).ConfigureAwait(false);
        token.ThrowIfCancellationRequested();
        await RefreshSlidingExpirationAsync(redisKey, values).ConfigureAwait(false);
        return getData && values.Length >= 3 && !values[2].IsNull
            ? (byte[]?)values[2]
            : null;
    }

    private void RefreshSlidingExpiration(RedisKey key, RedisValue[] values)
    {
        MapMetadata(values, out DateTimeOffset? absoluteExpiration, out TimeSpan? slidingExpiration);
        if (slidingExpiration.HasValue)
        {
            _database.KeyExpire(key, ResolveRefreshTtl(absoluteExpiration, slidingExpiration.Value));
        }
    }

    private async Task RefreshSlidingExpirationAsync(RedisKey key, RedisValue[] values)
    {
        MapMetadata(values, out DateTimeOffset? absoluteExpiration, out TimeSpan? slidingExpiration);
        if (slidingExpiration.HasValue)
        {
            await _database.KeyExpireAsync(
                key,
                ResolveRefreshTtl(absoluteExpiration, slidingExpiration.Value)).ConfigureAwait(false);
        }
    }

    private RedisKey BuildKey(string key)
        => _instancePrefix.Append(key);

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
}
