using System.Collections.Concurrent;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed class PublicAotInvalidationTracker
{
    private const string AllKey = "__all__";
    private readonly ConcurrentDictionary<string, long> _versions = new(StringComparer.Ordinal);
    private long _nextVersion;
    private DateTimeOffset? _lastInvalidatedAt;

    public long MarkAll()
        => Mark(AllKey);

    public long MarkPrefix(string prefix)
        => string.IsNullOrWhiteSpace(prefix) ? CurrentVersion : Mark(prefix);

    public long MarkKey(string cacheKey)
        => string.IsNullOrWhiteSpace(cacheKey) ? CurrentVersion : Mark(cacheKey);

    public long GetCurrentVersion(string cacheKey, string pagePrefixKey)
    {
        long version = GetVersion(AllKey);
        version = Math.Max(version, GetVersion(cacheKey));
        version = Math.Max(version, GetVersion(pagePrefixKey));
        return version;
    }

    public bool WasInvalidatedAfter(PublicAotBackfillRequest request)
        => GetCurrentVersion(request.CacheKey, request.PagePrefixKey) > request.ScheduledInvalidationVersion;

    private long CurrentVersion => Interlocked.Read(ref _nextVersion);

    private long Mark(string key)
    {
        long version = Interlocked.Increment(ref _nextVersion);
        _versions.AddOrUpdate(key, version, (_, _) => version);
        _lastInvalidatedAt = DateTimeOffset.UtcNow;
        return version;
    }

    private long GetVersion(string key)
        => string.IsNullOrWhiteSpace(key) ? 0 : _versions.GetValueOrDefault(key);

    public PublicAotInvalidationRuntimeSnapshot Snapshot()
        => new(CurrentVersion, _versions.Count, _lastInvalidatedAt);
}

public sealed record PublicAotInvalidationRuntimeSnapshot(
    long CurrentVersion,
    int TrackedInvalidationKeys,
    DateTimeOffset? LastInvalidatedAt);
