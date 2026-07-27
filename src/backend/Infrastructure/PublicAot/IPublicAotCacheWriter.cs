using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public interface IPublicAotCacheWriter
{
    Task WriteAsync(
        string cacheKey,
        PublicPageId pageId,
        string routeKey,
        string rendererVersion,
        string frontendAssetVersion,
        string locale,
        string html,
        PublicAotWriteSource source,
        DateTimeOffset? generatedAtUtc = null,
        TimeSpan? ttl = null,
        CancellationToken cancellationToken = default);
}
