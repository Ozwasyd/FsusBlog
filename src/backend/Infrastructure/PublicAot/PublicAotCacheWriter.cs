using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.Extensions.Options;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed class PublicAotCacheWriter(
    IPublicAotShellCache cache,
    PublicHotReadStore hotReadStore,
    IOptions<PublicAotHtmlArtifactOptions> htmlArtifactOptions) : IPublicAotCacheWriter
{
    private static readonly TimeSpan s_defaultTtl = TimeSpan.FromDays(30);

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
        PublicAotHtmlArtifactOptions options = htmlArtifactOptions.Value;
        PublicAotHtmlArtifact document = PublicAotHtmlArtifactFactory.FromHtml(
            html,
            rendererVersion,
            frontendAssetVersion,
            options.CacheControl,
            options.MinPrecompressedHtmlBytes,
            options.EnablePrecompressedHtmlVariants);
        var entry = new PublicAotCacheEntry
        {
            CacheKey = cacheKey,
            RouteKey = routeKey,
            PageId = pageId,
            Source = source,
            GeneratedAtUtc = generatedAt,
            ExpiresAtUtc = generatedAt.Add(ttl ?? s_defaultTtl),
            RendererVersion = rendererVersion,
            FrontendAssetVersion = frontendAssetVersion,
            Value = html,
            Document = document,
            HydrationSidecar = PublicAotHydrationSidecarReference.TryFromHtml(html, out PublicAotHydrationSidecarReference sidecar)
                ? sidecar
                : default
        };

        await cache.SetAsync(entry, cancellationToken).ConfigureAwait(false);
        hotReadStore.PublishHtml(
            routeKey,
            pageId,
            PublicHotReadHtmlArtifactFactory.FromDocument(document, "public,max-age=60"));
    }
}
