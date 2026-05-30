using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed record class PublicAotCacheEntry
{
    public string CacheKey { get; init; } = string.Empty;
    public string RouteKey { get; init; } = string.Empty;
    public PublicPageId PageId { get; init; }
    public PublicAotWriteSource Source { get; init; }
    public DateTimeOffset GeneratedAtUtc { get; init; }
    public DateTimeOffset ExpiresAtUtc { get; init; }
    public string RendererVersion { get; init; } = string.Empty;
    public string FrontendAssetVersion { get; init; } = string.Empty;
    public string Value { get; init; } = string.Empty;
}
