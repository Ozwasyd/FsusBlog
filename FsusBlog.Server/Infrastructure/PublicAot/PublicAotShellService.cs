using System.Net;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Models.ReadModels;
using Microsoft.AspNetCore.Http;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed partial class PublicAotShellService(
    IWebHostEnvironment env,
    IConfiguration configuration,
    IArticleService articleService,
    ISystemService systemService,
    IPublicAotShellCache cache,
    IPublicAotCacheWriter cacheWriter,
    IPublicAotBackfillScheduler backfillScheduler,
    IPublicAotSsrRenderer ssrRenderer,
    ILogger<PublicAotShellService> logger) : IPublicAotShellService
    , IPublicAotBackfillGenerator
{
    private delegate Task BootstrapPayloadPopulator(
        HttpContext context,
        Dictionary<string, object?> payload,
        CancellationToken cancellationToken);

    private delegate string HydrationPropsBuilder(JsonElement root, string siteTitle, string siteDescription);

    internal const string PublicRendererVersion = "public-vue-renderer@2026-04-06-2";
    internal static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull
    };

    private readonly IWebHostEnvironment _env = env;
    private readonly IArticleService _articleService = articleService;
    private readonly ISystemService _systemService = systemService;
    private readonly IPublicAotShellCache _cache = cache;
    private readonly IPublicAotCacheWriter _cacheWriter = cacheWriter;
    private readonly IPublicAotBackfillScheduler _backfillScheduler = backfillScheduler;
    private readonly IPublicAotSsrRenderer _ssrRenderer = ssrRenderer;
    private readonly ILogger<PublicAotShellService> _logger = logger;
    private readonly string _configuredBaseUrl = NormalizeConfiguredBaseUrl(
        configuration["Seo:BaseUrl"]
        ?? configuration["Seo__BaseUrl"]
        ?? configuration["SITE_BASEURL"]
        ?? "https://fsus.blog");
    private IReadOnlyDictionary<PublicPageKind, PagePipeline>? _pagePipelines;
    public const string PublicAotSourceContextKey = "__fsus_public_aot_source";
    public const string PublicAotVersionContextKey = "__fsus_public_aot_version";
    public const string PublicAotBackfillContextKey = "__fsus_public_aot_backfill";
    private sealed record PagePipeline(
        PublicAotPageDescriptor Descriptor,
        BootstrapPayloadPopulator PopulateBootstrapPayload,
        HydrationPropsBuilder BuildHydrationProps);

    private IReadOnlyDictionary<PublicPageKind, PagePipeline> PagePipelines
        => _pagePipelines ??= new Dictionary<PublicPageKind, PagePipeline>
        {
            [PublicPageKind.Home] = new(
                PublicAotPageCatalog.Home,
                PopulateHomeBootstrapPayloadAsync,
                PublicAotHydrationPayloadBuilder.BuildHome),
            [PublicPageKind.ArticleDetail] = new(
                PublicAotPageCatalog.ArticleDetail,
                PopulateArticleDetailBootstrapPayloadAsync,
                PublicAotHydrationPayloadBuilder.BuildArticleDetail),
            [PublicPageKind.Filter] = new(
                PublicAotPageCatalog.Filter,
                PopulateFilterBootstrapPayloadAsync,
                PublicAotHydrationPayloadBuilder.BuildFilter),
            [PublicPageKind.About] = new(
                PublicAotPageCatalog.About,
                PopulateAboutBootstrapPayloadAsync,
                PublicAotHydrationPayloadBuilder.BuildAbout),
            [PublicPageKind.Archive] = new(
                PublicAotPageCatalog.Archive,
                PopulateArchiveBootstrapPayloadAsync,
                PublicAotHydrationPayloadBuilder.BuildArchive)
        };

    public bool TryResolve(HttpContext context, out PublicPageKind kind)
    {
        kind = ResolveKind(context.Request.Path, context.Request.Query);
        return kind != PublicPageKind.Unknown;
    }

    public async Task<string?> RenderAsync(HttpContext context, CancellationToken cancellationToken = default)
    {
        if (!TryResolve(context, out var kind))
        {
            return null;
        }

        string routeKey = PublicAotShellKeyBuilder.BuildRouteKey(context, kind);
        PublicPageId pageId = PublicAotShellKeyBuilder.ToPageId(kind);
        string documentCacheKey = CacheKeyBuilder.PublicAotDocument(pageId, routeKey);
        PublicAotCacheEntry? entry = await _cache.TryGetEntryAsync(documentCacheKey, cancellationToken);
        if (IsRenderableCacheEntry(entry))
        {
            context.Items[PublicAotSourceContextKey] = entry!.Source.ToHeaderValue();
            context.Items[PublicAotVersionContextKey] = entry.RendererVersion;
            context.Items[PublicAotBackfillContextKey] = "none";
            return entry.Value;
        }

        if (entry is not null)
        {
            await _cache.RemoveAsync(documentCacheKey, cancellationToken);
        }

        bool queued = _backfillScheduler.TrySchedule(new PublicAotBackfillRequest(
            kind,
            routeKey,
            context.Request.Path.Value ?? string.Empty,
            context.Request.QueryString.Value ?? string.Empty,
            documentCacheKey));
        context.Items[PublicAotSourceContextKey] = "spa-fallback";
        context.Items[PublicAotVersionContextKey] = PublicRendererVersion;
        context.Items[PublicAotBackfillContextKey] = queued ? "queued" : "pending";
        _logger.LogInformation("Public AOT cache miss -> SPA fallback ({QueueStatus}): {Kind} {RouteKey}", queued ? "queued" : "pending", kind, routeKey);
        return string.Empty;
    }

    public async Task<Result> StoreAsync(PublicAotShellBundleContract bundle, CancellationToken cancellationToken = default)
    {
        if (bundle.Entries is null || bundle.Entries.Count == 0)
        {
            return Result.Failure(ErrorCode.Validation, "AOT 缓存包为空");
        }

        string template = await ReadIndexTemplateAsync(cancellationToken);
        var preparedEntries = new List<(PublicPageId PageId, string RouteKey, string Html, string RendererVersion)>(bundle.Entries.Count);

        foreach (var entry in bundle.Entries)
        {
            var validation = PublicAotShellKeyBuilder.ValidateBundleEntry(entry, out string normalizedRouteKey, out string normalizedHtml);
            if (!validation.IsSuccess)
            {
                return validation;
            }

            string documentHtml = BuildStoredIndexDocument(template, entry, normalizedHtml);
            preparedEntries.Add((entry.PageId, normalizedRouteKey, documentHtml, NormalizeOptionalText(entry.RendererVersion ?? PublicRendererVersion, entry.ArticleId)));
        }

        foreach (var entry in preparedEntries)
        {
            string cacheKey = CacheKeyBuilder.PublicAotDocument(entry.PageId, entry.RouteKey);
            await _cache.RemoveAsync(cacheKey, cancellationToken);
            await _cacheWriter.WriteAsync(
                cacheKey,
                entry.PageId,
                entry.RouteKey,
                entry.RendererVersion,
                entry.Html,
                PublicAotWriteSource.AdminUpload,
                bundle.GeneratedAtUtc,
                TimeSpan.FromDays(30),
                cancellationToken);
        }

        return Result.Success();
    }

    public async Task GenerateAndStoreAsync(PublicAotBackfillRequest request, CancellationToken cancellationToken = default)
    {
        var context = new DefaultHttpContext();
        context.Request.Path = string.IsNullOrWhiteSpace(request.Path) ? "/" : request.Path;
        context.Request.QueryString = string.IsNullOrWhiteSpace(request.QueryString)
            ? QueryString.Empty
            : new QueryString(request.QueryString);

        Result<(string Html, string RendererVersion)> document = await BuildServerBackfillDocumentAsync(context, request.Kind, cancellationToken);
        if (document.IsFailure)
        {
            _logger.LogWarning(
                "Public AOT SSR backfill skipped due to recoverable render failure: {Kind} {RouteKey} {Message}",
                request.Kind,
                request.RouteKey,
                document.Error.Message);
            return;
        }

        (string html, string rendererVersion) = document.Value;
        PublicPageId pageId = PublicAotPageCatalog.GetRequired(request.Kind).PageId;
        await _cacheWriter.WriteAsync(
            request.CacheKey,
            pageId,
            request.RouteKey,
            rendererVersion,
            html,
            PublicAotWriteSource.ServerSsrBackfill,
            DateTimeOffset.UtcNow,
            TimeSpan.FromDays(30),
            cancellationToken);
    }

    public Task<Result> InvalidateAllAsync(CancellationToken cancellationToken = default)
    {
        return InvalidateAllCoreAsync(cancellationToken);
    }

    private async Task<Result> InvalidateAllCoreAsync(CancellationToken cancellationToken)
    {
        await _cache.InvalidateAllAsync(cancellationToken);
        return Result.Success();
    }

    private async Task<Result<(string Html, string RendererVersion)>> BuildServerBackfillDocumentAsync(
        HttpContext context,
        PublicPageKind kind,
        CancellationToken cancellationToken)
    {
        SeoConfigReadModel seo = await _systemService.GetSeoConfigAsync();
        JsonElement bootstrapRoot = await BuildBootstrapAsync(context, kind, seo, cancellationToken);
        string bootstrapJson = JsonSerializer.Serialize(bootstrapRoot, JsonOptions);
        string title = ResolveDocumentTitle(kind, bootstrapRoot, seo.Title);
        string description = BuildDescription(kind, bootstrapRoot, seo.Description);
        string canonicalUrl = BuildCanonicalUrl(context, kind);
        string hydrationPropsJson = BuildHydrationPropsJson(kind, bootstrapRoot, seo.Title, seo.Description);
        string islandsJson = BuildIslandsJson(kind, bootstrapRoot);
        Result<PublicAotSsrRenderResult> renderResult = await _ssrRenderer.RenderAsync(kind, hydrationPropsJson, cancellationToken);
        if (renderResult.IsFailure || renderResult.Value is null)
        {
            return Result<(string Html, string RendererVersion)>.Failure(renderResult.Error);
        }
        PublicAotSsrRenderResult rendered = renderResult.Value;
        string rawTemplate = await ReadIndexTemplateAsync(cancellationToken);
        rawTemplate = EnsureCriticalPublicCssLink(rawTemplate);
        rawTemplate = EnsureDevCssDirectLinks(rawTemplate);
        rawTemplate = EnsureSupplementaryStylesheetLink(rawTemplate);
        string template = PublicAotDocumentComposer.PreparePublicDocumentTemplate(rawTemplate);
        string wrappedShell = PublicAotDocumentComposer.EnsureShellRoot(rendered.Html, kind);

        return Result<(string Html, string RendererVersion)>.Success((PublicAotDocumentComposer.ComposeDocument(new PublicAotDocumentModel(
            kind,
            rawTemplate,
            template,
            title,
            seo.Title,
            description,
            canonicalUrl,
            wrappedShell,
            bootstrapJson,
            hydrationPropsJson,
            islandsJson)),
            rendered.RendererVersion));
    }

    private static bool IsRenderableCacheEntry(PublicAotCacheEntry? entry)
    {
        if (entry is null || string.IsNullOrWhiteSpace(entry.Value))
        {
            return false;
        }

        if (string.IsNullOrWhiteSpace(entry.RendererVersion))
        {
            return false;
        }

        return string.Equals(entry.RendererVersion, PublicRendererVersion, StringComparison.Ordinal);
    }

    private string EnsureCriticalPublicCssLink(string template)
    {
        const string marker = "<link rel=\"stylesheet\" href=\"/src/assets/public-page.css\" data-fsus-style=\"public-page\" />";
        string criticalHref = ResolveCriticalStylesheetHref() ?? "/src/assets/public-shell-critical.css";
        string link = $"""<link rel="stylesheet" href="{criticalHref}" data-fsus-style="public-shell-critical" />""";

        if (template.Contains(link, StringComparison.Ordinal))
        {
            return template;
        }

        if (template.Contains(marker, StringComparison.Ordinal))
        {
            return template.Replace(marker, $"{link}\n    {marker}", StringComparison.Ordinal);
        }

        const string headClose = "</head>";
        return template.Contains(headClose, StringComparison.OrdinalIgnoreCase)
            ? Regex.Replace(template, "</head>", $"    {link}\n  </head>", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)
            : template + "\n" + link;
    }

    private bool TryGetPagePipeline(PublicPageKind kind, out PagePipeline pipeline)
        => PagePipelines.TryGetValue(kind, out pipeline!);

    private async Task<JsonElement> BuildBootstrapAsync(HttpContext context, PublicPageKind kind, SeoConfigReadModel seo, CancellationToken cancellationToken)
    {
        string routeKey = PublicAotShellKeyBuilder.BuildRouteKey(context, kind);
        var payload = new Dictionary<string, object?>
        {
            ["kind"] = kind.ToString(),
            ["pageKind"] = kind.ToString(),
            ["routeKey"] = routeKey,
            ["rendererVersion"] = PublicRendererVersion,
            ["path"] = context.Request.Path.Value,
            ["query"] = context.Request.QueryString.Value,
            ["siteTitle"] = seo.Title,
            ["siteDescription"] = seo.Description,
            ["generatedAt"] = DateTimeOffset.UtcNow
        };

        if (TryGetPagePipeline(kind, out PagePipeline pipeline))
        {
            await pipeline.PopulateBootstrapPayload(context, payload, cancellationToken);
        }

        return JsonSerializer.SerializeToElement(payload, JsonOptions);
    }

    private async Task PopulateHomeBootstrapPayloadAsync(
        HttpContext _,
        Dictionary<string, object?> payload,
        CancellationToken __)
    {
        var page = await _articleService.GetPageListAsync(1, 8, null, null, false);
        payload["total"] = page.Total;
        payload["pageIndex"] = 1;
        payload["pageSize"] = 8;
        payload["articles"] = page.Items.Select(item => new
        {
            item.Id,
            item.Title,
            item.Summary,
            item.Snippet,
            item.Views,
            item.CreateTime,
            Category = item.CategoryName,
            Tags = item.Tags.Select(t => t.Name).ToArray()
        }).ToArray();
    }

    private async Task PopulateArchiveBootstrapPayloadAsync(
        HttpContext _,
        Dictionary<string, object?> payload,
        CancellationToken cancellationToken)
    {
        List<ArticleListItemReadModel> articles = await LoadAllArchiveArticlesAsync(cancellationToken);
        payload["total"] = articles.Count;
        payload["articles"] = articles.Select(item => new
        {
            item.Id,
            item.Title,
            item.CreateTime
        }).ToArray();
    }

    private async Task PopulateArticleDetailBootstrapPayloadAsync(
        HttpContext context,
        Dictionary<string, object?> payload,
        CancellationToken _)
    {
        if (TryResolvePathId(context, "/article/", out int id))
        {
            payload["articleId"] = id;
            var article = await _articleService.GetByIdAsync(id);
            if (article is not null)
            {
                ArticleDetailResponse articleResponse = ArticleProjection.ToResponse(article);
                payload["article"] = new
                {
                    articleResponse.Id,
                    articleResponse.Title,
                    articleResponse.Summary,
                    articleResponse.Content,
                    articleResponse.Views,
                    articleResponse.WordCount,
                    articleResponse.EstimatedReadingMinutes,
                    articleResponse.ShowReadingNotice,
                    articleResponse.CreateTime,
                    Category = new
                    {
                        articleResponse.Category.Id,
                        articleResponse.Category.Name
                    },
                    Tags = articleResponse.Tags.Select(t => t.Name).ToArray()
                };
            }
        }

        SeoConfigReadModel seo = await _systemService.GetSeoConfigAsync();
        payload["authorName"] = seo.Author;
        payload["commentsPlaceholder"] = "评论将在 SPA 接管后加载";
    }

    private async Task PopulateFilterBootstrapPayloadAsync(
        HttpContext context,
        Dictionary<string, object?> payload,
        CancellationToken cancellationToken)
    {
        var page = await BuildFilterBootstrapAsync(context, cancellationToken);
        payload["filter"] = page;
    }

    private async Task PopulateAboutBootstrapPayloadAsync(
        HttpContext _,
        Dictionary<string, object?> payload,
        CancellationToken __)
    {
        var about = await _systemService.GetPageContentAsync("about");
        payload["about"] = new { about.Slug, about.Content };
    }

    private static Result ValidateBundleEntry(PublicAotShellEntryContract entry, out string routeKey, out string html)
    {
        routeKey = string.Empty;
        html = string.Empty;

        if (!PublicAotShellContractRules.TryValidateEntry(entry, out routeKey, out html, out string error))
        {
            return Result.Failure(ErrorCode.Validation, error);
        }

        return Result.Success();
    }

    private static string NormalizeRouteKey(PublicPageId pageId, string routeKey, int? articleId)
    {
        string resolved = routeKey.Trim();
        if (articleId is > 0)
        {
            resolved = resolved.Replace("{{articleId}}", articleId.Value.ToString(), StringComparison.OrdinalIgnoreCase);
        }

        return pageId switch
        {
            PublicPageId.Home => "home",
            PublicPageId.About => "about",
            PublicPageId.Archive => "archive",
            _ => resolved
        };
    }

    private static string NormalizeHtml(string html, int? articleId)
    {
        if (articleId is not > 0)
        {
            return html;
        }

        return html.Replace("{{articleId}}", articleId.Value.ToString(), StringComparison.OrdinalIgnoreCase);
    }

    private static PublicPageKind ToKind(PublicPageId pageId)
        => PublicAotPageCatalog.GetRequired(pageId).Kind;

    private async Task<object> BuildFilterBootstrapAsync(HttpContext context, CancellationToken cancellationToken)
    {
        int pageIndex = 1;
        int pageSize = 10;
        string path = context.Request.Path.Value ?? string.Empty;
        int? categoryId = null;
        int? tagId = null;
        if (path.Contains("/category/", StringComparison.OrdinalIgnoreCase) && TryResolvePathId(context, "/category/", out int catId))
        {
            categoryId = catId;
        }
        else if (path.Contains("/tag/", StringComparison.OrdinalIgnoreCase) && TryResolvePathId(context, "/tag/", out int tgId))
        {
            tagId = tgId;
        }

        var page = await _articleService.GetPageListAsync(pageIndex, pageSize, categoryId, tagId, false);

        return new
        {
            pageIndex,
            pageSize,
            total = page.Total,
            articles = page.Items.Select(item => new
            {
                item.Id,
                item.Title,
                item.Summary,
                item.Snippet,
                item.Views,
                item.CreateTime,
                Category = item.CategoryName,
                Tags = item.Tags.Select(t => t.Name).ToArray()
            }).ToArray()
        };
    }

    private static PublicPageKind ResolveKind(PathString path, IQueryCollection query)
    {
        var value = path.Value?.TrimEnd('/') ?? string.Empty;
        if (string.IsNullOrEmpty(value) || value == "/")
        {
            return PublicPageKind.Home;
        }

        if (value.StartsWith("/article/", StringComparison.OrdinalIgnoreCase))
        {
            return PublicPageKind.ArticleDetail;
        }

        if (value.StartsWith("/category/", StringComparison.OrdinalIgnoreCase) ||
            value.StartsWith("/tag/", StringComparison.OrdinalIgnoreCase))
        {
            return PublicPageKind.Filter;
        }

        if (PublicAotPageCatalog.TryGetByStaticPath(value, out PublicAotPageDescriptor? descriptor))
        {
            return descriptor.Kind;
        }

        return PublicPageKind.Unknown;
    }

    private static string GetTitle(PublicPageKind kind, PathString path, string siteTitle)
    {
        PublicAotPageDescriptor descriptor = PublicAotPageCatalog.GetRequired(kind);
        return kind == PublicPageKind.Home
            ? siteTitle
            : (string.IsNullOrWhiteSpace(descriptor.DefaultTitle) ? siteTitle : descriptor.DefaultTitle);
    }

    private async Task<string> ReadIndexTemplateAsync(CancellationToken cancellationToken)
    {
        return await PublicSpaTemplateLocator.ReadIndexTemplateAsync(_env, cancellationToken);
    }

    private static bool TryResolvePathId(HttpContext context, string prefix, out int id)
    {
        id = 0;
        if (int.TryParse(context.Request.RouteValues["id"]?.ToString(), out id))
        {
            return true;
        }

        string path = context.Request.Path.Value ?? string.Empty;
        if (!path.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        ReadOnlySpan<char> tail = path.AsSpan(prefix.Length);
        int slashIndex = tail.IndexOf('/');
        if (slashIndex >= 0)
        {
            tail = tail[..slashIndex];
        }

        return int.TryParse(tail, out id);
    }

    private string BuildStoredIndexDocument(string template, PublicAotShellEntryContract entry, string normalizedHtml)
    {
        if (normalizedHtml.Contains("<div id=\"app\">", StringComparison.Ordinal) ||
            normalizedHtml.Contains("<!DOCTYPE html>", StringComparison.OrdinalIgnoreCase))
        {
            return normalizedHtml;
        }

        string rawTemplate = template;
        template = EnsureCriticalPublicCssLink(template);
        template = EnsureDevCssDirectLinks(template);
        template = EnsureSupplementaryStylesheetLink(template);
        template = PublicAotDocumentComposer.PreparePublicDocumentTemplate(template);
        PublicPageKind kind = ToKind(entry.PageId);
        string title = string.IsNullOrWhiteSpace(entry.Title)
            ? GetTitle(kind, PathString.Empty, "FsusBlog")
            : NormalizeOptionalText(entry.Title!, entry.ArticleId);
        string bootstrapJson = NormalizeOptionalText(entry.BootstrapJson ?? "{}", entry.ArticleId);
        string hydrationPropsJson = NormalizeOptionalText(entry.HydrationPropsJson ?? string.Empty, entry.ArticleId);
        string islandsJson = NormalizeOptionalText(entry.IslandsJson ?? string.Empty, entry.ArticleId);
        string wrappedShell = WrapStoredShell(kind, normalizedHtml);
        string description = string.IsNullOrWhiteSpace(title)
            ? "公开页 AOT 首访内容。"
            : $"{title} - 公开页 AOT 首访内容。";
        string canonicalUrl = BuildCanonicalUrl(entry);

        return PublicAotDocumentComposer.ComposeDocument(new PublicAotDocumentModel(
            kind,
            rawTemplate,
            template,
            title,
            "FsusBlog",
            description,
            canonicalUrl,
            wrappedShell,
            bootstrapJson,
            hydrationPropsJson,
            islandsJson));
    }

    private static string WrapStoredShell(PublicPageKind kind, string shellHtml)
    {
        string pageName = PublicAotPageCatalog.TryGet(kind, out PublicAotPageDescriptor? descriptor)
            ? descriptor.StoredPageName
            : "公开页";

        if (shellHtml.Contains("id=\"fsus-aot-shell\"", StringComparison.Ordinal))
        {
            return PublicAotDocumentComposer.EnsureHydrationKindAttribute(shellHtml, kind);
        }

        string hydrationKind = PublicAotDocumentComposer.ResolveHydrationKind(kind);
        string hydrationAttribute = string.IsNullOrWhiteSpace(hydrationKind)
            ? string.Empty
            : $" data-public-hydration-kind=\"{Encode(hydrationKind)}\"";

        return $"""
<div id="fsus-aot-shell" data-aot-page="{Encode(pageName)}"{hydrationAttribute} class="fsus-aot-shell">
{shellHtml}
</div>
""";
    }

    private static string NormalizeOptionalText(string value, int? articleId)
    {
        if (articleId is not > 0)
        {
            return value;
        }

        return value.Replace("{{articleId}}", articleId.Value.ToString(), StringComparison.OrdinalIgnoreCase);
    }

    private static string BuildDescription(PublicPageKind kind, JsonElement root, string fallback)
    {
        return kind switch
        {
            PublicPageKind.ArticleDetail when root.TryGetProperty("article", out JsonElement article) =>
                BuildArticleDescription(article, fallback),
            PublicPageKind.About when root.TryGetProperty("about", out JsonElement about) =>
                SummarizeForMeta(PublicAotJsonHelpers.TryGetString(about, "content"), fallback),
            _ => fallback
        };
    }

    private static string BuildArticleDescription(JsonElement article, string fallback)
    {
        string summary = PublicAotJsonHelpers.TryGetString(article, "summary");
        if (!string.IsNullOrWhiteSpace(summary))
        {
            return SummarizeForMeta(summary, fallback);
        }

        string content = PublicAotJsonHelpers.TryGetString(article, "content");
        return SummarizeForMeta(content, fallback);
    }

    private static string SummarizeForMeta(string raw, string fallback)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return fallback;
        }

        string normalized = raw
            .Replace("\r\n", " ", StringComparison.Ordinal)
            .Replace('\n', ' ')
            .Trim();

        return normalized.Length <= 160
            ? normalized
            : string.Concat(normalized.AsSpan(0, 160), "...");
    }

    private string EnsureDevCssDirectLinks(string template)
    {
        if (!_env.IsDevelopment())
        {
            return template;
        }

        string publicPageHref = ResolveSupplementaryStylesheetHref() ?? "/src/assets/public-page.css?direct";
        string publicShellCriticalHref = ResolveCriticalStylesheetHref() ?? "/src/assets/public-shell-critical.css";

        const string linkPattern = "<link\\b[^>]*\\brel\\s*=\\s*([\"'])stylesheet\\1[^>]*>";
        string rewritten = Regex.Replace(
            template,
            linkPattern,
            match =>
            {
                string linkTag = match.Value;
                string href = PublicAotDocumentComposer.ExtractAttributeValue(linkTag, "href");
                if (string.IsNullOrWhiteSpace(href))
                {
                    return linkTag;
                }

                string normalizedHref = href;
                if (IsSrcAssetCssHref(href))
                {
                    if (href.Contains("public-shell-critical.css", StringComparison.OrdinalIgnoreCase))
                    {
                        normalizedHref = publicShellCriticalHref;
                    }
                    else if (href.Contains("main.css", StringComparison.OrdinalIgnoreCase)
                        || href.Contains("public-page.css", StringComparison.OrdinalIgnoreCase))
                    {
                        normalizedHref = publicPageHref;
                    }
                    else
                    {
                        normalizedHref = EnsureDirectQueryFlag(href);
                    }
                }
                else if (IsBuiltAssetCssHref(href))
                {
                    // Keep backend-served built assets in dev so pure ASP.NET smoke runs do not depend on Vite src routes.
                    normalizedHref = href;
                }

                return TryReplaceAttributeValue(linkTag, "href", normalizedHref, out string replacedTag)
                    ? replacedTag
                    : linkTag;
            },
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        string criticalHref = publicShellCriticalHref;
        if (!rewritten.Contains($"href=\"{criticalHref}\"", StringComparison.Ordinal))
        {
            const string headClose = "</head>";
            string criticalTag = $"""<link rel="stylesheet" href="{criticalHref}" data-fsus-style="public-shell-critical" />""";
            rewritten = rewritten.Contains(headClose, StringComparison.OrdinalIgnoreCase)
                ? Regex.Replace(rewritten, "</head>", $"    {criticalTag}\n  </head>", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)
                : rewritten + "\n" + criticalTag;
        }

        return rewritten;
    }

    private string EnsureSupplementaryStylesheetLink(string template)
    {
        const string linkPattern = "<link\\b[^>]*\\brel\\s*=\\s*([\"'])stylesheet\\1[^>]*>";
        MatchCollection matches = Regex.Matches(template, linkPattern, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        if (matches.Count >= 2)
        {
            return template;
        }

        string? supplementalHref = ResolveSupplementaryStylesheetHref();
        if (string.IsNullOrWhiteSpace(supplementalHref))
        {
            return template;
        }

        if (template.Contains($"href=\"{supplementalHref}\"", StringComparison.Ordinal))
        {
            return template;
        }

        string linkTag = $"""<link rel="stylesheet" href="{supplementalHref}" data-fsus-style="public-supplemental" />""";
        const string headClose = "</head>";
        return template.Contains(headClose, StringComparison.OrdinalIgnoreCase)
            ? Regex.Replace(template, "</head>", $"    {linkTag}\n  </head>", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)
            : template + "\n" + linkTag;
    }

    private string? ResolveSupplementaryStylesheetHref()
    {
        string webRoot = string.IsNullOrWhiteSpace(_env.WebRootPath)
            ? Path.Combine(_env.ContentRootPath, "wwwroot")
            : _env.WebRootPath;
        string assetsRoot = Path.Combine(webRoot, "assets");

        static string? PickByPrefix(string[] files, string prefix)
        {
            return files
                .Select(Path.GetFileName)
                .Where(name => !string.IsNullOrWhiteSpace(name) && name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                .OrderByDescending(name => name, StringComparer.OrdinalIgnoreCase)
                .FirstOrDefault();
        }

        if (Directory.Exists(assetsRoot))
        {
            string[] files = Directory.GetFiles(assetsRoot, "*.css", SearchOption.TopDirectoryOnly);
            string? match = PickByPrefix(files, "public-page-")
                ?? PickByPrefix(files, "index-")
                ?? PickByPrefix(files, "main-")
                ?? PickByPrefix(files, "full-app-core-")
                ?? PickByPrefix(files, "vendor-element-plus-")
                ?? PickByPrefix(files, "vendor-progress-");
            if (!string.IsNullOrWhiteSpace(match))
            {
                return $"/assets/{match}";
            }
        }

        return _env.IsDevelopment() ? "/src/assets/public-page.css?direct" : null;
    }

    private string? ResolveCriticalStylesheetHref()
    {
        string webRoot = string.IsNullOrWhiteSpace(_env.WebRootPath)
            ? Path.Combine(_env.ContentRootPath, "wwwroot")
            : _env.WebRootPath;
        string assetsRoot = Path.Combine(webRoot, "assets");
        if (Directory.Exists(assetsRoot))
        {
            static string? PickByPrefix(string[] files, string prefix)
            {
                return files
                    .Select(Path.GetFileName)
                    .Where(name => !string.IsNullOrWhiteSpace(name) && name.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
                    .OrderByDescending(name => name, StringComparer.OrdinalIgnoreCase)
                    .FirstOrDefault();
            }

            string[] files = Directory.GetFiles(assetsRoot, "*.css", SearchOption.TopDirectoryOnly);
            string? match = PickByPrefix(files, "full-app-core-")
                ?? PickByPrefix(files, "entry-runtime-")
                ?? PickByPrefix(files, "vendor-progress-");
            if (!string.IsNullOrWhiteSpace(match))
            {
                return $"/assets/{match}";
            }
        }

        return _env.IsDevelopment() ? "/src/assets/public-shell-critical.css" : null;
    }

    private static bool IsSrcAssetCssHref(string href)
    {
        ReadOnlySpan<char> span = href.AsSpan().Trim();
        int hashIndex = span.IndexOf('#');
        if (hashIndex >= 0)
        {
            span = span[..hashIndex];
        }

        int queryIndex = span.IndexOf('?');
        ReadOnlySpan<char> path = queryIndex >= 0 ? span[..queryIndex] : span;
        if (!path.EndsWith(".css", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        return path.StartsWith("/src/assets/", StringComparison.OrdinalIgnoreCase)
            || path.StartsWith("src/assets/", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsBuiltAssetCssHref(string href)
    {
        ReadOnlySpan<char> span = href.AsSpan().Trim();
        int hashIndex = span.IndexOf('#');
        if (hashIndex >= 0)
        {
            span = span[..hashIndex];
        }

        int queryIndex = span.IndexOf('?');
        ReadOnlySpan<char> path = queryIndex >= 0 ? span[..queryIndex] : span;
        if (!path.EndsWith(".css", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        return path.StartsWith("/assets/", StringComparison.OrdinalIgnoreCase)
            || path.StartsWith("assets/", StringComparison.OrdinalIgnoreCase);
    }

    private static string EnsureDirectQueryFlag(string href)
    {
        int hashIndex = href.IndexOf('#');
        string fragment = hashIndex >= 0 ? href[hashIndex..] : string.Empty;
        string withoutFragment = hashIndex >= 0 ? href[..hashIndex] : href;

        int queryIndex = withoutFragment.IndexOf('?');
        if (queryIndex < 0)
        {
            return withoutFragment + "?direct" + fragment;
        }

        string path = withoutFragment[..queryIndex];
        string query = withoutFragment[(queryIndex + 1)..];
        if (QueryContainsFlag(query, "direct"))
        {
            return href;
        }

        string suffix = string.IsNullOrWhiteSpace(query) ? "direct" : $"{query}&direct";
        return $"{path}?{suffix}{fragment}";
    }

    private static bool QueryContainsFlag(string query, string key)
    {
        foreach (string segment in query.Split('&', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            string currentKey = segment;
            int equalsIndex = segment.IndexOf('=');
            if (equalsIndex >= 0)
            {
                currentKey = segment[..equalsIndex];
            }

            if (currentKey.Equals(key, StringComparison.OrdinalIgnoreCase))
            {
                return true;
            }
        }

        return false;
    }

    private static bool TryReplaceAttributeValue(string tag, string attributeName, string newValue, out string result)
    {
        string pattern = $@"({attributeName}\s*=\s*)([""'])(.*?)\2";
        var regex = new Regex(pattern, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
        Match match = regex.Match(tag);
        if (!match.Success)
        {
            result = tag;
            return false;
        }

        string replacement = $"{match.Groups[1].Value}{match.Groups[2].Value}{newValue}{match.Groups[2].Value}";
        result = regex.Replace(tag, replacement, 1);
        return true;
    }

    private async Task<List<ArticleListItemReadModel>> LoadAllArchiveArticlesAsync(CancellationToken cancellationToken)
    {
        const int pageSize = 100;
        var results = new List<ArticleListItemReadModel>(pageSize);
        int pageIndex = 1;

        while (!cancellationToken.IsCancellationRequested)
        {
            ArticleListPageReadModel page = await _articleService.GetPageListAsync(pageIndex, pageSize, null, null, false);
            if (page.Items.Count == 0)
            {
                break;
            }

            results.AddRange(page.Items);
            if (results.Count >= page.Total || page.Items.Count < pageSize)
            {
                break;
            }

            pageIndex++;
        }

        return results;
    }

    private string BuildCanonicalUrl(HttpContext context, PublicPageKind kind)
    {
        string path = kind switch
        {
            PublicPageKind.Home => "/",
            PublicPageKind.ArticleDetail when TryResolvePathId(context, "/article/", out int id) => $"/article/{id}",
            _ => NormalizeRequestPath(context.Request.Path.Value)
        };

        return string.Concat(_configuredBaseUrl, path);
    }

    private string BuildCanonicalUrl(PublicAotShellEntryContract entry)
    {
        string path;
        if (PublicAotPageCatalog.TryGet(entry.PageId, out PublicAotPageDescriptor? descriptor) &&
            !string.IsNullOrWhiteSpace(descriptor.CanonicalFixedPath))
        {
            path = descriptor.CanonicalFixedPath;
        }
        else
        {
            path = entry.PageId switch
            {
                PublicPageId.ArticleDetail when entry.ArticleId is > 0 => $"/article/{entry.ArticleId.Value}",
                PublicPageId.Filter => BuildCanonicalFilterPath(entry.RouteKey),
                _ => "/"
            };
        }

        string baseUrl = NormalizeOptionalBaseUrl(entry.BaseUrl) ?? _configuredBaseUrl;
        return string.Concat(baseUrl, path);
    }

    private static string? NormalizeOptionalBaseUrl(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        return raw.Trim().TrimEnd('/');
    }

    private static string BuildCanonicalFilterPath(string routeKey)
    {
        if (routeKey.StartsWith("category:", StringComparison.OrdinalIgnoreCase))
        {
            return string.Concat("/category/", routeKey["category:".Length..]);
        }

        if (routeKey.StartsWith("tag:", StringComparison.OrdinalIgnoreCase))
        {
            return string.Concat("/tag/", routeKey["tag:".Length..]);
        }

        return "/";
    }

    private static string NormalizeConfiguredBaseUrl(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return "https://fsus.blog";
        }

        return value.Trim().TrimEnd('/');
    }

    private static string NormalizeRequestPath(string? path)
    {
        if (string.IsNullOrWhiteSpace(path) || path == "/")
        {
            return "/";
        }

        string trimmed = path.Trim();
        return trimmed.EndsWith("/", StringComparison.Ordinal) ? trimmed.TrimEnd('/') : trimmed;
    }

    private static string ResolveDocumentTitle(PublicPageKind kind, JsonElement root, string siteTitle)
    {
        if (kind != PublicPageKind.ArticleDetail)
        {
            return GetTitle(kind, PathString.Empty, siteTitle);
        }

        if (root.TryGetProperty("article", out JsonElement article))
        {
            string articleTitle = PublicAotJsonHelpers.TryGetString(article, "title");
            if (!string.IsNullOrWhiteSpace(articleTitle))
            {
                return articleTitle;
            }
        }

        return GetTitle(kind, PathString.Empty, siteTitle);
    }

    private string BuildHydrationPropsJson(PublicPageKind kind, JsonElement root, string siteTitle, string siteDescription)
    {
        return TryGetPagePipeline(kind, out PagePipeline pipeline)
            ? pipeline.BuildHydrationProps(root, siteTitle, siteDescription)
            : string.Empty;
    }

    private static string BuildIslandsJson(PublicPageKind kind, JsonElement root)
        => PublicAotHydrationPayloadBuilder.BuildIslands(kind, root);

    private static string Encode(string? value) => WebUtility.HtmlEncode(value ?? string.Empty);
}
