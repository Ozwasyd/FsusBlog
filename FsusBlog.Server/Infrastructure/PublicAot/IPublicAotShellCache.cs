namespace FsusBlog.Server.Infrastructure.PublicAot;

public interface IPublicAotShellCache
{
    Task<(bool Hit, string Value)> TryGetAsync(string cacheKey, CancellationToken cancellationToken = default);

    Task<string> GetOrCreateAsync(
        string cacheKey,
        Func<CancellationToken, Task<string>> factory,
        TimeSpan ttl,
        CancellationToken cancellationToken = default);

    Task SetAsync(string cacheKey, string value, TimeSpan ttl, CancellationToken cancellationToken = default);

    Task RemoveAsync(string cacheKey, CancellationToken cancellationToken = default);

    Task RemoveByPrefixAsync(string prefix, CancellationToken cancellationToken = default);

    Task InvalidateAllAsync(CancellationToken cancellationToken = default);
}
