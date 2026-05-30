using System.Net;
using System.Text;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Spa;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Shared.Contracts.Outputs;

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
            string rawTemplate = await PublicSpaTemplateLocator.ReadIndexTemplateAsync(env, cancellationToken);
            SpaAssetSet assetSet = assetManifest.GetPublicAssetSet();
            string preparedTemplate = PublicAotDocumentComposer.PreparePublicDocumentTemplate(rawTemplate);
            DecodedEntryPayloads payloads = DecodeEntryPayloads(entry);
            string title = ResolveTitle(entry, payloads, seo.Title);
            string description = ResolveDescription(entry, payloads, seo.Description);
            string siteTitle = ResolvePayloadString(payloads.Hydration, "siteTitle", seo.Title);
            string canonicalUrl = string.Concat(NormalizeBaseUrl(entry.BaseUrl) ?? _configuredBaseUrl, ResolveCanonicalPath(entry));
            PublicPageKind kind = PublicAotPageCatalog.GetRequired(entry.PageId).Kind;
            string shell = PublicAotDocumentComposer.EnsureShellRoot(NormalizeHtml(entry.Html, entry.ArticleId), kind);
            string headLinks = BuildHeadLinks(rawTemplate, assetSet);

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
                headLinks)));
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to compose public AOT document: {PageId} {RouteKey}", entry.PageId, entry.RouteKey);
            return Result<string>.Failure(ErrorCode.InfraFailure, "public_aot_document_compose_failed");
        }
    }

    private static string BuildHeadLinks(string rawTemplate, SpaAssetSet assetSet)
    {
        var builder = new StringBuilder();
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
