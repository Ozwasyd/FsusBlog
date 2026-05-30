using System.Collections.Concurrent;
using FsusBlog.Core.Cache;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed class PublicAotInvalidationTracker
{
    private const string AllKey = "__all__";
    private readonly ConcurrentDictionary<string, long> _versions = new(StringComparer.Ordinal);
    private long _nextVersion;

    public long MarkAll()
        => Mark(AllKey);

    public long MarkPrefix(string prefix)
        => string.IsNullOrWhiteSpace(prefix) ? CurrentVersion : Mark(prefix);

    public long MarkKey(string cacheKey)
        => string.IsNullOrWhiteSpace(cacheKey) ? CurrentVersion : Mark(cacheKey);

    public long GetCurrentVersion(PublicPageId pageId, string cacheKey)
    {
        long version = GetVersion(AllKey);
        version = Math.Max(version, GetVersion(cacheKey));
        version = Math.Max(version, GetVersion(CacheKeyBuilder.PublicAotDocument(pageId, string.Empty)));
        return version;
    }

    public bool WasInvalidatedAfter(PublicAotBackfillRequest request, PublicPageId pageId)
        => GetCurrentVersion(pageId, request.CacheKey) > request.ScheduledInvalidationVersion;

    private long CurrentVersion => Interlocked.Read(ref _nextVersion);

    private long Mark(string key)
    {
        long version = Interlocked.Increment(ref _nextVersion);
        _versions.AddOrUpdate(key, version, (_, _) => version);
        return version;
    }

    private long GetVersion(string key)
        => string.IsNullOrWhiteSpace(key) ? 0 : _versions.GetValueOrDefault(key);
}
