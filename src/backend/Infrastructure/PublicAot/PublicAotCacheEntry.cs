using System.Text;

using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public readonly record struct PublicAotHydrationSidecarReference(
    string Url,
    string Sha256Hex,
    string RelativePath)
{
    private const string PayloadPrefix = "/aot-cache/payloads/";

    public bool IsEmpty => string.IsNullOrWhiteSpace(Url);

    public static bool TryFromHtml(string html, out PublicAotHydrationSidecarReference reference)
    {
        reference = default;
        if (string.IsNullOrWhiteSpace(html))
        {
            return false;
        }

        int marker = html.IndexOf("id=\"fsus-aot-hydration-props\"", StringComparison.OrdinalIgnoreCase);
        if (marker < 0)
        {
            marker = html.IndexOf("id='fsus-aot-hydration-props'", StringComparison.OrdinalIgnoreCase);
        }

        if (marker < 0)
        {
            return false;
        }

        int scriptStart = html.LastIndexOf("<script", marker, StringComparison.OrdinalIgnoreCase);
        int tagEnd = html.IndexOf('>', marker);
        if (scriptStart < 0 || tagEnd < scriptStart)
        {
            return false;
        }

        string tag = html[scriptStart..(tagEnd + 1)];
        string sidecarUrl = PublicAotDocumentComposer.ExtractAttributeValue(tag, "data-aeds-src");
        if (string.IsNullOrWhiteSpace(sidecarUrl))
        {
            sidecarUrl = PublicAotDocumentComposer.ExtractAttributeValue(tag, "src");
        }

        return TryFromUrl(sidecarUrl, out reference);
    }

    public static bool TryFromUrl(string? url, out PublicAotHydrationSidecarReference reference)
    {
        reference = default;
        if (string.IsNullOrWhiteSpace(url))
        {
            return false;
        }

        string path = url.Trim();
        if (Uri.TryCreate(path, UriKind.Absolute, out Uri? absolute))
        {
            path = absolute.AbsolutePath;
        }

        int queryIndex = path.IndexOfAny(['?', '#']);
        if (queryIndex >= 0)
        {
            path = path[..queryIndex];
        }

        path = path.Replace('\\', '/');
        if (!path.StartsWith("/", StringComparison.Ordinal))
        {
            path = "/" + path;
        }

        if (!path.StartsWith(PayloadPrefix, StringComparison.Ordinal) ||
            !path.EndsWith(".aeds", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        string fileName = Path.GetFileNameWithoutExtension(path);
        if (fileName.Length != 64 || !fileName.All(static ch => char.IsAsciiHexDigit(ch)))
        {
            return false;
        }

        string normalizedHash = fileName.ToLowerInvariant();
        reference = new PublicAotHydrationSidecarReference(
            path,
            normalizedHash,
            path.TrimStart('/'));
        return true;
    }
}

public sealed record class PublicAotCacheEntry
{
    public string CacheKey { get; init; } = string.Empty;
    public string RouteKey { get; init; } = string.Empty;
    public PublicPageId PageId
    {
        get; init;
    }
    public PublicAotWriteSource Source
    {
        get; init;
    }
    public DateTimeOffset GeneratedAtUtc
    {
        get; init;
    }
    public DateTimeOffset ExpiresAtUtc
    {
        get; init;
    }
    public string RendererVersion { get; init; } = string.Empty;
    public string FrontendAssetVersion { get; init; } = string.Empty;
    public string Value { get; init; } = string.Empty;
    public PublicAotHtmlArtifact? Document
    {
        get; init;
    }
    public PublicAotHydrationSidecarReference HydrationSidecar
    {
        get; init;
    }

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
