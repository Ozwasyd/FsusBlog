using System.Text;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed class PublicAotShellCache(ICacheManager cacheManager, IConnectionMultiplexer redis) : IPublicAotShellCache
{
    private const string RegistryKey = "public:aot:v2:registry";
    private readonly IDatabase _db = redis.GetDatabase();

    public async Task<(bool Hit, string Value)> TryGetAsync(string cacheKey, CancellationToken cancellationToken = default)
    {
        Result<string> cached = await cacheManager.TryGetAsync<string>(cacheKey, DecodeString, cancellationToken);
        return cached.IsSuccess
            ? (true, cached.Value ?? string.Empty)
            : (false, string.Empty);
    }

    public async Task<string> GetOrCreateAsync(
        string cacheKey,
        Func<CancellationToken, Task<string>> factory,
        TimeSpan ttl,
        CancellationToken cancellationToken = default)
    {
        Result<string> cached = await cacheManager.TryGetAsync<string>(cacheKey, DecodeString, cancellationToken);
        if (cached.IsSuccess)
        {
            return cached.Value ?? string.Empty;
        }

        string value = await factory(cancellationToken);
        await SetAsync(cacheKey, value, ttl, cancellationToken);
        return value;
    }

    public async Task SetAsync(string cacheKey, string value, TimeSpan ttl, CancellationToken cancellationToken = default)
    {
        await cacheManager.SetAsync(cacheKey, value, EncodeString, ttl, cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        _ = await _db.SetAddAsync(RegistryKey, cacheKey);
    }

    public async Task RemoveAsync(string cacheKey, CancellationToken cancellationToken = default)
    {
        await cacheManager.RemoveAsync(cacheKey, cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        _ = await _db.SetRemoveAsync(RegistryKey, cacheKey);
    }

    public async Task RemoveByPrefixAsync(string prefix, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(prefix))
        {
            return;
        }

        RedisValue[] keys = await _db.SetMembersAsync(RegistryKey);
        if (keys.Length == 0)
        {
            return;
        }

        foreach (RedisValue key in keys)
        {
            if (key.IsNullOrEmpty)
            {
                continue;
            }

            string value = key.ToString();
            if (!value.StartsWith(prefix, StringComparison.Ordinal))
            {
                continue;
            }

            await cacheManager.RemoveAsync(value, cancellationToken);
            _ = await _db.SetRemoveAsync(RegistryKey, value);
        }
    }

    public async Task InvalidateAllAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        RedisValue[] keys = await _db.SetMembersAsync(RegistryKey);
        if (keys.Length == 0)
        {
            return;
        }

        foreach (RedisValue key in keys)
        {
            if (key.IsNullOrEmpty)
            {
                continue;
            }

            await cacheManager.RemoveAsync(key!, cancellationToken);
        }

        cancellationToken.ThrowIfCancellationRequested();
        _ = await _db.KeyDeleteAsync(RegistryKey);
    }

    private static byte[] EncodeString(string value) => Encoding.UTF8.GetBytes(value);

    private static bool DecodeString(ReadOnlyMemory<byte> bytes, out string value)
    {
        value = Encoding.UTF8.GetString(bytes.Span);
        return true;
    }
}
