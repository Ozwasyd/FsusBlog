using System.Diagnostics.CodeAnalysis;
using System.Diagnostics.Metrics;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed class PublicAotFileShellCacheOptions
{
    public long MaxMemoryCacheBytes
    {
        get; set;
    }
    public int MaxMemoryCacheEntries
    {
        get; set;
    }
    public TimeSpan MemoryCacheEntryDeadline
    {
        get; set;
    }
}

internal readonly record struct PublicAotMemoryCacheLimits(
    long AvailableMemoryBytes,
    long MaxBytes,
    int MaxEntries,
    TimeSpan EntryDeadline)
{
    internal static PublicAotMemoryCacheLimits Resolve(
        PublicAotFileShellCacheOptions options,
        long? availableMemoryBytes = null)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentOutOfRangeException.ThrowIfNegative(options.MaxMemoryCacheBytes);
        ArgumentOutOfRangeException.ThrowIfNegative(options.MaxMemoryCacheEntries);
        if (options.MemoryCacheEntryDeadline < TimeSpan.Zero)
        {
            throw new ArgumentOutOfRangeException(
                nameof(options.MemoryCacheEntryDeadline),
                options.MemoryCacheEntryDeadline,
                "Memory cache deadline cannot be negative.");
        }

        long available = availableMemoryBytes ?? GC.GetGCMemoryInfo().TotalAvailableMemoryBytes;
        if (available <= 0)
        {
            available = Math.Max(Environment.WorkingSet * 4, 512L * 1024 * 1024);
        }

        long maxBytes = options.MaxMemoryCacheBytes > 0
            ? options.MaxMemoryCacheBytes
            : Math.Clamp(available / 64, 8L * 1024 * 1024, 512L * 1024 * 1024);
        int maxEntries = options.MaxMemoryCacheEntries > 0
            ? options.MaxMemoryCacheEntries
            : (int)Math.Clamp(maxBytes / (64L * 1024), 64, 16_384);
        TimeSpan deadline = options.MemoryCacheEntryDeadline > TimeSpan.Zero
            ? options.MemoryCacheEntryDeadline
            : TimeSpan.FromMinutes(Math.Clamp(available / (1024L * 1024 * 1024) * 5, 5, 120));

        return new PublicAotMemoryCacheLimits(available, maxBytes, maxEntries, deadline);
    }
}

internal sealed record PublicAotMemoryCacheEntry(
    PublicAotCacheEntry Entry,
    DateTimeOffset ExpiresAtUtc,
    string RendererVersion,
    string FrontendAssetVersion,
    long GenerationToken,
    long SizeBytes,
    DateTimeOffset CacheDeadlineUtc);

internal readonly record struct PublicAotMemoryCacheSnapshot(
    int EntryCount,
    long ResidentBytes,
    long EvictionCount,
    long CapacityEvictionCount,
    long DeadlineEvictionCount,
    PublicAotMemoryCacheLimits Limits);

internal sealed class PublicAotBoundedMemoryCache
{
    private static readonly Meter Meter = new("FsusBlog.PublicAot.MemoryCache", "1.0.0");
    private static readonly Counter<long> EvictionCounter =
        Meter.CreateCounter<long>("fsus.public_aot.memory_cache.evictions");
    private static readonly Histogram<long> ResidentBytesHistogram =
        Meter.CreateHistogram<long>("fsus.public_aot.memory_cache.resident_bytes", "By");

    private readonly object _gate = new();
    private readonly Dictionary<string, PublicAotMemoryCacheEntry> _entries = new(StringComparer.Ordinal);
    private readonly Dictionary<string, LinkedListNode<string>> _nodes = new(StringComparer.Ordinal);
    private readonly LinkedList<string> _lru = new();
    private readonly TimeProvider _timeProvider;
    private long _residentBytes;
    private long _evictionCount;
    private long _capacityEvictionCount;
    private long _deadlineEvictionCount;

    internal PublicAotBoundedMemoryCache(
        PublicAotMemoryCacheLimits limits,
        TimeProvider timeProvider)
    {
        Limits = limits;
        _timeProvider = timeProvider;
    }

    internal PublicAotMemoryCacheLimits Limits
    {
        get;
    }

    internal PublicAotMemoryCacheEntry this[string cacheKey]
    {
        set => Set(cacheKey, value);
    }

