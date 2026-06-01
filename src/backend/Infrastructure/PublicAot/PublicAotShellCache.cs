using System.Linq;
using FsusBlog.Server.Infrastructure.Cache;
using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed class PublicAotShellCache(IUnifiedCache cache, IConnectionMultiplexer redis) : IPublicAotShellCache
{
    private readonly IDatabase _db = redis.GetDatabase();

    public async Task<PublicAotCacheEntry?> TryGetEntryAsync(string cacheKey, CancellationToken cancellationToken = default)
        => await TryGetEntryAsync(cacheKey, frontendAssetVersion: null, cancellationToken).ConfigureAwait(false);

    public async Task<PublicAotCacheEntry?> TryGetEntryAsync(string cacheKey, string? frontendAssetVersion, CancellationToken cancellationToken = default)
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
        int removed = await RemoveRegisteredKeysAsync(registryKey, prefix, requiresPrefixFilter, cancellationToken).ConfigureAwait(false);
        if (removed == 0 && !string.Equals(registryKey, PublicAotCacheRegistry.GlobalRegistryKey, StringComparison.Ordinal))
        {
            _ = await RemoveRegisteredKeysAsync(PublicAotCacheRegistry.GlobalRegistryKey, prefix, requiresPrefixFilter: true, cancellationToken).ConfigureAwait(false);
        }
    }

    public async Task InvalidateAllAsync(CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        HashSet<string> keysToDelete = [];
        foreach (string registryKey in PublicAotCacheRegistry.GetAllKnownRegistryKeys())
        {
            foreach (RedisValue key in _db.SetScan(registryKey, pageSize: 256))
            {
                cancellationToken.ThrowIfCancellationRequested();
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

    private async Task<int> RemoveRegisteredKeysAsync(
        string registryKey,
        string prefix,
        bool requiresPrefixFilter,
        CancellationToken cancellationToken)
    {
        int removed = 0;
        foreach (RedisValue key in _db.SetScan(registryKey, pageSize: 256))
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (key.IsNullOrEmpty)
            {
                continue;
            }

            string value = key.ToString();
            if (requiresPrefixFilter && !value.StartsWith(prefix, StringComparison.Ordinal))
            {
                continue;
            }

            await RemoveAsync(value, cancellationToken).ConfigureAwait(false);
            removed++;
        }

        return removed;
    }

    private static (bool Success, PublicAotCacheEntry? Value) DecodeEntry(ReadOnlyMemory<byte> bytes)
    {
        PublicAotCacheEntry? entry = PublicAotCacheEntryBinaryCodec.Decode(bytes);
        return (entry is not null, entry);
    }

    private static byte[] SerializeEntryBytes(PublicAotCacheEntry entry)
        => PublicAotCacheEntryBinaryCodec.Encode(entry);
}
