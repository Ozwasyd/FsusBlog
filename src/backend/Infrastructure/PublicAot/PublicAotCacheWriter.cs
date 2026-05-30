using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed class PublicAotCacheWriter(IPublicAotShellCache cache) : IPublicAotCacheWriter
{
    private static readonly TimeSpan DefaultTtl = TimeSpan.FromDays(30);

    public Task WriteAsync(
        string cacheKey,
        PublicPageId pageId,
        string routeKey,
        string rendererVersion,
        string frontendAssetVersion,
        string html,
        PublicAotWriteSource source,
        DateTimeOffset? generatedAtUtc = null,
        TimeSpan? ttl = null,
        CancellationToken cancellationToken = default)
    {
        DateTimeOffset generatedAt = generatedAtUtc ?? DateTimeOffset.UtcNow;
        var entry = new PublicAotCacheEntry
        {
            CacheKey = cacheKey,
            RouteKey = routeKey,
            PageId = pageId,
            Source = source,
            GeneratedAtUtc = generatedAt,
            ExpiresAtUtc = generatedAt.Add(ttl ?? DefaultTtl),
            RendererVersion = rendererVersion,
            FrontendAssetVersion = frontendAssetVersion,
            Value = html
        };

        return cache.SetAsync(entry, cancellationToken);
    }
}
