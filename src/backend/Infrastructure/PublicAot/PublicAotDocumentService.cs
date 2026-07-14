using System.Net;
using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Spa;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed class PublicAotDocumentService(
    IWebHostEnvironment env,
    IConfiguration configuration,
    ISystemService systemService,
    ISpaAssetManifestService assetManifest,
    ILogger<PublicAotDocumentService> logger) : IPublicAotDocumentService
{
    private static readonly string EmptyPayload = PublicAotBinaryPayload.EncodeObject(new Dictionary<string, object?>(StringComparer.Ordinal));
    private static readonly ConcurrentDictionary<string, PreparedTemplateCacheEntry> PreparedTemplateCache = new(StringComparer.Ordinal);
    private static readonly ConcurrentDictionary<string, string> HeadLinksCache = new(StringComparer.Ordinal);
    private static readonly ConcurrentDictionary<string, byte> HydrationSidecarExistsCache = new(StringComparer.Ordinal);
    private readonly string? _configuredBaseUrl = NormalizeBaseUrlOrNull(
        configuration["Seo:BaseUrl"]
        ?? configuration["Seo__BaseUrl"]
        ?? configuration["SITE_BASEURL"]);

    public async Task<Result<PublicSeoHeadModel>> BuildSeoHeadModelAsync(
        PublicAotShellEntryContract entry,
        CancellationToken cancellationToken = default)
    {
        try
        {
            SeoDocumentContext context = await ResolveSeoDocumentContextAsync(entry, cancellationToken).ConfigureAwait(false);
            return Result<PublicSeoHeadModel>.Success(context.Head);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to build public SEO head model: {PageId} {RouteKey}", entry.PageId, entry.RouteKey);
            return Result<PublicSeoHeadModel>.Failure(ErrorCode.InfraFailure, "public_seo_head_build_failed");
        }
    }

    public async Task<Result<string>> ComposeAsync(
        PublicAotShellEntryContract entry,
        CancellationToken cancellationToken = default)
        => await ComposeAsync(entry, context: null, cancellationToken);

    public async Task<Result<string>> ComposeAsync(
        PublicAotShellEntryContract entry,
        HttpContext? context,
        CancellationToken cancellationToken = default)
    {
        if (string.IsNullOrWhiteSpace(entry.Html))
        {
            return Result<string>.Failure(ErrorCode.Validation, "AOT HTML 为空");
        }

        if (entry.Html.Contains("<!DOCTYPE html>", StringComparison.OrdinalIgnoreCase) ||
            entry.Html.Contains("<html", StringComparison.OrdinalIgnoreCase))
        {
            return Result<string>.Success(entry.Html);
        }

        try
        {
            SeoDocumentContext seoContext = await ResolveSeoDocumentContextAsync(entry, cancellationToken).ConfigureAwait(false);
            SeoConfigReadModel seo = seoContext.Seo;
            SpaAssetSet assetSet = assetManifest.GetPublicAssetSet(context, entry.PageId);
            PreparedTemplateCacheEntry template = await GetPreparedTemplateAsync(assetSet, cancellationToken);
            string rawTemplate = template.RawTemplate;
            string preparedTemplate = template.PreparedTemplate;
            string shell = PublicAotDocumentComposer.EnsureShellRoot(NormalizeHtml(entry.Html, entry.ArticleId), seoContext.Kind);
            string headLinks = GetHeadLinks(template, assetSet, seo);
            string bootstrapPayload = NormalizeOptionalText(entry.BootstrapPayload ?? EmptyPayload, entry.ArticleId);
            string hydrationPayload = NormalizeOptionalText(entry.HydrationPropsPayload ?? string.Empty, entry.ArticleId);
            await WriteHydrationPayloadSidecarAsync(hydrationPayload, cancellationToken).ConfigureAwait(false);

            return Result<string>.Success(PublicAotDocumentComposer.ComposeDocument(new PublicAotDocumentModel(
                seoContext.Kind,
                rawTemplate,
                preparedTemplate,
                seoContext.Title,
                seoContext.SiteTitle,
                seoContext.Description,
                seoContext.CanonicalUrl,
                shell,
                bootstrapPayload,
                hydrationPayload,
                NormalizeOptionalText(entry.IslandsPayload ?? string.Empty, entry.ArticleId),
                assetSet.EntryScript,
                headLinks)
            {
                FullAppTakeover = assetSet.FullAppTakeover,
                ArticleSeo = seoContext.ArticleSeo,
                SeoHead = seoContext.Head
            }));
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to compose public AOT document: {PageId} {RouteKey}", entry.PageId, entry.RouteKey);
            return Result<string>.Failure(ErrorCode.InfraFailure, "public_aot_document_compose_failed");
        }
    }

    private async Task<SeoDocumentContext> ResolveSeoDocumentContextAsync(
        PublicAotShellEntryContract entry,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        SeoConfigReadModel seo = await systemService.GetSeoConfigAsync().ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        DecodedEntryPayloads payloads = DecodeEntryPayloads(entry);
        string title = ResolveTitle(entry, payloads, seo.Title);
        string description = ResolveDescription(entry, payloads, seo.Description);
        string siteTitle = ResolvePayloadString(payloads.Hydration, "siteTitle", seo.Title);
        PublicPageKind kind = ResolvePageKind(entry.PageId);
        string canonicalUrl = string.Concat(ResolveCanonicalBaseUrl(entry.BaseUrl, _configuredBaseUrl), ResolveCanonicalPath(entry));
        PublicAotArticleSeoMetadata? articleSeo = BuildArticleSeoMetadata(
            kind,
            payloads,
            canonicalUrl,
            title,
            description,
            siteTitle,
            seo);
        PublicSeoHeadModel head = PublicAotDocumentComposer.BuildSeoHeadModel(
            kind,
            title,
            siteTitle,
            description,
            canonicalUrl,
            articleSeo,
            seo.OgImage);
        return new SeoDocumentContext(seo, kind, title, siteTitle, description, canonicalUrl, articleSeo, head);
    }

    private async Task<PreparedTemplateCacheEntry> GetPreparedTemplateAsync(SpaAssetSet assetSet, CancellationToken cancellationToken)
    {
        string rawTemplate = await PublicSpaTemplateLocator.ReadIndexTemplateAsync(env, cancellationToken, assetSet.UsesSourceAssets);
        string templateHash = ComputeStableHash(rawTemplate);
        string cacheKey = string.Concat(
            Path.GetFullPath(env.ContentRootPath),
            '|',
            templateHash,
            '|',
            assetSet.UsesSourceAssets ? "source" : "dist");
        return PreparedTemplateCache.GetOrAdd(cacheKey, _ => new PreparedTemplateCacheEntry(
            rawTemplate,
            PublicAotDocumentComposer.PreparePublicDocumentTemplate(rawTemplate),
            assetSet.FrontendAssetVersion,
            templateHash));
    }

    private static string GetHeadLinks(PreparedTemplateCacheEntry template, SpaAssetSet assetSet, SeoConfigReadModel seo)
    {
        string cacheKey = string.Concat(
            template.AssetVersion,
            '|',
            template.TemplateHash,
            '|',
            assetSet.FrontendAssetVersion,
            '|',
            BuildAssetSignature(assetSet),
            '|',
            BuildSeoSignature(seo));
        return HeadLinksCache.GetOrAdd(cacheKey, _ => BuildHeadLinks(template.RawTemplate, assetSet, seo));
    }

    private async Task WriteHydrationPayloadSidecarAsync(string hydrationPayload, CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(hydrationPayload))
        {
            return;
        }

        string webRoot = string.IsNullOrWhiteSpace(env.WebRootPath)
            ? Path.Combine(env.ContentRootPath, "wwwroot")
            : env.WebRootPath;
        string relativePath = PublicAotDocumentComposer.BuildPayloadSidecarUrl(hydrationPayload)
            .TrimStart('/')
            .Replace('/', Path.DirectorySeparatorChar);
        if (!TryResolveHydrationSidecarPath(webRoot, relativePath, out string targetPath))
        {
            logger.LogWarning("public_aot_hydration_sidecar_path_invalid");
            return;
        }

        Directory.CreateDirectory(Path.GetDirectoryName(targetPath)!);

        if (HydrationSidecarExistsCache.ContainsKey(targetPath))
        {
            return;
        }

        if (File.Exists(targetPath))
        {
            HydrationSidecarExistsCache.TryAdd(targetPath, 0);
            return;
        }

        string tempPath = Path.Combine(Path.GetDirectoryName(targetPath)!, $"{Path.GetFileName(targetPath)}.{Guid.NewGuid():N}.tmp");
        await File.WriteAllBytesAsync(tempPath, PublicAotDocumentComposer.DecodePayloadFrameBytes(hydrationPayload), cancellationToken).ConfigureAwait(false);
        File.Move(tempPath, targetPath, overwrite: true);
        HydrationSidecarExistsCache.TryAdd(targetPath, 0);
    }

    private static bool TryResolveHydrationSidecarPath(string webRoot, string relativePath, out string targetPath)
        => CanonicalPathBoundary.TryResolveRelative(webRoot, relativePath, out targetPath);

    private static string BuildHeadLinks(string rawTemplate, SpaAssetSet assetSet, SeoConfigReadModel seo)
    {
        var builder = new StringBuilder();
        AppendRuntimeMeta(builder, "theme-color", seo.ThemeColor);
        AppendRuntimeLink(builder, "icon", seo.FaviconSvgUrl, "image/svg+xml");
        AppendRuntimeLink(builder, "icon", seo.FaviconIcoUrl, "image/x-icon");
        AppendRuntimeLink(builder, "icon", seo.FaviconPngUrl, "image/png");
        AppendRuntimeLink(builder, "apple-touch-icon", seo.AppleTouchIconUrl, null);

        foreach (string preload in assetSet.ModulePreloads.Where(static href => !string.IsNullOrWhiteSpace(href)).Distinct(StringComparer.Ordinal))
        {
            if (!rawTemplate.Contains($"href=\"{preload}\"", StringComparison.Ordinal))
            {
                builder.Append("    <link rel=\"modulepreload\" crossorigin href=\"")
                    .Append(WebUtility.HtmlEncode(preload))
                    .AppendLine("\" />");
            }
        }

        foreach (string stylesheet in assetSet.Stylesheets.Where(static href => !string.IsNullOrWhiteSpace(href)).Distinct(StringComparer.Ordinal))
        {
            if (!rawTemplate.Contains($"href=\"{stylesheet}\"", StringComparison.Ordinal))
            {
                builder.Append("    <link rel=\"stylesheet\" href=\"")
                    .Append(WebUtility.HtmlEncode(stylesheet))
                    .AppendLine("\" data-fsusblog-style=\"public-manifest\" />");
            }
        }

        return builder.ToString().TrimEnd();
    }

    private static string BuildAssetSignature(SpaAssetSet assetSet)
        => string.Join('|',
            assetSet.EntryScript,
            string.Join(',', assetSet.ModulePreloads),
            string.Join(',', assetSet.Stylesheets),
            assetSet.FullAppTakeover.ModulePreloads.Count,
            assetSet.FullAppTakeover.Stylesheets.Count);

    private static string BuildSeoSignature(SeoConfigReadModel seo)
        => string.Join('|',
            seo.ThemeColor,
            seo.FaviconSvgUrl,
            seo.FaviconIcoUrl,
            seo.FaviconPngUrl,
            seo.AppleTouchIconUrl,
            seo.OgImage);

    private static string ComputeStableHash(string value)
    {
        byte[] bytes = Encoding.UTF8.GetBytes(value);
        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(bytes, hash);
        return Convert.ToHexStringLower(hash);
    }

    private static void AppendRuntimeMeta(StringBuilder builder, string name, string content)
    {
        if (string.IsNullOrWhiteSpace(content))
        {
            return;
        }

        builder.Append("    <meta name=\"")
            .Append(WebUtility.HtmlEncode(name))
            .Append("\" content=\"")
            .Append(WebUtility.HtmlEncode(content))
            .AppendLine("\" data-fsusblog-seo=\"runtime\" />");
    }

    private static PublicPageKind ResolvePageKind(PublicPageId pageId)
        => pageId switch
        {
            PublicPageId.Home => PublicPageKind.Home,
            PublicPageId.ArticleDetail => PublicPageKind.ArticleDetail,
            PublicPageId.Filter => PublicPageKind.Filter,
            PublicPageId.Archive => PublicPageKind.Archive,
            PublicPageId.About => PublicPageKind.About,
            PublicPageId.Account => PublicPageKind.Account,
            PublicPageId.Privacy => PublicPageKind.Privacy,
            PublicPageId.Guidelines => PublicPageKind.Guidelines,
            PublicPageId.Copyright => PublicPageKind.Copyright,
            _ => PublicPageKind.Home
        };

    private static void AppendRuntimeLink(StringBuilder builder, string rel, string href, string? type)
    {
        if (string.IsNullOrWhiteSpace(href))
        {
            return;
        }

        builder.Append("    <link rel=\"")
            .Append(WebUtility.HtmlEncode(rel))
            .Append('"');
        if (!string.IsNullOrWhiteSpace(type))
        {
            builder.Append(" type=\"")
                .Append(WebUtility.HtmlEncode(type))
                .Append('"');
        }

        builder.Append(" href=\"")
            .Append(WebUtility.HtmlEncode(href))
            .AppendLine("\" data-fsusblog-seo=\"runtime\" />");
    }

    private static string ResolveTitle(PublicAotShellEntryContract entry, DecodedEntryPayloads payloads, string fallback)
    {
        if (!string.IsNullOrWhiteSpace(entry.Title))
        {
            return NormalizeOptionalText(entry.Title!, entry.ArticleId);
        }

        string payloadTitle = ResolvePayloadString(payloads.Hydration, "title", string.Empty);
        if (!string.IsNullOrWhiteSpace(payloadTitle))
        {
            return payloadTitle;
        }

        PublicAotPageDescriptor descriptor = PublicAotPageCatalog.GetRequired(entry.PageId);
        return !string.IsNullOrWhiteSpace(descriptor.DefaultTitle) ? descriptor.DefaultTitle : fallback;
    }

    private sealed record PreparedTemplateCacheEntry(
        string RawTemplate,
        string PreparedTemplate,
        string AssetVersion,
        string TemplateHash);

    private sealed record SeoDocumentContext(
        SeoConfigReadModel Seo,
        PublicPageKind Kind,
        string Title,
        string SiteTitle,
        string Description,
        string CanonicalUrl,
        PublicAotArticleSeoMetadata? ArticleSeo,
        PublicSeoHeadModel Head);

    private static string ResolveDescription(PublicAotShellEntryContract entry, DecodedEntryPayloads payloads, string fallback)
    {
        string siteDescription = ResolvePayloadString(payloads.Hydration, "siteDescription", fallback);
        if (entry.PageId == PublicPageId.ArticleDetail &&
            payloads.Bootstrap is not null &&
            PublicAotBinaryPayload.TryGetObject(payloads.Bootstrap, "article") is { } article)
        {
            string summary = PublicAotBinaryPayload.TryGetString(article, "summary");
            if (!string.IsNullOrWhiteSpace(summary))
            {
                return Summarize(summary, siteDescription);
            }

            string content = PublicAotBinaryPayload.TryGetString(article, "content");
            return Summarize(content, siteDescription);
        }

        return siteDescription;
    }

    private static DecodedEntryPayloads DecodeEntryPayloads(PublicAotShellEntryContract entry)
    {
        Dictionary<string, object?>? bootstrap = PublicAotBinaryPayload.TryDecodeObject(entry.BootstrapPayload, out Dictionary<string, object?> bootstrapRoot)
            ? bootstrapRoot
            : null;
        Dictionary<string, object?>? hydration = PublicAotBinaryPayload.TryDecodeObject(entry.HydrationPropsPayload, out Dictionary<string, object?> hydrationRoot)
            ? hydrationRoot
            : null;

        return new DecodedEntryPayloads(bootstrap, hydration);
    }

    private static string ResolvePayloadString(IReadOnlyDictionary<string, object?>? payload, string propertyName, string fallback)
    {
        if (payload is null)
        {
            return fallback;
        }

        string text = PublicAotBinaryPayload.TryGetString(payload, propertyName);
        return string.IsNullOrWhiteSpace(text) ? fallback : text;
    }

    private static string ResolveCanonicalPath(PublicAotShellEntryContract entry)
        => PublicRouteIdentity.BuildCanonicalPath(entry.PageId, entry.RouteKey, entry.ArticleId);

    private static string ResolveCanonicalBaseUrl(string? entryBaseUrl, string? configuredBaseUrl)
    {
        string? configured = NormalizeBaseUrlOrNull(configuredBaseUrl);
        string? entry = NormalizeBaseUrlOrNull(entryBaseUrl);
        if (!string.IsNullOrWhiteSpace(configured) && (string.IsNullOrWhiteSpace(entry) || IsProjectDefaultBaseUrl(entry)))
        {
            return configured;
        }

        return entry ?? configured ?? "https://fsus.blog";
    }

    private static bool IsProjectDefaultBaseUrl(string value)
        => string.Equals(value, "https://fsus.blog", StringComparison.OrdinalIgnoreCase)
            || string.Equals(value, "https://blog.fsus.blog", StringComparison.OrdinalIgnoreCase)
            || string.Equals(value, "https://example.com", StringComparison.OrdinalIgnoreCase);

    private static PublicAotArticleSeoMetadata? BuildArticleSeoMetadata(
        PublicPageKind kind,
        DecodedEntryPayloads payloads,
        string canonicalUrl,
        string title,
        string description,
        string siteTitle,
        SeoConfigReadModel seo)
    {
        if (kind != PublicPageKind.ArticleDetail)
        {
            return null;
        }

        IReadOnlyDictionary<string, object?>? payload =
            TryResolveArticlePayload(payloads.Hydration)
            ?? TryResolveArticlePayload(payloads.Bootstrap)
            ?? payloads.Hydration
            ?? payloads.Bootstrap;
        string headline = ResolvePayloadString(payload, "title", title);
        string author = ResolvePayloadString(payload, "authorName", seo.Author);
        string image = ResolvePayloadString(payload, "coverImageUrl", seo.OgImage);
        DateTime? publishedAt = ResolvePayloadDate(payload, "publishedAt") ?? ResolvePayloadDate(payload, "createTime");
        DateTime? modifiedAt = ResolvePayloadDate(payload, "updatedAt") ?? publishedAt;
        string publisherLogo = FirstNonEmpty(seo.SiteLogoUrl, seo.SiteLogoDarkUrl, seo.SiteWordmarkUrl, seo.LoginLogoUrl, seo.LoginIconUrl);

        return new PublicAotArticleSeoMetadata(
            headline,
            description,
            canonicalUrl,
            publishedAt,
            modifiedAt,
            author,
            image,
            siteTitle,
            publisherLogo);
    }

    private static IReadOnlyDictionary<string, object?>? TryResolveArticlePayload(IReadOnlyDictionary<string, object?>? payload)
        => payload is null
            ? null
            : PublicAotBinaryPayload.TryGetObject(payload, "article");

    private static DateTime? ResolvePayloadDate(IReadOnlyDictionary<string, object?>? payload, string propertyName)
    {
        string raw = ResolvePayloadString(payload, propertyName, string.Empty);
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        if (DateTimeOffset.TryParse(
            raw,
            System.Globalization.CultureInfo.InvariantCulture,
            System.Globalization.DateTimeStyles.AssumeUniversal | System.Globalization.DateTimeStyles.AdjustToUniversal,
            out DateTimeOffset dateTimeOffset))
        {
            return dateTimeOffset.UtcDateTime;
        }

        return null;
    }

    private static string FirstNonEmpty(params string?[] values)
        => values.FirstOrDefault(static value => !string.IsNullOrWhiteSpace(value))?.Trim() ?? string.Empty;

    private static string Summarize(string raw, string fallback)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return fallback;
        }

        string normalized = raw.Replace("\r\n", " ", StringComparison.Ordinal).Replace('\n', ' ').Trim();
        return normalized.Length <= 160 ? normalized : string.Concat(normalized.AsSpan(0, 160), "...");
    }

    private static string NormalizeHtml(string html, int? articleId)
        => articleId is > 0
            ? html.Replace("{{articleId}}", articleId.Value.ToString(), StringComparison.OrdinalIgnoreCase)
            : html;

    private static string NormalizeOptionalText(string value, int? articleId)
        => articleId is > 0
            ? value.Replace("{{articleId}}", articleId.Value.ToString(), StringComparison.OrdinalIgnoreCase)
            : value;

    private static string? NormalizeBaseUrlOrNull(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        string trimmed = value.Trim().TrimEnd('/');
        return Uri.TryCreate(trimmed, UriKind.Absolute, out Uri? uri)
            && (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps)
            && string.IsNullOrEmpty(uri.Query)
            && string.IsNullOrEmpty(uri.Fragment)
                ? trimmed
                : null;
    }

    private sealed record DecodedEntryPayloads(
        IReadOnlyDictionary<string, object?>? Bootstrap,
        IReadOnlyDictionary<string, object?>? Hydration);
}
