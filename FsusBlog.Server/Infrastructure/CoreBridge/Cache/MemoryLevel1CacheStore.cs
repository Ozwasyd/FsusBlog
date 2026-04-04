using FsusBlog.Core.Cache;
using Microsoft.Extensions.Caching.Memory;

namespace FsusBlog.Server.Infrastructure.CoreBridge.Cache;

public sealed class MemoryLevel1CacheStore(IMemoryCache memoryCache) : ILevel1CacheStore
{
    public bool TryGet(string key, out byte[] value)
    {
        if (memoryCache.TryGetValue(key, out byte[]? bytes) && bytes is not null)
        {
            value = bytes;
            return true;
        }

        value = Array.Empty<byte>();
        return false;
    }

    public void Set(string key, byte[] value, TimeSpan ttl)
    {
        memoryCache.Set(key, value, ttl);
    }

    public void Remove(string key)
    {
        memoryCache.Remove(key);
    }
}
