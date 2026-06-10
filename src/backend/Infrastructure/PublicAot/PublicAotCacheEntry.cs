using FsusBlog.Shared.Contracts.Outputs;
using System.Text;

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
    public PublicAotHtmlArtifact? Document { get; init; }

    public PublicAotHtmlArtifact GetDocument()
        => Document is { IsEmpty: false }
            ? Document.Value
            : string.IsNullOrEmpty(Value)
                ? PublicAotHtmlArtifact.Empty(RendererVersion, FrontendAssetVersion)
                : PublicAotHtmlArtifactFactory.FromHtml(
                    Value,
                    RendererVersion,
                    FrontendAssetVersion,
                    PublicAotHtmlArtifactOptions.DefaultCacheControl,
                    PublicAotHtmlArtifactOptions.DefaultMinPrecompressedHtmlBytes);

    public string GetHtml()
        => !string.IsNullOrEmpty(Value)
            ? Value
            : Document is { IsEmpty: false } document
                ? Encoding.UTF8.GetString(document.Utf8Bytes.Span)
                : string.Empty;
}
