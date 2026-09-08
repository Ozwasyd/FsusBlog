using System.Collections.Concurrent;

using Microsoft.Extensions.Caching.Memory;

namespace FsusBlog.Server.Infrastructure.Cache;

public sealed class CacheLocalStore(IMemoryCache memoryCache, TimeProvider timeProvider)
{
    private readonly ConcurrentDictionary<CacheL1Key, Entry> _entries = new();
    private readonly ConcurrentDictionary<string, Entry> _entriesByRedisKey = new(StringComparer.Ordinal);
    private readonly object _mutationLock = new();
    private long _distributedInvalidationGeneration;

    internal long DistributedInvalidationGenerationForTests
        => Volatile.Read(ref _distributedInvalidationGeneration);

    internal bool TryGet(CacheL1Key key, out byte[] bytes)
    {
        if (_entries.TryGetValue(key, out Entry? entry))
        {
            if (timeProvider.GetTimestamp() < entry.ExpiresAtTimestamp)
            {
                bytes = entry.Bytes;
                return true;
            }

            _entries.TryRemove(new KeyValuePair<CacheL1Key, Entry>(key, entry));
            _entriesByRedisKey.TryRemove(new KeyValuePair<string, Entry>(entry.RedisKey, entry));
            memoryCache.Remove(entry);
        }

        bytes = null!;
        return false;
    }

    internal void Set(CachePolicy policy, CacheL1Key key, string redisKey, byte[] bytes)
    {
        if (policy.L1Ttl <= TimeSpan.Zero)
        {
            return;
        }

        var options = new MemoryCacheEntryOptions
        {
            AbsoluteExpirationRelativeToNow = policy.L1Ttl
        };
        long ttlTimestampDelta = (long)Math.Ceiling(policy.L1Ttl.TotalSeconds * timeProvider.TimestampFrequency);
        var entry = new Entry(
            key,
            redisKey,
            Copy(bytes),
            timeProvider.GetTimestamp() + Math.Max(1L, ttlTimestampDelta));
        options.RegisterPostEvictionCallback(
            static (_, _, _, state) =>
            {
                if (state is EvictionState eviction)
                {
                    eviction.Owner._entries.TryRemove(
                        new KeyValuePair<CacheL1Key, Entry>(eviction.Entry.Key, eviction.Entry));
                    eviction.Owner._entriesByRedisKey.TryRemove(
                        new KeyValuePair<string, Entry>(eviction.RedisKey, eviction.Entry));
                }
            },
            new EvictionState(this, redisKey, entry));

        lock (_mutationLock)
        {
            _entries.TryGetValue(key, out Entry? previousKeyEntry);
            _entriesByRedisKey.TryGetValue(redisKey, out Entry? previousRedisEntry);
            _entries[key] = entry;
            _entriesByRedisKey[redisKey] = entry;
            memoryCache.Set(entry, true, options);
            RemoveSuperseded(previousKeyEntry, entry);
            RemoveSuperseded(previousRedisEntry, entry);
        }
    }

    internal CacheL1InvalidationPolicyReceipt Remove(CacheL1Key key, string? redisKey = null)
    {
        lock (_mutationLock)
        {
            int count = 0;
            long bytes = 0;
            if (_entries.TryRemove(key, out Entry? directEntry))
            {
                _entriesByRedisKey.TryRemove(
                    new KeyValuePair<string, Entry>(directEntry.RedisKey, directEntry));
                memoryCache.Remove(directEntry);
                count++;
                bytes += directEntry.Bytes.Length;
            }

            if (redisKey is not null)
            {
                if (_entriesByRedisKey.TryRemove(redisKey, out Entry? indexed)
                    && !ReferenceEquals(indexed, directEntry))
                {
                    _entries.TryRemove(new KeyValuePair<CacheL1Key, Entry>(indexed.Key, indexed));
                    memoryCache.Remove(indexed);
                    count++;
                    bytes += indexed.Bytes.Length;
                }

                memoryCache.Remove(redisKey);
            }

            return new(key.PolicyId, count, bytes);
        }
    }

