using FsusBlog.Core.Cache;
using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.CoreBridge.Cache;

public sealed class RedisLevel2CacheStore(IConnectionMultiplexer redis) : ILevel2CacheStore
{
    private readonly IDatabase _db = redis.GetDatabase();

    public async Task<byte[]?> GetAsync(string key, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        RedisValue value = await _db.StringGetAsync(key);
        return value.IsNullOrEmpty ? null : (byte[]?)value;
    }

    public async Task SetAsync(string key, byte[] value, TimeSpan ttl, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        _ = await _db.StringSetAsync(key, value, ttl);
    }

    public async Task RemoveAsync(string key, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        _ = await _db.KeyDeleteAsync(key);
    }
}
