using System.Globalization;

namespace FsusBlog.Server.Infrastructure.Cache;

public static class AccountSnapshotCacheInvalidator
{
    public static Task BumpVersionAsync(ICacheCounterStore cache, int accountId, CancellationToken cancellationToken = default)
    {
        if (accountId <= 0)
        {
            return Task.CompletedTask;
        }

        return cache.IncrementAsync(
            CachePolicyId.AccountSnapshotVersion,
            accountId.ToString(CultureInfo.InvariantCulture),
            1,
            cancellationToken);
    }
}
