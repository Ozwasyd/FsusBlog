using System.Collections.Concurrent;

using Microsoft.Extensions.Options;

namespace FsusBlog.Server.Infrastructure.Projections;

public sealed class ArticleDetailViewProjectionOptions
{
    public const string SectionName = "ArticleDetailViewProjection";

    public int MaxEntries { get; set; } = 100_000;

    public long MaxLogicalBytes { get; set; } = 3_200_000;

    public long MaxCapacityBytes { get; set; } = 6_400_000;

    public TimeSpan EntryTtl { get; set; } = TimeSpan.FromMinutes(30);

    internal bool IsValid()
        => MaxEntries > 0
            && MaxLogicalBytes >= ArticleDetailViewProjection.LogicalBytesPerEntry
            && MaxCapacityBytes >= ArticleDetailViewProjection.CapacityBytesPerEntry
            && EntryTtl > TimeSpan.Zero;
}

public readonly record struct ArticleDetailViewProjectionSnapshot(
    int Entries,
    long LogicalBytes,
    long CapacityBytes,
    long CurrentVersion,
    long Evictions,
    long AdmissionRejects,
    ArticleDetailViewProjectionOptions Limits);

public interface IArticleDetailViewProjection
{
    int Project(int articleId, int persistedViews);

    void ApplyAuthoritative(int articleId, int views, long version);

    ArticleDetailViewProjectionSnapshot Snapshot();
}

/// <summary>
/// Bounded process-local view floor used by ArticleDetail cache hits. Reads are
/// lock-free and never consult Redis or PostgreSQL. Durable public-hot delivery
/// supplies remote-node refreshes; eviction falls back to the persisted value in
/// the cached article payload.
/// </summary>
public sealed class ArticleDetailViewProjection : IArticleDetailViewProjection
{
    internal const int LogicalBytesPerEntry = sizeof(int) + sizeof(int) + sizeof(long) + sizeof(long);
    internal const int CapacityBytesPerEntry = 64;

    private readonly ConcurrentDictionary<int, Entry> _entries = new();
    private readonly Dictionary<int, LinkedListNode<int>> _nodes = [];
    private readonly LinkedList<int> _order = [];
    private readonly object _writeLock = new();
    private readonly ArticleDetailViewProjectionOptions _limits;
    private readonly TimeProvider _timeProvider;
    private readonly long _entryTtlTimestampDelta;
    private long _currentVersion;
    private long _logicalBytes;
    private long _capacityBytes;
    private long _evictions;
    private long _admissionRejects;

    public ArticleDetailViewProjection(
        IOptions<ArticleDetailViewProjectionOptions>? options = null,
        TimeProvider? timeProvider = null)
    {
        _limits = options?.Value ?? new ArticleDetailViewProjectionOptions();
        if (!_limits.IsValid())
        {
            throw new InvalidOperationException($"{ArticleDetailViewProjectionOptions.SectionName} limits are invalid.");
        }

        _timeProvider = timeProvider ?? TimeProvider.System;
        _entryTtlTimestampDelta = Math.Max(
            1L,
            (long)Math.Ceiling(_limits.EntryTtl.TotalSeconds * _timeProvider.TimestampFrequency));
    }

    public int Project(int articleId, int persistedViews)
    {
        int normalizedPersisted = Math.Max(0, persistedViews);
        if (articleId <= 0
            || !_entries.TryGetValue(articleId, out Entry entry)
            || _timeProvider.GetTimestamp() >= entry.ExpiresAtTimestamp)
        {
            return normalizedPersisted;
        }

        return Math.Max(normalizedPersisted, entry.Views);
    }

    public void ApplyAuthoritative(int articleId, int views, long version)
    {
        if (articleId <= 0 || views < 0 || version <= 0)
        {
            Interlocked.Increment(ref _admissionRejects);
            return;
        }

        lock (_writeLock)
        {
            long now = _timeProvider.GetTimestamp();
            if (_entries.TryGetValue(articleId, out Entry current)
                && now >= current.ExpiresAtTimestamp)
            {
                RemoveEntry(articleId);
                current = default;
            }

            if (_entries.TryGetValue(articleId, out current)
                && (version <= current.Version || views < current.Views))
            {
                return;
            }

            bool added = !_entries.ContainsKey(articleId);
            _entries[articleId] = new Entry(
                views,
                version,
                now + _entryTtlTimestampDelta);
            Volatile.Write(ref _currentVersion, Math.Max(Volatile.Read(ref _currentVersion), version));

            if (added)
            {
                _nodes[articleId] = _order.AddLast(articleId);
                _logicalBytes += LogicalBytesPerEntry;
                _capacityBytes += CapacityBytesPerEntry;
            }
            else if (_nodes.TryGetValue(articleId, out LinkedListNode<int>? node))
            {
                _order.Remove(node);
                _order.AddLast(node);
            }

            TrimExpiredAndOverBudget();
        }
    }

    public ArticleDetailViewProjectionSnapshot Snapshot()
    {
        lock (_writeLock)
        {
            return new ArticleDetailViewProjectionSnapshot(
                _entries.Count,
                _logicalBytes,
                _capacityBytes,
                Volatile.Read(ref _currentVersion),
                Volatile.Read(ref _evictions),
                Volatile.Read(ref _admissionRejects),
                new ArticleDetailViewProjectionOptions
                {
                    MaxEntries = _limits.MaxEntries,
                    MaxLogicalBytes = _limits.MaxLogicalBytes,
                    MaxCapacityBytes = _limits.MaxCapacityBytes,
                    EntryTtl = _limits.EntryTtl
                });
        }
    }

    private void TrimExpiredAndOverBudget()
    {
        long now = _timeProvider.GetTimestamp();
        while (_order.First is { } oldest)
        {
            bool overBudget = _entries.Count > _limits.MaxEntries
                || _logicalBytes > _limits.MaxLogicalBytes
                || _capacityBytes > _limits.MaxCapacityBytes;
            if (!overBudget
                && _entries.TryGetValue(oldest.Value, out Entry entry)
                && now < entry.ExpiresAtTimestamp)
            {
                break;
            }

            int articleId = oldest.Value;
            RemoveEntry(articleId);
        }
    }

    private void RemoveEntry(int articleId)
    {
        if (_nodes.Remove(articleId, out LinkedListNode<int>? node))
        {
            _order.Remove(node);
        }

        if (_entries.TryRemove(articleId, out _))
        {
            _logicalBytes -= LogicalBytesPerEntry;
            _capacityBytes -= CapacityBytesPerEntry;
            Interlocked.Increment(ref _evictions);
        }
    }

    private readonly record struct Entry(int Views, long Version, long ExpiresAtTimestamp);
}
