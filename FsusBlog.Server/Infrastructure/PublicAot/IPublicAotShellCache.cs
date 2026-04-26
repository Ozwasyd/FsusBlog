namespace FsusBlog.Server.Infrastructure.PublicAot;

public interface IPublicAotShellCache
{
    Task<PublicAotCacheEntry?> TryGetEntryAsync(string cacheKey, CancellationToken cancellationToken = default);

    Task SetAsync(PublicAotCacheEntry entry, CancellationToken cancellationToken = default);

    Task RemoveAsync(string cacheKey, CancellationToken cancellationToken = default);

    Task RemoveByPrefixAsync(string prefix, CancellationToken cancellationToken = default);

    Task InvalidateAllAsync(CancellationToken cancellationToken = default);
}
