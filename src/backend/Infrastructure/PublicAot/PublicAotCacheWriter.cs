using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed class PublicAotCacheWriter(
    IPublicAotShellCache cache,
    PublicHotReadStore hotReadStore) : IPublicAotCacheWriter
{
    private static readonly TimeSpan DefaultTtl = TimeSpan.FromDays(30);

    public async Task WriteAsync(
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

        await cache.SetAsync(entry, cancellationToken).ConfigureAwait(false);
        hotReadStore.PublishHtml(
            routeKey,
            pageId,
            PublicHotReadHtmlArtifactFactory.FromHtml(html, "public,max-age=60"));
    }
}