    internal IReadOnlyList<string> Keys
    {
        get
        {
            lock (_gate)
            {
                PruneExpiredLocked(_timeProvider.GetUtcNow());
                return _entries.Keys.ToArray();
            }
        }
    }

    internal bool TryGetValue(
        string cacheKey,
        [NotNullWhen(true)] out PublicAotMemoryCacheEntry? entry)
    {
        lock (_gate)
        {
            DateTimeOffset now = _timeProvider.GetUtcNow();
            if (!_entries.TryGetValue(cacheKey, out entry))
            {
                return false;
            }

            if (entry.CacheDeadlineUtc <= now)
            {
                RemoveLocked(cacheKey, "deadline", countEviction: true, out _);
                entry = null;
                return false;
            }

            TouchLocked(cacheKey);
            return true;
        }
    }

    internal bool TryRemove(string cacheKey, out PublicAotMemoryCacheEntry? entry)
    {
        lock (_gate)
        {
            return RemoveLocked(cacheKey, "invalidation", countEviction: false, out entry);
        }
    }

    internal void Clear()
    {
        lock (_gate)
        {
            _entries.Clear();
            _nodes.Clear();
            _lru.Clear();
            _residentBytes = 0;
            ResidentBytesHistogram.Record(0);
        }
    }

    internal PublicAotMemoryCacheSnapshot Snapshot()
    {
        lock (_gate)
        {
            PruneExpiredLocked(_timeProvider.GetUtcNow());
            return new(
                _entries.Count,
                _residentBytes,
                _evictionCount,
                _capacityEvictionCount,
                _deadlineEvictionCount,
                Limits);
        }
    }

    private void Set(string cacheKey, PublicAotMemoryCacheEntry entry)
    {
        if (string.IsNullOrWhiteSpace(cacheKey))
        {
            return;
        }

        lock (_gate)
        {
            DateTimeOffset now = _timeProvider.GetUtcNow();
            PruneExpiredLocked(now);
            _ = RemoveLocked(cacheKey, "replace", countEviction: false, out _);
            DateTimeOffset hardDeadline = now + Limits.EntryDeadline;
            if (entry.CacheDeadlineUtc > hardDeadline)
            {
                entry = entry with
                {
                    CacheDeadlineUtc = hardDeadline
                };
            }
            _entries[cacheKey] = entry;
            _residentBytes = checked(_residentBytes + Math.Max(0, entry.SizeBytes));
            LinkedListNode<string> node = _lru.AddLast(cacheKey);
            _nodes[cacheKey] = node;

            while ((_entries.Count > Limits.MaxEntries || _residentBytes > Limits.MaxBytes)
                   && _lru.First is { } oldest)
            {
                RemoveLocked(oldest.Value, "capacity", countEviction: true, out _);
            }

            ResidentBytesHistogram.Record(_residentBytes);
        }
    }

    private void PruneExpiredLocked(DateTimeOffset now)
    {
        LinkedListNode<string>? node = _lru.First;
        while (node is not null)
        {
            LinkedListNode<string>? next = node.Next;
            if (_entries.TryGetValue(node.Value, out PublicAotMemoryCacheEntry? entry)
                && entry.CacheDeadlineUtc <= now)
            {
                RemoveLocked(node.Value, "deadline", countEviction: true, out _);
            }
            node = next;
        }
    }

    private void TouchLocked(string cacheKey)
    {
        if (!_nodes.TryGetValue(cacheKey, out LinkedListNode<string>? node)
            || ReferenceEquals(node, _lru.Last))
        {
            return;
        }

        _lru.Remove(node);
        _lru.AddLast(node);
    }

    private bool RemoveLocked(
        string cacheKey,
        string reason,
        bool countEviction,
        out PublicAotMemoryCacheEntry? entry)
    {
        if (!_entries.Remove(cacheKey, out entry))
        {
            return false;
        }

        _residentBytes = Math.Max(0, _residentBytes - Math.Max(0, entry.SizeBytes));
        if (_nodes.Remove(cacheKey, out LinkedListNode<string>? node))
        {
            _lru.Remove(node);
        }

        if (countEviction)
        {
            _evictionCount++;
            if (string.Equals(reason, "capacity", StringComparison.Ordinal))
            {
                _capacityEvictionCount++;
            }
            else if (string.Equals(reason, "deadline", StringComparison.Ordinal))
            {
                _deadlineEvictionCount++;
            }
            EvictionCounter.Add(1, new KeyValuePair<string, object?>("fsus.reason", reason));
        }
        return true;
    }
}
