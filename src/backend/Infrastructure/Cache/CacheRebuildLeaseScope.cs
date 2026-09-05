using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.Cache;

internal sealed class CacheRebuildLeaseScope : IDisposable
{
    private static readonly AsyncLocal<CacheRebuildLeaseScope?> s_current = new();
    private readonly CancellationToken _cancellationToken;
    private int _stopped;

    internal CacheRebuildLeaseScope(ICacheLeaseStore store, CachePolicyId policyId, string identity, string value, CancellationToken cancellationToken)
    {
        Store = store;
        PolicyId = policyId;
        Identity = identity;
        Value = value;
        _cancellationToken = cancellationToken;
        Parent = s_current.Value;
        s_current.Value = this;
    }

    internal static CacheRebuildLeaseScope? Current => s_current.Value;
    internal CacheRebuildLeaseScope? Parent
    {
        get;
    }
    internal ICacheLeaseStore Store
    {
        get;
    }
    internal CachePolicyId PolicyId
    {
        get;
    }
    internal string Identity
    {
        get;
    }
    internal string Value
    {
        get;
    }

    internal void EnsureActive()
    {
        _cancellationToken.ThrowIfCancellationRequested();
        if (Volatile.Read(ref _stopped) != 0)
        {
            throw new CacheCoordinationException("publication-after-owner-exit", PolicyId);
        }
        Parent?.EnsureActive();
    }

    internal void StopPublishing() => Interlocked.Exchange(ref _stopped, 1);

    internal static Task PublishSortedSetAsync(IDatabase database, string key, SortedSetEntry[] entries, CancellationToken cancellationToken)
    {
        CacheRebuildLeaseScope scope = Current ?? throw new CacheCoordinationException("publication-without-lease", CachePolicyId.TopArticles);
        scope.EnsureActive();
        if (scope.Store is not UnifiedCache cache)
        {
            throw new CacheCoordinationException("publication-store-mismatch", scope.PolicyId);
        }
        return cache.PublishSortedSetAsync(database, key, entries, cancellationToken);
    }

    public void Dispose()
    {
        StopPublishing();
        s_current.Value = Parent;
    }
}
