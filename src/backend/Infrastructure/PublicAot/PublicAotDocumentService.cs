using System.Net;
using System.Text;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Spa;
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
    private readonly string _configuredBaseUrl = NormalizeBaseUrl(
        configuration["Seo:BaseUrl"]
        ?? configuration["Seo__BaseUrl"]
        ?? configuration["SITE_BASEURL"]
        ?? "https://fsus.blog");

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
            SeoConfigReadModel seo = await systemService.GetSeoConfigAsync();
            SpaAssetSet assetSet = assetManifest.GetPublicAssetSet(context, entry.PageId);
            string rawTemplate = await PublicSpaTemplateLocator.ReadIndexTemplateAsync(env, cancellationToken, assetSet.UsesSourceAssets);
            string preparedTemplate = PublicAotDocumentComposer.PreparePublicDocumentTemplate(rawTemplate);
            DecodedEntryPayloads payloads = DecodeEntryPayloads(entry);
            string title = ResolveTitle(entry, payloads, seo.Title);
            string description = ResolveDescription(entry, payloads, seo.Description);
            string siteTitle = ResolvePayloadString(payloads.Hydration, "siteTitle", seo.Title);
            string canonicalUrl = string.Concat(NormalizeBaseUrl(entry.BaseUrl) ?? _configuredBaseUrl, ResolveCanonicalPath(entry));
            PublicPageKind kind = ResolvePageKind(entry.PageId);
            string shell = PublicAotDocumentComposer.EnsureShellRoot(NormalizeHtml(entry.Html, entry.ArticleId), kind);
            string headLinks = BuildHeadLinks(rawTemplate, assetSet, seo);

            return Result<string>.Success(PublicAotDocumentComposer.ComposeDocument(new PublicAotDocumentModel(
                kind,
                rawTemplate,
                preparedTemplate,
                title,
                siteTitle,
                description,
                canonicalUrl,
                shell,
                NormalizeOptionalText(entry.BootstrapPayload ?? EmptyPayload, entry.ArticleId),
                NormalizeOptionalText(entry.HydrationPropsPayload ?? string.Empty, entry.ArticleId),
                NormalizeOptionalText(entry.IslandsPayload ?? string.Empty, entry.ArticleId),
                assetSet.EntryScript,
                headLinks)
            {
                FullAppTakeover = assetSet.FullAppTakeover
            }));
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to compose public AOT document: {PageId} {RouteKey}", entry.PageId, entry.RouteKey);
            return Result<string>.Failure(ErrorCode.InfraFailure, "public_aot_document_compose_failed");
        }
    }

    private static string BuildHeadLinks(string rawTemplate, SpaAssetSet assetSet, SeoConfigReadModel seo)
    {
        var builder = new StringBuilder();
        AppendRuntimeMeta(builder, "theme-color", seo.ThemeColor);
        AppendRuntimeLink(builder, "icon", seo.FaviconSvgUrl, "image/svg+xml");
        AppendRuntimeLink(builder, "icon", seo.FaviconIcoUrl, "image/x-icon");
        AppendRuntimeLink(builder, "icon", seo.FaviconPngUrl, "image/png");
        AppendRuntimeLink(builder, "apple-touch-icon", seo.AppleTouchIconUrl, null);
        AppendRuntimeMetaProperty(builder, "og:image", seo.OgImage);
        AppendRuntimeMeta(builder, "twitter:image", seo.OgImage);

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

    private static void AppendRuntimeMetaProperty(StringBuilder builder, string property, string content)
    {
        if (string.IsNullOrWhiteSpace(content))
        {
            return;
        }

        builder.Append("    <meta property=\"")
            .Append(WebUtility.HtmlEncode(property))
            .Append("\" content=\"")
            .Append(WebUtility.HtmlEncode(content))
            .AppendLine("\" data-fsusblog-seo=\"runtime\" />");
    }

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

    private static string NormalizeBaseUrl(string? value)
        => string.IsNullOrWhiteSpace(value) ? "https://fsus.blog" : value.Trim().TrimEnd('/');

    private sealed record DecodedEntryPayloads(
        IReadOnlyDictionary<string, object?>? Bootstrap,
        IReadOnlyDictionary<string, object?>? Hydration);
}