    internal CacheL1InvalidationReceipt InvalidateLocal(IReadOnlyList<CacheKeyIdentity> keys)
    {
        ArgumentNullException.ThrowIfNull(keys);
        var receipts = new Dictionary<CachePolicyId, (int Entries, long Bytes)>();
        const string Scope = "default";
        foreach (CacheKeyIdentity key in keys.Distinct())
        {
            CacheL1Key l1Key = CacheIdentity
                .FromString(key.Identity, key.Version)
                .ToL1Key(Scope, key.PolicyId);
            CacheL1InvalidationPolicyReceipt receipt = Remove(l1Key);
            receipts.TryGetValue(key.PolicyId, out (int Entries, long Bytes) current);
            receipts[key.PolicyId] = (current.Entries + receipt.EntryCount, current.Bytes + receipt.Bytes);
        }

        Interlocked.Increment(ref _distributedInvalidationGeneration);
        return new(
            receipts
                .OrderBy(static pair => pair.Key)
                .Select(static pair => new CacheL1InvalidationPolicyReceipt(pair.Key, pair.Value.Entries, pair.Value.Bytes))
                .ToArray());
    }

    internal IReadOnlyList<CachePolicyStorageSnapshot> SnapshotResidency()
    {
        lock (_mutationLock)
        {
            return _entries.Values
                .GroupBy(static entry => entry.Key.PolicyId)
                .OrderBy(static group => group.Key)
                .Select(static group => new CachePolicyStorageSnapshot(
                    group.Key,
                    group.Count(),
                    group.Sum(static entry => entry.Bytes.LongLength)))
                .ToArray();
        }
    }

    internal CacheL1InvalidationReceipt ReconcileAllLocal()
    {
        IReadOnlyList<CachePolicyStorageSnapshot> before = SnapshotResidency();
        ClearForDistributedInvalidation();
        return new(
            before
                .Select(static item => new CacheL1InvalidationPolicyReceipt(
                    item.PolicyId,
                    (int)item.KeyCount,
                    item.Bytes))
                .ToArray());
    }

    internal void RemoveByRedisKey(string redisKey)
    {
        lock (_mutationLock)
        {
            RemoveByRedisKeyCore(redisKey, null);
        }
    }

    internal void ClearForDistributedInvalidation()
    {
        lock (_mutationLock)
        {
            Entry[] entries = _entries.Values.Distinct().ToArray();
            _entries.Clear();
            _entriesByRedisKey.Clear();
            foreach (Entry entry in entries)
            {
                memoryCache.Remove(entry);
            }

            Interlocked.Increment(ref _distributedInvalidationGeneration);
        }
    }

    private void RemoveByRedisKeyCore(string redisKey, Entry? directEntry)
    {
        if (_entriesByRedisKey.TryRemove(redisKey, out Entry? indexed)
            && !ReferenceEquals(indexed, directEntry))
        {
            _entries.TryRemove(new KeyValuePair<CacheL1Key, Entry>(indexed.Key, indexed));
            memoryCache.Remove(indexed);
        }

        memoryCache.Remove(redisKey);
    }

    private void RemoveSuperseded(Entry? previous, Entry current)
    {
        if (previous is null || ReferenceEquals(previous, current))
        {
            return;
        }

        _entries.TryRemove(new KeyValuePair<CacheL1Key, Entry>(previous.Key, previous));
        _entriesByRedisKey.TryRemove(new KeyValuePair<string, Entry>(previous.RedisKey, previous));
        memoryCache.Remove(previous);
    }

    private static byte[] Copy(byte[] bytes)
        => bytes.Length == 0 ? Array.Empty<byte>() : bytes.ToArray();

    private sealed record Entry(CacheL1Key Key, string RedisKey, byte[] Bytes, long ExpiresAtTimestamp);
    private sealed record EvictionState(CacheLocalStore Owner, string RedisKey, Entry Entry);
}
