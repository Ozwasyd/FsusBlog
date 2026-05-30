using System.Linq;
using FsusBlog.Server.Infrastructure.Cache;
using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed class PublicAotShellCache(IUnifiedCache cache, IConnectionMultiplexer redis) : IPublicAotShellCache
{
    private readonly IDatabase _db = redis.GetDatabase();

    public async Task<PublicAotCacheEntry?> TryGetEntryAsync(string cacheKey, CancellationToken cancellationToken = default)
    {
        var cached = await cache.TryGetAsync<PublicAotCacheEntry>(
            CachePolicyId.PublicAotDocument,
            cacheKey,
            DecodeEntry,
            cancellationToken);
        return cached.Hit ? cached.Value : null;
    }

    public async Task SetAsync(PublicAotCacheEntry entry, CancellationToken cancellationToken = default)
    {
        byte[] payload = SerializeEntryBytes(entry);
        await cache.SetRawAsync(
            CachePolicyId.PublicAotDocument,
            entry.CacheKey,
            payload,
            entry.ExpiresAtUtc - DateTimeOffset.UtcNow,
            cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        foreach (string registryKey in PublicAotCacheRegistry.GetRegistryKeys(entry.PageId, entry.RouteKey))
        {
            _ = await _db.SetAddAsync(registryKey, entry.CacheKey);
        }
    }

    public async Task RemoveAsync(string cacheKey, CancellationToken cancellationToken = default)
    {
        await cache.RemoveAsync(CachePolicyId.PublicAotDocument, cacheKey, cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        if (PublicAotCacheRegistry.TryParseCacheKey(cacheKey, out PublicPageId pageId, out string routeKey))
        {
            foreach (string registryKey in PublicAotCacheRegistry.GetRegistryKeys(pageId, routeKey))
            {
                _ = await _db.SetRemoveAsync(registryKey, cacheKey);
            }
            return;
        }

        _ = await _db.SetRemoveAsync(PublicAotCacheRegistry.GlobalRegistryKey, cacheKey);
    }

    public async Task RemoveByPrefixAsync(string prefix, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (string.IsNullOrWhiteSpace(prefix))
        {
            return;
        }

        string registryKey = ResolveRegistryKey(prefix, out bool requiresPrefixFilter);
        RedisValue[] keys = await _db.SetMembersAsync(registryKey);
        if (keys.Length == 0)
        {
            if (!string.Equals(registryKey, PublicAotCacheRegistry.GlobalRegistryKey, StringComparison.Ordinal))
            {
                keys = await _db.SetMembersAsync(PublicAotCacheRegistry.GlobalRegistryKey);
            }

            if (keys.Length == 0)
            {
                return;
            }
        }

        foreach (RedisValue key in keys)
        {
            if (key.IsNullOrEmpty)
            {
                continue;
            }

            string value = key.ToString();
            if (requiresPrefixFilter && !value.StartsWith(prefix, StringComparison.Ordinal))
            {
                continue;
            }

            await RemoveAsync(value, cancellationToken);
        }
    }

    public async Task InvalidateAllAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        HashSet<string> keysToDelete = [];
        foreach (string registryKey in PublicAotCacheRegistry.GetAllKnownRegistryKeys())
        {
            RedisValue[] keys = await _db.SetMembersAsync(registryKey);
            foreach (RedisValue key in keys)
            {
                if (key.IsNullOrEmpty)
                {
                    continue;
                }

                keysToDelete.Add(key.ToString());
            }
        }

        if (keysToDelete.Count > 0)
        {
            foreach (string key in keysToDelete)
            {
                await cache.RemoveAsync(CachePolicyId.PublicAotDocument, key, cancellationToken);
            }
        }

        cancellationToken.ThrowIfCancellationRequested();
        RedisKey[] registryKeys = [.. PublicAotCacheRegistry.GetAllKnownRegistryKeys().Select(static key => (RedisKey)key)];
        if (registryKeys.Length > 0)
        {
            _ = await _db.KeyDeleteAsync(registryKeys);
        }
    }

    private static string ResolveRegistryKey(string prefix, out bool requiresPrefixFilter)
    {
        if (PublicAotCacheRegistry.TryResolveRegistryScope(prefix, out string registryKey, out requiresPrefixFilter))
        {
            return registryKey;
        }

        requiresPrefixFilter = true;
        return PublicAotCacheRegistry.GlobalRegistryKey;
    }

    private static (bool Success, PublicAotCacheEntry? Value) DecodeEntry(ReadOnlyMemory<byte> bytes)
    {
        PublicAotCacheEntry? entry = PublicAotCacheEntryBinaryCodec.Decode(bytes);
        return (entry is not null, entry);
    }

    private static byte[] SerializeEntryBytes(PublicAotCacheEntry entry)
        => PublicAotCacheEntryBinaryCodec.Encode(entry);
}
