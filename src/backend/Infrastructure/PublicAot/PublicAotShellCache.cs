using System.Linq;
using FsusBlog.Server.Infrastructure.Cache;
using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed class PublicAotShellCache(IUnifiedCache cache, IConnectionMultiplexer redis) : IPublicAotShellCache
{
    private const int InvalidationBatchSize = 256;
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
        await RemoveManyCacheEntriesAsync([cacheKey], cancellationToken).ConfigureAwait(false);
    }

    public async Task RemoveManyAsync(IReadOnlyCollection<string> cacheKeys, CancellationToken cancellationToken = default)
    {
        await RemoveManyCacheEntriesAsync(cacheKeys, cancellationToken).ConfigureAwait(false);
    }

    private async Task RemoveManyCacheEntriesAsync(
        IReadOnlyCollection<string> cacheKeys,
        CancellationToken cancellationToken,
        bool unregisterKeys = true)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string[] distinctKeys = [.. cacheKeys.Where(static key => !string.IsNullOrWhiteSpace(key)).Distinct(StringComparer.Ordinal)];
        if (distinctKeys.Length == 0)
        {
            return;
        }

        await cache.RemoveManyAsync(
            [.. distinctKeys.Select(static key => new CacheKeyIdentity(CachePolicyId.PublicAotDocument, key))],
            cancellationToken).ConfigureAwait(false);
        if (unregisterKeys)
        {
            await UnregisterKeysAsync(distinctKeys).ConfigureAwait(false);
        }
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
            await RemoveManyCacheEntriesAsync(keysToDelete, cancellationToken, unregisterKeys: false).ConfigureAwait(false);
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
        List<string> batch = new(InvalidationBatchSize);
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

            batch.Add(value);
            if (batch.Count >= InvalidationBatchSize)
            {
                removed += await FlushInvalidationBatchAsync(batch, cancellationToken).ConfigureAwait(false);
                batch.Clear();
            }
        }

        return removed + await FlushInvalidationBatchAsync(batch, cancellationToken).ConfigureAwait(false);
    }

    private async Task<int> FlushInvalidationBatchAsync(
        IReadOnlyCollection<string> cacheKeys,
        CancellationToken cancellationToken)
    {
        if (cacheKeys.Count == 0)
        {
            return 0;
        }

        await RemoveManyCacheEntriesAsync(cacheKeys, cancellationToken).ConfigureAwait(false);
        return cacheKeys.Count;
    }

    private async Task<long> UnregisterKeysAsync(IReadOnlyCollection<string> cacheKeys)
    {
        if (cacheKeys.Count == 0)
        {
            return 0;
        }

        Dictionary<string, List<RedisValue>> grouped = new(StringComparer.Ordinal);
        foreach (string cacheKey in cacheKeys)
        {
            if (PublicAotCacheRegistry.TryParseCacheKey(cacheKey, out PublicPageId pageId, out string routeKey))
            {
                foreach (string registryKey in PublicAotCacheRegistry.GetRegistryKeys(pageId, routeKey))
                {
                    AddRegistryMember(grouped, registryKey, cacheKey);
                }

                continue;
            }

            AddRegistryMember(grouped, PublicAotCacheRegistry.GlobalRegistryKey, cacheKey);
        }

        long removed = 0;
        foreach ((string registryKey, List<RedisValue> members) in grouped)
        {
            removed += await _db.SetRemoveAsync((RedisKey)registryKey, [.. members]).ConfigureAwait(false);
        }

        return removed;
    }

    private static void AddRegistryMember(Dictionary<string, List<RedisValue>> grouped, string registryKey, string cacheKey)
    {
        if (!grouped.TryGetValue(registryKey, out List<RedisValue>? members))
        {
            members = [];
            grouped[registryKey] = members;
        }

        members.Add(cacheKey);
    }

    private static (bool Success, PublicAotCacheEntry? Value) DecodeEntry(ReadOnlyMemory<byte> bytes)
    {
        PublicAotCacheEntry? entry = PublicAotCacheEntryBinaryCodec.Decode(bytes);
        return (entry is not null, entry);
    }

    private static byte[] SerializeEntryBytes(PublicAotCacheEntry entry)
        => PublicAotCacheEntryBinaryCodec.Encode(entry);
}
