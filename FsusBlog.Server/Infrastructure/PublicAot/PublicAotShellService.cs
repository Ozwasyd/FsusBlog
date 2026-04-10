using System.Net;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.RegularExpressions;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using Microsoft.AspNetCore.Http;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed class PublicAotShellService(
    IWebHostEnvironment env,
    IConfiguration configuration,
    IArticleService articleService,
    ISystemService systemService,
    IPublicAotShellCache cache,
    ILogger<PublicAotShellService> logger) : IPublicAotShellService
{
    private delegate Task BootstrapPayloadPopulator(
        HttpContext context,
        Dictionary<string, object?> payload,
        CancellationToken cancellationToken);

    private delegate string ShellHtmlBuilder(string title, string bootstrapJson);
    private delegate string HydrationPropsBuilder(JsonElement root, string siteTitle, string siteDescription);

    private const string PublicRendererVersion = "public-vue-renderer@2026-04-06-2";
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull
    };
    private static readonly Regex OrderedListRegex = new(@"^\d+\.\s+", RegexOptions.Compiled);
    private static readonly Regex HorizontalRuleRegex = new(@"^\s{0,3}([-*_])(\s*\1){2,}\s*$", RegexOptions.Compiled);
    private static readonly Regex TableSeparatorRegex = new(@"^\s*\|?(\s*:?-{3,}:?\s*\|)+\s*:?-{3,}:?\s*\|?\s*$", RegexOptions.Compiled);

    private readonly string _configuredBaseUrl = NormalizeConfiguredBaseUrl(
        configuration["Seo:BaseUrl"]
        ?? configuration["Seo__BaseUrl"]
        ?? configuration["SITE_BASEURL"]
        ?? "https://fsus.blog");
    private IReadOnlyDictionary<PublicPageKind, BootstrapPayloadPopulator>? _bootstrapPayloadPopulators;
    public const string PublicAotSourceContextKey = "__fsus_public_aot_source";
    private static readonly IReadOnlyDictionary<PublicPageKind, ShellHtmlBuilder> ShellBuilders
        = new Dictionary<PublicPageKind, ShellHtmlBuilder>
        {
            [PublicPageKind.Home] = BuildHomeShell,
            [PublicPageKind.ArticleDetail] = BuildArticleDetailShell,
            [PublicPageKind.Filter] = BuildFilterShell,
            [PublicPageKind.About] = BuildAboutShell,
            [PublicPageKind.Archive] = BuildArchiveShell
        };
    private static readonly IReadOnlyDictionary<PublicPageKind, HydrationPropsBuilder> HydrationPropsBuilders
        = new Dictionary<PublicPageKind, HydrationPropsBuilder>
        {
            [PublicPageKind.Home] = BuildHomeHydrationPropsJson,
            [PublicPageKind.ArticleDetail] = BuildArticleDetailHydrationPropsJson,
            [PublicPageKind.About] = BuildAboutHydrationPropsJson,
            [PublicPageKind.Archive] = BuildArchiveHydrationPropsJson,
            [PublicPageKind.Filter] = BuildFilterHydrationPropsJson
        };
    private static readonly IReadOnlyDictionary<PublicPageKind, PublicPageId> KindToPageIdMap
        = new Dictionary<PublicPageKind, PublicPageId>
        {
            [PublicPageKind.Home] = PublicPageId.Home,
            [PublicPageKind.ArticleDetail] = PublicPageId.ArticleDetail,
            [PublicPageKind.Filter] = PublicPageId.Filter,
            [PublicPageKind.About] = PublicPageId.About,
            [PublicPageKind.Archive] = PublicPageId.Archive
        };
    private static readonly IReadOnlyDictionary<PublicPageId, PublicPageKind> PageIdToKindMap
        = new Dictionary<PublicPageId, PublicPageKind>
        {
            [PublicPageId.Home] = PublicPageKind.Home,
            [PublicPageId.ArticleDetail] = PublicPageKind.ArticleDetail,
            [PublicPageId.Filter] = PublicPageKind.Filter,
            [PublicPageId.About] = PublicPageKind.About,
            [PublicPageId.Archive] = PublicPageKind.Archive
        };
    private static readonly IReadOnlyDictionary<PublicPageKind, string> HydrationKindMap
        = new Dictionary<PublicPageKind, string>
        {
            [PublicPageKind.Home] = "Home",
            [PublicPageKind.ArticleDetail] = "ArticleDetail",
            [PublicPageKind.Filter] = "Filter",
            [PublicPageKind.About] = "About",
            [PublicPageKind.Archive] = "Archive"
        };
    private static readonly IReadOnlyDictionary<string, PublicPageKind> StaticPathToKindMap
        = new Dictionary<string, PublicPageKind>(StringComparer.OrdinalIgnoreCase)
        {
            ["/about"] = PublicPageKind.About,
            ["/archive"] = PublicPageKind.Archive
        };
    private static readonly IReadOnlyDictionary<PublicPageKind, string> FixedKindRouteKeyMap
        = new Dictionary<PublicPageKind, string>
        {
            [PublicPageKind.Home] = "home",
            [PublicPageKind.About] = "about",
            [PublicPageKind.Archive] = "archive"
        };
    private static readonly IReadOnlyDictionary<PublicPageKind, string> KindTitleMap
        = new Dictionary<PublicPageKind, string>
        {
            [PublicPageKind.ArticleDetail] = "文章详情",
            [PublicPageKind.Filter] = "筛选",
            [PublicPageKind.About] = "关于",
            [PublicPageKind.Archive] = "归档"
        };
    private static readonly IReadOnlyDictionary<PublicPageKind, string> StoredShellPageNameMap
        = new Dictionary<PublicPageKind, string>
        {
            [PublicPageKind.Home] = "首页",
            [PublicPageKind.ArticleDetail] = "文章详情",
            [PublicPageKind.Filter] = "筛选列表",
            [PublicPageKind.About] = "关于",
            [PublicPageKind.Archive] = "归档"
        };
    private static readonly IReadOnlyDictionary<PublicPageId, string> CanonicalFixedPathByPageIdMap
        = new Dictionary<PublicPageId, string>
        {
            [PublicPageId.Home] = "/",
            [PublicPageId.About] = "/about",
            [PublicPageId.Archive] = "/archive"
        };
    private IReadOnlyDictionary<PublicPageKind, BootstrapPayloadPopulator> BootstrapPayloadPopulators
        => _bootstrapPayloadPopulators ??= new Dictionary<PublicPageKind, BootstrapPayloadPopulator>
        {
            [PublicPageKind.Home] = PopulateHomeBootstrapPayloadAsync,
            [PublicPageKind.Archive] = PopulateArchiveBootstrapPayloadAsync,
            [PublicPageKind.ArticleDetail] = PopulateArticleDetailBootstrapPayloadAsync,
            [PublicPageKind.Filter] = PopulateFilterBootstrapPayloadAsync,
            [PublicPageKind.About] = PopulateAboutBootstrapPayloadAsync
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

        return await RenderIndexAsync(context, kind, cancellationToken);
    }

    public async Task<string> RenderIndexAsync(HttpContext context, PublicPageKind kind, CancellationToken cancellationToken = default)
    {
        string routeKey = PublicAotShellKeyBuilder.BuildRouteKey(context, kind);
        PublicPageId pageId = PublicAotShellKeyBuilder.ToPageId(kind);
        string documentCacheKey = CacheKeyBuilder.PublicAotDocument(pageId, routeKey);
        (bool hit, string value) = await cache.TryGetAsync(documentCacheKey, cancellationToken);
        if (hit)
        {
            context.Items[PublicAotSourceContextKey] = "file-cache-hit";
            return value;
        }

        string generated = await BuildIndexAsync(context, kind, null, cancellationToken);
        await cache.SetAsync(documentCacheKey, generated, TimeSpan.FromDays(30), cancellationToken);
        context.Items[PublicAotSourceContextKey] = "generated-fallback";
        return generated;
    }

    public async Task<Result> StoreAsync(PublicAotShellBundleContract bundle, CancellationToken cancellationToken = default)
    {
        if (bundle.Entries is null || bundle.Entries.Count == 0)
        {
            return Result.Failure(ErrorCode.Validation, "AOT 缓存包为空");
        }

        string template = await ReadIndexTemplateAsync(cancellationToken);
        var preparedEntries = new List<(PublicPageId PageId, string RouteKey, string Html)>(bundle.Entries.Count);

        foreach (var entry in bundle.Entries)
        {
            var validation = PublicAotShellKeyBuilder.ValidateBundleEntry(entry, out string normalizedRouteKey, out string normalizedHtml);
            if (!validation.IsSuccess)
            {
                return validation;
            }

            string documentHtml = BuildStoredIndexDocument(template, entry, normalizedHtml);
            preparedEntries.Add((entry.PageId, normalizedRouteKey, documentHtml));
        }

        foreach (var entry in preparedEntries)
        {
            string cacheKey = CacheKeyBuilder.PublicAotDocument(entry.PageId, entry.RouteKey);
            await cache.RemoveAsync(cacheKey, cancellationToken);
            await cache.SetAsync(cacheKey, entry.Html, TimeSpan.FromDays(30), cancellationToken);
        }

        return Result.Success();
    }

    public Task<Result> InvalidateAllAsync(CancellationToken cancellationToken = default)
    {
        return InvalidateAllCoreAsync(cancellationToken);
    }

    private async Task<Result> InvalidateAllCoreAsync(CancellationToken cancellationToken)
    {
        await cache.InvalidateAllAsync(cancellationToken);
        return Result.Success();
    }

    private async Task<string> BuildIndexAsync(
        HttpContext context,
        PublicPageKind kind,
        string? cachedShellHtml,
        CancellationToken cancellationToken)
    {
        string rawTemplate = await ReadIndexTemplateAsync(cancellationToken);
        rawTemplate = EnsureCriticalPublicCssLink(rawTemplate);
        rawTemplate = EnsureDevCssDirectLinks(rawTemplate);
        rawTemplate = EnsureSupplementaryStylesheetLink(rawTemplate);
        string template = PreparePublicDocumentTemplate(rawTemplate);
        var seo = await systemService.GetSeoConfigAsync();
        var bootstrap = await BuildBootstrapAsync(context, kind, seo, cancellationToken);
        var title = ResolveDocumentTitle(kind, bootstrap, seo.Title);
        string description = BuildDescription(kind, bootstrap, seo.Description);
        string canonicalUrl = BuildCanonicalUrl(context, kind);
        string hydrationPropsJson = BuildHydrationPropsJson(kind, bootstrap, seo.Title, seo.Description);
        string islandsJson = BuildIslandsJson(kind, bootstrap);
        string shell = string.IsNullOrWhiteSpace(cachedShellHtml)
            ? BuildShellHtml(kind, title, bootstrap)
            : cachedShellHtml;
        shell = EnsureShellRoot(shell, kind);

        string html = template
            .Replace("<body>", "<body data-fsus-public-first-paint=\"true\" data-fsus-public-shell=\"true\">", StringComparison.Ordinal)
            .Replace(
                "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />",
                $"<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />\n    {BuildSeoHeadTags(kind, title, seo.Title, description, canonicalUrl)}",
                StringComparison.Ordinal)
            .Replace("<title>Loading...</title>", $"<title>{Encode(title)} - {Encode(seo.Title)}</title>", StringComparison.Ordinal)
            .Replace("<div id=\"app\"></div>", $"<div id=\"app\">{shell}</div>", StringComparison.Ordinal);

        const string bodyClose = "</body>";
        string bootstrapScript = $"<script id=\"fsus-aot-bootstrap\" type=\"application/json\">{EncodeJson(bootstrap)}</script>";
        string hydrationScript = string.IsNullOrWhiteSpace(hydrationPropsJson)
            ? string.Empty
            : $"<script id=\"fsus-aot-hydration-props\" type=\"application/json\">{EncodeJson(hydrationPropsJson)}</script>";
        string islandsScript = string.IsNullOrWhiteSpace(islandsJson)
            ? string.Empty
            : $"<script id=\"fsus-aot-islands\" type=\"application/json\">{EncodeJson(islandsJson)}</script>";
        string noScript = BuildNoScriptBlock(title, description);
        string deferredSpaBoot = BuildDeferredSpaBootScript(rawTemplate);
        if (html.Contains(bodyClose, StringComparison.Ordinal))
        {
            html = html.Replace(bodyClose, $"{noScript}\n    {bootstrapScript}\n    {hydrationScript}\n    {islandsScript}\n    {deferredSpaBoot}\n    {bodyClose}", StringComparison.Ordinal);
        }
        else
        {
            html += noScript + bootstrapScript + hydrationScript + islandsScript + deferredSpaBoot;
        }

        logger.LogDebug("Public AOT shell generated for {Kind} {Path}", kind, context.Request.Path.Value);
        return html;
    }

    private static string EnsureCriticalPublicCssLink(string template)
    {
        const string marker = "<link rel=\"stylesheet\" href=\"/src/assets/main.css\" />";
        const string link = "<link rel=\"stylesheet\" href=\"/src/assets/critical-public.css\" />";

        if (template.Contains(link, StringComparison.Ordinal))
        {
            return template;
        }

        return template.Contains(marker, StringComparison.Ordinal)
            ? template.Replace(marker, $"{link}\n    {marker}", StringComparison.Ordinal)
            : template;
    }

    private static string BuildShellHtml(PublicPageKind kind, string title, string bootstrapJson)
    {
        return ShellBuilders.TryGetValue(kind, out ShellHtmlBuilder? builder)
            ? builder(title, bootstrapJson)
            : string.Empty;
    }

    private async Task<string> BuildBootstrapAsync(HttpContext context, PublicPageKind kind, SeoConfigDto seo, CancellationToken cancellationToken)
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

        if (BootstrapPayloadPopulators.TryGetValue(kind, out BootstrapPayloadPopulator? populator))
        {
            await populator(context, payload, cancellationToken);
        }

        return JsonSerializer.Serialize(payload, JsonOptions);
    }

    private async Task PopulateHomeBootstrapPayloadAsync(
        HttpContext _,
        Dictionary<string, object?> payload,
        CancellationToken __)
    {
        var page = await articleService.GetPageListAsync(1, 8, null, null, false);
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
            Category = item.Category.Name,
            Tags = item.Tags.Select(t => t.Name).ToArray()
        }).ToArray();
    }

    private async Task PopulateArchiveBootstrapPayloadAsync(
        HttpContext _,
        Dictionary<string, object?> payload,
        CancellationToken cancellationToken)
    {
        List<ArticleListDto> articles = await LoadAllArchiveArticlesAsync(cancellationToken);
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
            var article = await articleService.GetByIdAsync(id);
            if (article is not null)
            {
                payload["article"] = new
                {
                    article.Id,
                    article.Title,
                    article.Summary,
                    article.Content,
                    article.Views,
                    article.CreateTime,
                    Category = article.Category?.Name,
                    Tags = article.Tags.Select(t => t.Name).ToArray()
                };
            }
        }

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
        var about = await systemService.GetPageContentAsync("about");
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

    private static PublicPageId ToPageId(PublicPageKind kind)
        => KindToPageIdMap.TryGetValue(kind, out PublicPageId pageId)
            ? pageId
            : PublicPageId.Home;

    private static PublicPageKind ToKind(PublicPageId pageId)
        => PageIdToKindMap.TryGetValue(pageId, out PublicPageKind kind)
            ? kind
            : PublicPageKind.Unknown;

    private static string BuildRouteKey(HttpContext context, PublicPageKind kind)
    {
        string path = context.Request.Path.Value?.TrimEnd('/') ?? string.Empty;
        if (FixedKindRouteKeyMap.TryGetValue(kind, out string? fixedRouteKey))
        {
            return fixedRouteKey;
        }

        return kind switch
        {
            PublicPageKind.ArticleDetail when TryResolvePathId(context, "/article/", out int id) => $"article:{id}",
            PublicPageKind.Filter => BuildFilterRouteKey(path, context),
            _ => path
        };
    }

    private static string BuildFilterRouteKey(string path, HttpContext context)
    {
        if (path.StartsWith("/category/", StringComparison.OrdinalIgnoreCase) &&
            TryResolvePathId(context, "/category/", out int categoryId))
        {
            return $"category:{categoryId}";
        }

        if (path.StartsWith("/tag/", StringComparison.OrdinalIgnoreCase) &&
            TryResolvePathId(context, "/tag/", out int tagId))
        {
            return $"tag:{tagId}";
        }

        return $"filter:{NormalizeKeyPart(path)}";
    }

    private static string NormalizeKeyPart(string value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return "empty";
        }

        return value.Trim()
            .Replace(':', '_')
            .Replace('/', '_')
            .Replace('?', '_')
            .Replace('&', '_')
            .Replace('=', '_');
    }

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

        var page = await articleService.GetPageListAsync(pageIndex, pageSize, categoryId, tagId, false);

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
                Category = item.Category.Name,
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

        if (StaticPathToKindMap.TryGetValue(value, out PublicPageKind staticKind))
        {
            return staticKind;
        }

        return PublicPageKind.Unknown;
    }

    private static string GetTitle(PublicPageKind kind, PathString path, string siteTitle)
    {
        return kind == PublicPageKind.Home
            ? siteTitle
            : (KindTitleMap.TryGetValue(kind, out string? title) ? title : siteTitle);
    }

    private async Task<string> ReadIndexTemplateAsync(CancellationToken cancellationToken)
    {
        return await PublicSpaTemplateLocator.ReadIndexTemplateAsync(env, cancellationToken);
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
        template = PreparePublicDocumentTemplate(template);
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

        string html = template
            .Replace("<body>", "<body data-fsus-public-first-paint=\"true\" data-fsus-public-shell=\"true\">", StringComparison.Ordinal)
            .Replace(
                "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />",
                $"<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />\n    {BuildSeoHeadTags(kind, title, "FsusBlog", description, canonicalUrl)}",
                StringComparison.Ordinal)
            .Replace("<title>Loading...</title>", $"<title>{Encode(title)}</title>", StringComparison.Ordinal)
            .Replace("<div id=\"app\"></div>", $"<div id=\"app\">{wrappedShell}</div>", StringComparison.Ordinal);

        const string bodyClose = "</body>";
        string bootstrapScript = $"<script id=\"fsus-aot-bootstrap\" type=\"application/json\">{EncodeJson(bootstrapJson)}</script>";
        string hydrationScript = string.IsNullOrWhiteSpace(hydrationPropsJson)
            ? string.Empty
            : $"<script id=\"fsus-aot-hydration-props\" type=\"application/json\">{EncodeJson(hydrationPropsJson)}</script>";
        string islandsScript = string.IsNullOrWhiteSpace(islandsJson)
            ? string.Empty
            : $"<script id=\"fsus-aot-islands\" type=\"application/json\">{EncodeJson(islandsJson)}</script>";
        string noScript = BuildNoScriptBlock(title, description);
        string deferredSpaBoot = BuildDeferredSpaBootScript(rawTemplate);
        return html.Contains(bodyClose, StringComparison.Ordinal)
            ? html.Replace(bodyClose, $"{noScript}\n    {bootstrapScript}\n    {hydrationScript}\n    {islandsScript}\n    {deferredSpaBoot}\n    {bodyClose}", StringComparison.Ordinal)
            : html + noScript + bootstrapScript + hydrationScript + islandsScript + deferredSpaBoot;
    }

    private static string WrapStoredShell(PublicPageKind kind, string shellHtml)
    {
        string pageName = StoredShellPageNameMap.TryGetValue(kind, out string? mappedName)
            ? mappedName
            : "公开页";

        if (shellHtml.Contains("id=\"fsus-aot-shell\"", StringComparison.Ordinal))
        {
            return EnsureHydrationKindAttribute(shellHtml, kind);
        }

        string hydrationKind = ResolveHydrationKind(kind);
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

    private static string BuildHomeShell(string title, string bootstrapJson)
    {
        using JsonDocument document = JsonDocument.Parse(bootstrapJson);
        JsonElement root = document.RootElement;
        JsonElement articles = root.TryGetProperty("articles", out JsonElement articleItems) ? articleItems : default;
        string siteTitle = TryGetString(root, "siteTitle");
        if (string.IsNullOrWhiteSpace(siteTitle))
        {
            siteTitle = "Fsus";
        }

        string siteDescription = TryGetString(root, "siteDescription");
        if (string.IsNullOrWhiteSpace(siteDescription))
        {
            siteDescription = "以极简形式呈现内容与思考。";
        }

        int currentPage = TryGetInt32(root, "pageIndex", 1);
        int pageSize = TryGetInt32(root, "pageSize", 8);
        int total = TryGetInt32(root, "total");
        int totalPages = Math.Max(1, (int)Math.Ceiling(total / (double)Math.Max(1, pageSize)));

        return $"""
<div id="fsus-aot-shell" data-public-hydration-kind="Home" class="font-sans min-h-screen flex flex-col bg-white text-zinc-950 subpixel-antialiased [text-rendering:optimizeLegibility] selection:bg-zinc-950 selection:text-white">
  <header class="w-full pt-12 pb-8 sm:pt-20 sm:pb-10">
    <div class="max-w-3xl mx-auto px-6 sm:px-8 flex flex-col sm:flex-row sm:items-baseline justify-between gap-6 sm:gap-8">
      <div class="shrink-0">
        <a href="/" class="text-2xl sm:text-3xl font-bold tracking-tight hover:opacity-60 transition-opacity outline-none focus-visible:opacity-60">{Encode(siteTitle)}<span class="text-zinc-400">.</span></a>
      </div>
      <nav class="flex flex-wrap items-center gap-6 sm:gap-8 text-sm font-medium" aria-label="主导航">
        <a href="/" class="mono-link active-link">首页</a>
        <a href="/archive" class="mono-link">归档</a>
        <a href="/about" class="mono-link">关于</a>
        <form action="/search" method="get" class="hidden sm:flex items-center group border-b border-zinc-100 focus-within:border-zinc-950 transition-colors duration-300">
          <input type="text" name="q" placeholder="搜索" class="public-shell-search bg-transparent border-none p-0 focus:ring-0 focus:outline-none text-sm w-12 focus:w-28 transition-all duration-500 placeholder:text-zinc-300 text-zinc-500 focus:text-zinc-950 pb-0.5" aria-label="搜索内容" />
        </form>
        <span class="text-zinc-300 font-light" aria-hidden="true">/</span>
        <a href="/login" class="mono-link">登录</a>
      </nav>
    </div>
  </header>
  <main class="grow max-w-3xl mx-auto w-full px-6 sm:px-8 pt-4 pb-24 sm:pb-32">
    <div class="flex flex-col lg:flex-row gap-12 lg:gap-24">
      <div class="grow lg:w-2/3">
        <header class="mb-12 sm:mb-20">
          <h1 class="text-3xl sm:text-4xl font-bold tracking-tight text-zinc-950">{Encode(siteTitle)}<span class="text-zinc-400">.</span></h1>
          <p class="mt-4 text-sm sm:text-base text-zinc-500 max-w-xl leading-relaxed">{Encode(siteDescription)}</p>
        </header>
        {BuildHomeArticleList(articles)}
        {BuildHomePagination(currentPage, totalPages)}
      </div>
      <aside class="hidden lg:block lg:w-80 shrink-0 space-y-16 pt-8 lg:pt-0">
        <section class="public-aside-placeholder rounded-3xl border border-zinc-100 bg-zinc-50/60 px-6 py-8" aria-hidden="true">
          <h2 class="text-xs font-bold tracking-[0.2em] text-zinc-400 uppercase mb-8">热门文章</h2>
          <div class="space-y-6">
            <div class="flex items-start gap-4"><div class="w-6 text-sm font-mono text-zinc-200">01</div><div class="flex-1 space-y-2 pt-0.5"><div class="h-3 rounded-sm bg-zinc-100"></div><div class="h-3 w-2/3 rounded-sm bg-zinc-100/90"></div></div></div>
            <div class="flex items-start gap-4"><div class="w-6 text-sm font-mono text-zinc-200">02</div><div class="flex-1 space-y-2 pt-0.5"><div class="h-3 rounded-sm bg-zinc-100"></div><div class="h-3 w-2/3 rounded-sm bg-zinc-100/90"></div></div></div>
            <div class="flex items-start gap-4"><div class="w-6 text-sm font-mono text-zinc-200">03</div><div class="flex-1 space-y-2 pt-0.5"><div class="h-3 rounded-sm bg-zinc-100"></div><div class="h-3 w-2/3 rounded-sm bg-zinc-100/90"></div></div></div>
            <div class="flex items-start gap-4"><div class="w-6 text-sm font-mono text-zinc-200">04</div><div class="flex-1 space-y-2 pt-0.5"><div class="h-3 rounded-sm bg-zinc-100"></div><div class="h-3 w-2/3 rounded-sm bg-zinc-100/90"></div></div></div>
            <div class="flex items-start gap-4"><div class="w-6 text-sm font-mono text-zinc-200">05</div><div class="flex-1 space-y-2 pt-0.5"><div class="h-3 rounded-sm bg-zinc-100"></div><div class="h-3 w-2/3 rounded-sm bg-zinc-100/90"></div></div></div>
          </div>
        </section>
      </aside>
    </div>
  </main>
  <footer class="w-full pb-12 pt-8 sm:pb-16 border-t border-zinc-100">
    <div class="max-w-3xl mx-auto px-6 sm:px-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-6">
      <div class="text-sm text-zinc-500 font-medium tracking-normal select-none">&copy; {DateTime.UtcNow.Year} {Encode(siteTitle)}. All rights reserved.</div>
      <div class="flex items-center gap-6 sm:gap-8 text-sm font-medium text-zinc-500">
        <a href="/api/Article/rss" class="hover:text-zinc-950 transition-colors">RSS</a>
        <a href="#top" class="hover:text-zinc-950 transition-colors flex items-center gap-2 group">
          <span>回到顶部</span>
          <span class="group-hover:-translate-y-0.5 transition-transform" aria-hidden="true">↑</span>
        </a>
      </div>
    </div>
  </footer>
</div>
""";
    }

    private static string BuildArticleDetailShell(string title, string bootstrapJson)
    {
        using JsonDocument document = JsonDocument.Parse(bootstrapJson);
        JsonElement root = document.RootElement;
        if (!root.TryGetProperty("article", out JsonElement article) || article.ValueKind != JsonValueKind.Object)
        {
            return BuildShell(
                title,
                "文章详情",
                "<p class=\"text-sm text-zinc-500 mt-3\">正文与评论占位已直出，评论会在 SPA 接管后插入。</p>",
                bootstrapJson,
                "评论将在 SPA 接管后加载");
        }

        string content = TryGetString(article, "content");
        string renderedBody = RenderArticleDetailMarkdownHtml(content);
        string commentsPlaceholder = TryGetString(root, "commentsPlaceholder");
        int articleId = TryGetInt32(root, "articleId", TryGetInt32(article, "id"));
        string siteTitle = TryGetString(root, "siteTitle");
        if (string.IsNullOrWhiteSpace(siteTitle))
        {
            siteTitle = "Fsus";
        }
        string isoTime = TryGetString(article, "createTime");
        string fullTime = FormatFullPublicTime(isoTime);
        string displayTime = FormatPublicTime(isoTime);

        return $"""
<div id="fsus-aot-shell" data-public-hydration-kind="ArticleDetail" class="font-sans min-h-screen flex flex-col bg-white text-zinc-950 subpixel-antialiased [text-rendering:optimizeLegibility] selection:bg-zinc-950 selection:text-white">
  <header class="w-full pt-12 pb-8 sm:pt-20 sm:pb-10">
    <div class="max-w-3xl mx-auto px-6 sm:px-8 flex flex-col sm:flex-row sm:items-baseline justify-between gap-6 sm:gap-8">
      <div class="shrink-0">
        <a href="/" class="text-2xl sm:text-3xl font-bold tracking-tight hover:opacity-60 transition-opacity outline-none focus-visible:opacity-60">{Encode(siteTitle)}<span class="text-zinc-400">.</span></a>
      </div>
      <nav class="flex flex-wrap items-center gap-6 sm:gap-8 text-sm font-medium" aria-label="主导航">
        <a href="/" class="mono-link">首页</a>
        <a href="/archive" class="mono-link">归档</a>
        <a href="/about" class="mono-link">关于</a>
        <form action="/search" method="get" class="hidden sm:flex items-center group border-b border-zinc-100 focus-within:border-zinc-950 transition-colors duration-300">
          <input type="text" name="q" placeholder="搜索" class="public-shell-search bg-transparent border-none p-0 focus:ring-0 focus:outline-none text-sm w-12 focus:w-28 transition-all duration-500 placeholder:text-zinc-300 text-zinc-500 focus:text-zinc-950 pb-0.5" aria-label="搜索内容" />
        </form>
        <span class="text-zinc-300 font-light" aria-hidden="true">/</span>
        <a href="/login" class="mono-link">登录</a>
      </nav>
    </div>
  </header>
  <main class="grow max-w-3xl mx-auto w-full px-6 sm:px-8 pt-4 pb-24 sm:pb-32">
    <div class="max-w-3xl mx-auto min-h-screen">
      <article style="overflow-anchor: none;">
        <header class="mb-10 sm:mb-16 pb-8 sm:pb-12 border-b border-zinc-100">
          <h1 class="text-2xl sm:text-4xl font-bold text-zinc-950 leading-tight sm:leading-snug mb-5 sm:mb-6 tracking-tight">{Encode(TryGetString(article, "title"))}</h1>
          <div class="flex flex-wrap items-center gap-3 text-[10px] sm:text-xs font-mono font-medium tracking-wider text-zinc-400 uppercase">
            <time datetime="{Encode(isoTime)}" title="{Encode(fullTime)}">{Encode(displayTime)}</time>
            <span class="text-zinc-300 font-light" aria-hidden="true">/</span>
            <span class="text-zinc-500">{Encode(TryGetNestedString(article, "category"))}</span>
            <span class="text-zinc-300 font-light" aria-hidden="true">/</span>
            <span>{Encode($"{TryGetInt32(article, "views")} 浏览")}</span>
          </div>
        </header>
        {BuildHydrationMarkdownShellHost(renderedBody)}
        {BuildTagFooter(article)}
        <section id="fsus-comments-island" class="mt-16 sm:mt-24 pt-12 border-t border-zinc-950/5 pb-24" data-article-id="{Encode(articleId.ToString())}">
          <h3 class="text-[10px] sm:text-xs font-bold tracking-[0.2em] text-zinc-400 uppercase mb-8">评论</h3>
          <div class="min-h-[11rem] rounded-3xl border border-dashed border-zinc-100 bg-zinc-50/60 px-6 py-8 sm:px-8 sm:py-10">
            <p class="text-sm sm:text-base font-bold text-zinc-950">评论流正在接管中</p>
            <p class="mt-2 text-sm sm:text-base text-zinc-500 leading-relaxed">{Encode(string.IsNullOrWhiteSpace(commentsPlaceholder) ? "AOT 会先直出正文与评论占位，Vue SPA 接管后会自动插入真实评论流。" : commentsPlaceholder)}</p>
            <div class="mt-4 inline-flex items-center gap-2 text-zinc-400" aria-hidden="true">
              <span class="h-1.5 w-1.5 rounded-full bg-zinc-300 animate-pulse"></span>
              <span class="h-1.5 w-1.5 rounded-full bg-zinc-300 animate-pulse [animation-delay:120ms]"></span>
              <span class="h-1.5 w-1.5 rounded-full bg-zinc-300 animate-pulse [animation-delay:240ms]"></span>
            </div>
            <p class="mt-4 text-[10px] sm:text-xs font-mono uppercase tracking-[0.2em] text-zinc-400">这里预留真实评论列表容器，避免首屏与接管后的布局跳变。</p>
          </div>
        </section>
      </article>
    </div>
  </main>
  <footer class="w-full pb-12 pt-8 sm:pb-16 border-t border-zinc-100">
    <div class="max-w-3xl mx-auto px-6 sm:px-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-6">
      <div class="text-sm text-zinc-500 font-medium tracking-normal select-none">&copy; {DateTime.UtcNow.Year} {Encode(siteTitle)}. All rights reserved.</div>
      <div class="flex items-center gap-6 sm:gap-8 text-sm font-medium text-zinc-500">
        <a href="/api/Article/rss" class="hover:text-zinc-950 transition-colors">RSS</a>
        <a href="#top" class="hover:text-zinc-950 transition-colors flex items-center gap-2 group">
          <span>回到顶部</span>
          <span class="group-hover:-translate-y-0.5 transition-transform" aria-hidden="true">↑</span>
        </a>
      </div>
    </div>
  </footer>
</div>
""";
    }

    private static string BuildMarkdownShellHost(string rawContent)
    {
        return $"""
<div class="markdown-body markdown-renderer__body prose prose-zinc max-w-none subpixel-antialiased whitespace-pre-wrap" role="article" aria-live="polite" data-markdown-renderer="wasm">{Encode(rawContent)}</div>
""";
    }

    private static string BuildHydrationMarkdownShellHost(string renderedHtml)
    {
        return $"""
<div class="markdown-body prose prose-zinc max-w-none subpixel-antialiased whitespace-pre-wrap"><div class="markdown-renderer__root markdown-renderer__body" role="article" aria-live="polite" data-markdown-renderer="wasm">{renderedHtml}</div></div>
""";
    }

    private static string BuildFilterShell(string title, string bootstrapJson)
    {
        using JsonDocument document = JsonDocument.Parse(bootstrapJson);
        JsonElement root = document.RootElement;
        JsonElement filter = root.TryGetProperty("filter", out JsonElement filterPayload) ? filterPayload : default;
        JsonElement articles = filter.TryGetProperty("articles", out JsonElement articleItems) ? articleItems : default;
        int currentPage = TryGetInt32(filter, "pageIndex", 1);
        int pageSize = TryGetInt32(filter, "pageSize", 10);
        int total = TryGetInt32(filter, "total");
        int totalPages = Math.Max(1, (int)Math.Ceiling(total / (double)Math.Max(1, pageSize)));
        string routeKey = TryGetString(root, "routeKey");
        string label = ResolveFilterLabel(routeKey);
        string currentName = ResolveFilterCurrentName(routeKey, title);
        string listHtml = BuildArticleCards(articles);
        string body = string.IsNullOrWhiteSpace(listHtml)
            ? """
<div class="py-32 text-center">
  <p class="text-[11px] font-mono text-zinc-300 uppercase tracking-widest">无相关内容</p>
</div>
"""
            : $"""
<div class="flex flex-col gap-12 sm:gap-20">
  {listHtml}
</div>
""";

        return $"""
<div id="fsus-aot-shell" data-aot-page="Filter" data-public-hydration-kind="Filter" class="max-w-3xl mx-auto w-full px-6 sm:px-8 min-h-screen">
  <div class="flex flex-col lg:flex-row gap-12 lg:gap-24 subpixel-antialiased">
    <div class="grow lg:w-2/3">
      <header class="mb-12 sm:mb-20 select-none">
        <p class="text-[10px] font-bold tracking-[0.3em] text-zinc-400 uppercase mb-4">{Encode(label)}</p>
        <h1 class="text-3xl sm:text-4xl font-bold tracking-tight text-zinc-950">{Encode(currentName)}</h1>
      </header>
      {body}
      {BuildFilterPagination(currentPage, totalPages)}
    </div>
    <aside class="hidden lg:block lg:w-64 shrink-0">
      <div class="sticky top-32">
        <a href="/" class="text-[10px] font-bold tracking-[0.2em] uppercase text-zinc-400 hover:text-zinc-950 transition-colors flex items-center gap-3 group">
          <span class="group-hover:-translate-x-1 transition-transform duration-300">←</span> 回到主页
        </a>
      </div>
    </aside>
  </div>
</div>
""";
    }

    private static string BuildAboutShell(string title, string bootstrapJson)
    {
        using JsonDocument document = JsonDocument.Parse(bootstrapJson);
        JsonElement root = document.RootElement;
        JsonElement about = root.TryGetProperty("about", out JsonElement aboutPayload) ? aboutPayload : default;
        string content = TryGetString(about, "content");
        string siteTitle = TryGetString(root, "siteTitle");
        if (string.IsNullOrWhiteSpace(siteTitle))
        {
            siteTitle = "Fsus";
        }

        return $"""
<div id="fsus-aot-shell" data-aot-page="About" data-public-hydration-kind="About" class="font-sans min-h-screen flex flex-col bg-white text-zinc-950 subpixel-antialiased [text-rendering:optimizeLegibility] selection:bg-zinc-950 selection:text-white">
  <header class="w-full pt-12 pb-8 sm:pt-20 sm:pb-10">
    <div class="max-w-3xl mx-auto px-6 sm:px-8 flex flex-col sm:flex-row sm:items-baseline justify-between gap-6 sm:gap-8">
      <div class="shrink-0">
        <a href="/" class="text-2xl sm:text-3xl font-bold tracking-tight hover:opacity-60 transition-opacity outline-none focus-visible:opacity-60">{Encode(siteTitle)}<span class="text-zinc-400">.</span></a>
      </div>
      <nav class="flex flex-wrap items-center gap-6 sm:gap-8 text-sm font-medium" aria-label="主导航">
        <a href="/" class="mono-link">首页</a>
        <a href="/archive" class="mono-link">归档</a>
        <a href="/about" class="mono-link active-link">关于</a>
        <form action="/search" method="get" class="hidden sm:flex items-center group border-b border-zinc-100 focus-within:border-zinc-950 transition-colors duration-300">
          <input type="text" name="q" placeholder="搜索" class="public-shell-search bg-transparent border-none p-0 focus:ring-0 focus:outline-none text-sm w-12 focus:w-28 transition-all duration-500 placeholder:text-zinc-300 text-zinc-500 focus:text-zinc-950 pb-0.5" aria-label="搜索内容" />
        </form>
        <span class="text-zinc-300 font-light" aria-hidden="true">/</span>
        <a href="/login" class="mono-link">登录</a>
      </nav>
    </div>
  </header>
  <main class="grow max-w-3xl mx-auto w-full px-6 sm:px-8 pt-4 pb-24 sm:pb-32">
    <article class="min-h-[60vh]">
      <header class="mb-12 sm:mb-16 pb-8 sm:pb-12 border-b border-zinc-100">
        <h1 class="text-3xl sm:text-5xl font-bold text-zinc-950 leading-tight sm:leading-snug mb-6 tracking-tighter">{Encode(title)}</h1>
        <div class="flex flex-wrap items-center gap-3 text-[11px] sm:text-xs font-mono font-medium tracking-wider text-zinc-400 uppercase">
          <time>{DateTime.UtcNow.Year}</time>
          <span class="text-zinc-300 font-light" aria-hidden="true">/</span>
          <span class="text-zinc-600 font-medium tracking-[0.05em]">MANIFESTO</span>
          <span class="text-zinc-300 font-light" aria-hidden="true">/</span>
          <span>README.MD</span>
        </div>
      </header>
      {BuildMarkdownShellHost(content)}
    </article>
  </main>
  <footer class="w-full pb-12 pt-8 sm:pb-16 border-t border-zinc-100">
    <div class="max-w-3xl mx-auto px-6 sm:px-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-6">
      <div class="text-sm text-zinc-500 font-medium tracking-normal select-none">&copy; {DateTime.UtcNow.Year} {Encode(siteTitle)}. All rights reserved.</div>
      <div class="flex items-center gap-6 sm:gap-8 text-sm font-medium text-zinc-500">
        <a href="/api/Article/rss" class="hover:text-zinc-950 transition-colors">RSS</a>
        <a href="#top" class="hover:text-zinc-950 transition-colors flex items-center gap-2 group">
          <span>回到顶部</span>
          <span class="group-hover:-translate-y-0.5 transition-transform" aria-hidden="true">↑</span>
        </a>
      </div>
    </div>
  </footer>
</div>
""";
    }

    private static string ResolveFilterLabel(string routeKey)
    {
        if (routeKey.StartsWith("category:", StringComparison.OrdinalIgnoreCase))
        {
            return "分类";
        }

        if (routeKey.StartsWith("tag:", StringComparison.OrdinalIgnoreCase))
        {
            return "标签";
        }

        return "筛选";
    }

    private static string ResolveFilterCurrentName(string routeKey, string fallbackTitle)
    {
        if (routeKey.StartsWith("category:", StringComparison.OrdinalIgnoreCase))
        {
            string id = routeKey["category:".Length..].Trim();
            return string.IsNullOrWhiteSpace(id) ? "分类" : $"分类 #{id}";
        }

        if (routeKey.StartsWith("tag:", StringComparison.OrdinalIgnoreCase))
        {
            string id = routeKey["tag:".Length..].Trim();
            return string.IsNullOrWhiteSpace(id) ? "标签" : $"标签 #{id}";
        }

        return string.IsNullOrWhiteSpace(fallbackTitle) ? "筛选" : fallbackTitle;
    }

    private static string BuildFilterPagination(int currentPage, int totalPages)
    {
        if (totalPages <= 1)
        {
            return string.Empty;
        }

        bool canGoPrev = currentPage > 1;
        bool canGoNext = currentPage < totalPages;
        string indicator = $"{currentPage:00} / {totalPages:00}";
        const string buttonClass = "text-[10px] font-bold tracking-[0.2em] uppercase transition-all duration-300 text-zinc-400 hover:text-zinc-950 py-4 outline-none focus-visible:ring-1 focus-visible:ring-zinc-950";

        return $"""
<nav class="mt-24 pt-12 border-t border-zinc-100 flex justify-between items-center select-none" aria-label="文章分页">
  <button class="{buttonClass}{(canGoPrev ? string.Empty : " opacity-10 cursor-not-allowed")}" data-aot-action="page-prev"{(canGoPrev ? string.Empty : " disabled")} aria-disabled="{(!canGoPrev).ToString().ToLowerInvariant()}">← <span class="hidden xs:inline ml-2">上一页</span></button>
  <span class="text-[10px] font-mono font-bold text-zinc-400 tracking-widest tabular-nums">{Encode(indicator)}</span>
  <button class="{buttonClass}{(canGoNext ? string.Empty : " opacity-10 cursor-not-allowed")}" data-aot-action="page-next"{(canGoNext ? string.Empty : " disabled")} aria-disabled="{(!canGoNext).ToString().ToLowerInvariant()}"><span class="hidden xs:inline mr-2">下一页</span> →</button>
</nav>
""";
    }

    private static string BuildArchiveShell(string title, string bootstrapJson)
    {
        using JsonDocument document = JsonDocument.Parse(bootstrapJson);
        JsonElement root = document.RootElement;
        JsonElement articles = root.TryGetProperty("articles", out JsonElement archiveArticles) ? archiveArticles : default;
        return BuildArchiveTimelineShell(title, articles, TryGetInt32(root, "total"));
    }

    private static string BuildArchiveTimelineShell(string title, JsonElement articles, int total)
    {
        string timeline = BuildArchiveTimeline(articles);
        string body = string.IsNullOrWhiteSpace(timeline)
            ? """
<div class="ui-empty py-20 text-center">
  <p class="ui-empty-title text-sm font-medium tracking-widest uppercase text-zinc-400">暂无文章归档</p>
</div>
"""
            : $"""
<div class="relative pb-24">
  <div class="absolute left-4.5 top-3 bottom-0 w-px bg-zinc-200 z-0"></div>
  <div class="space-y-20">{timeline}</div>
</div>
""";

        return $"""
<div id="fsus-aot-shell" data-aot-page="Archive" data-public-hydration-kind="Archive" class="font-sans min-h-screen flex flex-col bg-white text-zinc-950 subpixel-antialiased [text-rendering:optimizeLegibility] selection:bg-zinc-950 selection:text-white">
  <header class="w-full pt-12 pb-8 sm:pt-20 sm:pb-10">
    <div class="max-w-3xl mx-auto px-6 sm:px-8 flex flex-col sm:flex-row sm:items-baseline justify-between gap-6 sm:gap-8">
      <div class="shrink-0">
        <a href="/" class="text-2xl sm:text-3xl font-bold tracking-tight hover:opacity-60 transition-opacity outline-none focus-visible:opacity-60">Fsus<span class="text-zinc-400">.</span></a>
      </div>
      <nav class="flex flex-wrap items-center gap-6 sm:gap-8 text-sm font-medium" aria-label="主导航">
        <a href="/" class="mono-link">首页</a>
        <a href="/archive" class="mono-link active-link">归档</a>
        <a href="/about" class="mono-link">关于</a>
        <form action="/search" method="get" class="hidden sm:flex items-center group border-b border-zinc-100 focus-within:border-zinc-950 transition-colors duration-300">
          <input type="text" name="q" placeholder="搜索" class="public-shell-search bg-transparent border-none p-0 focus:ring-0 focus:outline-none text-sm w-12 focus:w-28 transition-all duration-500 placeholder:text-zinc-300 text-zinc-500 focus:text-zinc-950 pb-0.5" aria-label="搜索内容" />
        </form>
        <span class="text-zinc-300 font-light" aria-hidden="true">/</span>
        <a href="/login" class="mono-link">登录</a>
      </nav>
    </div>
  </header>
  <main class="grow max-w-3xl mx-auto w-full px-6 sm:px-8 pt-4 pb-24 sm:pb-32">
    <header class="mb-12 sm:mb-16 pb-8 sm:pb-12 border-b border-zinc-100">
      <h1 class="text-3xl sm:text-5xl font-bold text-zinc-950 leading-tight sm:leading-snug mb-6">{Encode(title)}</h1>
      <div class="flex items-center gap-3 text-[11px] sm:text-xs font-mono font-medium tracking-wider text-zinc-400 uppercase">
        <span>目前发布</span>
        <span class="text-zinc-300 font-light" aria-hidden="true">/</span>
        <span class="text-zinc-950 font-bold tabular-nums">{Encode(total.ToString())}</span>
      </div>
    </header>
    {body}
  </main>
  <footer class="w-full pb-12 pt-8 sm:pb-16 border-t border-zinc-100">
    <div class="max-w-3xl mx-auto px-6 sm:px-8 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-6">
      <div class="text-sm text-zinc-500 font-medium tracking-normal select-none">&copy; {DateTime.UtcNow.Year} Fsus. All rights reserved.</div>
      <div class="flex items-center gap-6 sm:gap-8 text-sm font-medium text-zinc-500">
        <a href="/api/Article/rss" class="hover:text-zinc-950 transition-colors">RSS</a>
        <a href="#top" class="hover:text-zinc-950 transition-colors flex items-center gap-2 group">
          <span>回到顶部</span>
          <span class="group-hover:-translate-y-0.5 transition-transform" aria-hidden="true">↑</span>
        </a>
      </div>
    </div>
  </footer>
</div>
""";
    }

    private static string BuildArchiveTimeline(JsonElement articles)
    {
        if (articles.ValueKind != JsonValueKind.Array)
        {
            return string.Empty;
        }

        var articleItems = new List<(string Year, string Month, string Day, string Title, string RouteId, string FullTime, long Timestamp)>();
        foreach (JsonElement article in articles.EnumerateArray())
        {
            string createTime = TryGetString(article, "createTime");
            if (!DateTimeOffset.TryParse(createTime, out DateTimeOffset parsed))
            {
                continue;
            }

            articleItems.Add((
                parsed.Year.ToString(),
                parsed.Month.ToString("00"),
                parsed.Day.ToString("00"),
                TryGetString(article, "title"),
                TryGetString(article, "id"),
                TimeZoneInfo.ConvertTime(parsed, TimeZoneInfo.Local).ToString("yyyy-MM-dd HH:mm:ss"),
                parsed.ToUnixTimeMilliseconds()));
        }

        if (articleItems.Count == 0)
        {
            return string.Empty;
        }

        var builder = new StringBuilder();
        var yearGroups = articleItems
            .OrderByDescending(item => item.Timestamp)
            .GroupBy(item => item.Year);

        int yearIndex = 0;
        foreach (var yearGroup in yearGroups)
        {
            builder.Append($"""
<section class="relative animate-in slide-in-from-bottom-4 fade-in duration-700" style="--stagger:{yearIndex}">
  <div class="sticky top-20 z-10 bg-white py-3 mb-10 flex items-center">
    <div class="absolute left-0 w-9 h-9 bg-white flex items-center justify-center">
      <div class="w-2.5 h-2.5 rounded-full bg-zinc-950 ring-4 ring-white"></div>
    </div>
    <h2 class="text-3xl sm:text-4xl font-bold text-zinc-950 pl-12 font-mono tracking-tighter">{Encode(yearGroup.Key)}</h2>
  </div>
  <div class="space-y-14 pl-12">
""");

            foreach (var monthGroup in yearGroup.GroupBy(item => item.Month))
            {
                builder.Append($"""
    <div class="relative">
      <h3 class="text-xs font-black tracking-[0.3em] text-zinc-400 uppercase mb-6 flex items-center gap-4">{Encode(monthGroup.Key)}<span class="h-px grow bg-zinc-100/80" aria-hidden="true"></span></h3>
      <div class="space-y-6">
""");

                foreach (var item in monthGroup)
                {
                    string href = string.IsNullOrWhiteSpace(item.RouteId) ? "/article" : $"/article/{item.RouteId}";
                    builder.Append($"""
        <article class="relative group">
          <a href="{Encode(href)}" data-aot-action="open-article" data-aot-id="{Encode(item.RouteId)}" class="flex flex-col sm:flex-row sm:items-baseline gap-1 sm:gap-6 group py-1 sm:py-0 outline-none">
            <time datetime="{Encode(item.FullTime)}" title="{Encode(item.FullTime)}" class="flex-none text-xs sm:text-sm font-mono text-zinc-400 group-hover:text-zinc-950 transition-colors w-12 tabular-nums">{Encode(item.Day)}</time>
            <span class="text-base sm:text-lg font-medium text-zinc-600 group-hover:text-zinc-950 transition-colors leading-snug border-b border-transparent group-hover:border-zinc-950 pb-0.5">{Encode(item.Title)}</span>
          </a>
        </article>
""");
                }

                builder.Append("""
      </div>
    </div>
""");
            }

            builder.Append("""
  </div>
</section>
""");
            yearIndex++;
        }

        return builder.ToString();
    }

    private static string BuildArticleListShell(
        string title,
        string pageKind,
        JsonElement articles,
        int total,
        int pageSize,
        int currentPage,
        string? hydrationKind = null)
    {
        string listHtml = BuildArticleCards(articles);
        bool hasItems = !string.IsNullOrWhiteSpace(listHtml);
        bool hasPrev = currentPage > 1;
        bool hasNext = total > currentPage * pageSize;
        int totalPages = Math.Max(1, (int)Math.Ceiling(total / (double)Math.Max(1, pageSize)));

        return $"""
<div id="fsus-aot-shell" data-aot-page="{Encode(pageKind)}"{(string.IsNullOrWhiteSpace(hydrationKind) ? string.Empty : $" data-public-hydration-kind=\"{Encode(hydrationKind)}\"")} class="fsus-aot-shell">
  <section class="max-w-3xl mx-auto px-6 sm:px-8 py-10 sm:py-16 min-h-[60vh]">
    <p class="text-[10px] sm:text-xs font-bold tracking-[0.3em] text-zinc-400 uppercase mb-4">{Encode(pageKind)}</p>
    <h1 class="text-3xl sm:text-5xl font-bold tracking-tighter text-zinc-950">{Encode(title)}</h1>
    <p class="text-sm text-zinc-500 mt-3">AOT 直出首屏内容，SPA 稍后接管交互。</p>
    <div class="mt-10 {Encode("flex flex-col gap-12 sm:gap-20")}">
      {(hasItems ? listHtml : "<div class=\"ui-empty py-20 text-center\"><p class=\"ui-empty-title text-sm font-medium tracking-widest uppercase text-zinc-400\">暂无内容</p></div>")}
      <nav class="ui-pagination mt-20 pt-8 border-t border-zinc-100 flex justify-between items-center" aria-label="文章分页">
        <button class="text-xs font-bold tracking-[0.2em] uppercase transition-colors text-zinc-400 hover:text-zinc-950 p-4 outline-none focus-visible:ring-2 focus-visible:ring-zinc-950{(hasPrev ? string.Empty : " opacity-30 cursor-not-allowed")}" data-aot-action="page-prev"{(hasPrev ? string.Empty : " disabled")}>上一页</button>
        <span class="text-xs font-mono font-medium text-zinc-300 tabular-nums">{Encode($"{currentPage:00} / {totalPages:00}")}</span>
        <button class="text-xs font-bold tracking-[0.2em] uppercase transition-colors text-zinc-400 hover:text-zinc-950 p-4 outline-none focus-visible:ring-2 focus-visible:ring-zinc-950{(hasNext ? string.Empty : " opacity-30 cursor-not-allowed")}" data-aot-action="page-next"{(hasNext ? string.Empty : " disabled")}>下一页</button>
      </nav>
    </div>
  </section>
</div>
""";
    }

    private static string BuildArticleCards(JsonElement articles)
    {
        if (articles.ValueKind != JsonValueKind.Array)
        {
            return string.Empty;
        }

        var builder = new StringBuilder();
        foreach (JsonElement article in articles.EnumerateArray())
        {
            string articleId = TryGetString(article, "id");
            string href = string.IsNullOrWhiteSpace(articleId) ? "/article" : $"/article/{articleId}";
            string summary = TryGetString(article, "summary");
            if (string.IsNullOrWhiteSpace(summary))
            {
                summary = TryGetString(article, "snippet");
            }

            builder.Append($"""
<article class="ui-article-card group flex flex-col items-start gap-3 sm:gap-4 subpixel-antialiased animate-fade-in">
  <div class="ui-article-meta flex flex-wrap items-center gap-3 text-[11px] sm:text-xs font-mono font-medium tracking-wider text-zinc-400 uppercase">
    <time class="tabular-nums">{Encode(FormatPublicTime(TryGetString(article, "createTime")))}</time>
    <span class="ui-article-meta-separator text-zinc-300 font-light" aria-hidden="true">/</span>
    <span class="ui-article-category text-zinc-600">{Encode(TryGetNestedString(article, "category"))}</span>{BuildTagSpans(article)}
  </div>
  <h2 class="ui-article-title text-xl sm:text-2xl font-bold text-zinc-950 group-hover:text-zinc-500 transition-colors duration-300 leading-snug">
    <a class="block" href="{Encode(href)}" data-aot-action="open-article" data-aot-id="{Encode(articleId)}">{Encode(TryGetString(article, "title"))}</a>
  </h2>
  <p class="ui-article-summary text-sm sm:text-base text-zinc-600 leading-relaxed sm:leading-loose line-clamp-3">{Encode(summary)}</p>
  <a class="ui-article-link mt-2 text-[11px] sm:text-xs font-bold tracking-[0.2em] uppercase text-zinc-950 hover:text-zinc-500 transition-colors flex items-center gap-2 py-2 -ml-0.5" href="{Encode(href)}" data-aot-action="open-article" data-aot-id="{Encode(articleId)}">阅读<span aria-hidden="true">→</span></a>
</article>
""");
        }

        return builder.ToString();
    }

    private static string BuildTagSpans(JsonElement article)
    {
        if (!article.TryGetProperty("tags", out JsonElement tags) || tags.ValueKind != JsonValueKind.Array)
        {
            return string.Empty;
        }

        var builder = new StringBuilder();
        bool hasAny = false;
        foreach (JsonElement tag in tags.EnumerateArray())
        {
            string name = tag.ValueKind == JsonValueKind.String ? tag.GetString() ?? string.Empty : TryGetString(tag, "name");
            if (string.IsNullOrWhiteSpace(name))
            {
                continue;
            }

            if (!hasAny)
            {
                builder.Append("<span class=\"ui-article-meta-separator text-zinc-300 font-light hidden sm:inline\" aria-hidden=\"true\">/</span>");
            }

            hasAny = true;
            builder.Append($"""<span class="ui-tag ui-tag--ghost hidden sm:inline text-[11px] sm:text-xs font-mono font-medium tracking-wider text-zinc-400 uppercase">{Encode($"#{name}")}</span>""");
        }

        return builder.ToString();
    }

    private static string BuildTagFooter(JsonElement article)
    {
        if (!article.TryGetProperty("tags", out JsonElement tags) || tags.ValueKind != JsonValueKind.Array)
        {
            return string.Empty;
        }

        var items = new StringBuilder();
        foreach (JsonElement tag in tags.EnumerateArray())
        {
            string tagName = tag.ValueKind == JsonValueKind.String ? tag.GetString() ?? string.Empty : TryGetString(tag, "name");
            if (string.IsNullOrWhiteSpace(tagName))
            {
                continue;
            }

            items.Append($"""<a href="/tag/{Encode(tagName)}" class="text-[11px] sm:text-sm font-medium text-zinc-400 hover:text-zinc-950 transition-colors px-0 py-1.5 sm:p-0" data-public-link="filter">#{Encode(tagName)}</a>""");
        }

        if (items.Length == 0)
        {
            return string.Empty;
        }

        return $"""
<footer class="mt-12 sm:mt-24 pt-8 sm:pt-10 border-t border-zinc-100">
  <div class="flex flex-wrap gap-3 sm:gap-4">
    {items}
  </div>
</footer>
""";
    }

    private static string BuildHomeArticleList(JsonElement articles)
    {
        if (articles.ValueKind != JsonValueKind.Array)
        {
            return """<div class="flex flex-col gap-12 sm:gap-20"></div>""";
        }

        var cards = new StringBuilder();
        int index = 0;
        foreach (JsonElement article in articles.EnumerateArray())
        {
            string articleId = TryGetString(article, "id");
            string href = string.IsNullOrWhiteSpace(articleId) ? "/article" : $"/article/{articleId}";
            string summary = TryGetString(article, "snippet");
            if (string.IsNullOrWhiteSpace(summary))
            {
                summary = TryGetString(article, "summary");
            }

            cards.Append($"""
<article class="ui-article-card group flex flex-col items-start gap-3 sm:gap-4 subpixel-antialiased" style="--index:{index};">
  <div class="ui-article-meta min-h-5 flex flex-wrap items-center gap-3 text-[11px] sm:text-xs font-mono font-medium tracking-wider text-zinc-400 uppercase">
    <time datetime="{Encode(TryGetString(article, "createTime"))}" title="{Encode(FormatFullPublicTime(TryGetString(article, "createTime")))}" class="tabular-nums">{Encode(FormatPublicTime(TryGetString(article, "createTime")))}</time>
    <span class="ui-article-meta-separator text-zinc-300 font-light" aria-hidden="true">/</span>
    <span class="ui-article-category text-zinc-600">{Encode(TryGetNestedString(article, "category"))}</span>{BuildTagSpans(article)}
  </div>
  <h2 class="ui-article-title min-h-[3.5rem] sm:min-h-[4.25rem] text-xl sm:text-2xl font-bold text-zinc-950 group-hover:text-zinc-500 transition-colors duration-300 leading-snug">
    <a href="{Encode(href)}" class="block" data-public-link="article">{Encode(TryGetString(article, "title"))}</a>
  </h2>
  <p class="ui-article-summary min-h-[4.5rem] sm:min-h-[5.75rem] text-sm sm:text-base text-zinc-600 leading-relaxed sm:leading-loose line-clamp-3">{Encode(summary)}</p>
  <a href="{Encode(href)}" class="ui-article-link mt-2 text-[11px] sm:text-xs font-bold tracking-[0.2em] uppercase text-zinc-950 hover:text-zinc-500 transition-colors flex items-center gap-2 py-2 -ml-0.5" aria-label="阅读全文" data-public-link="article">阅读<span aria-hidden="true">→</span></a>
</article>
""");
            index++;
        }

        return $"""<div class="flex flex-col gap-12 sm:gap-20">{cards}</div>""";
    }

    private static string BuildHomePagination(int currentPage, int totalPages)
    {
        if (totalPages <= 1)
        {
            return string.Empty;
        }

        bool previousDisabled = currentPage <= 1;
        bool nextDisabled = currentPage >= totalPages;
        const string buttonBase = "text-xs font-bold tracking-[0.2em] uppercase transition-colors text-zinc-400 hover:text-zinc-950 p-4 outline-none focus-visible:ring-2 focus-visible:ring-zinc-950";
        const string disabledClass = " opacity-30 cursor-not-allowed";

        return $"""
<nav class="ui-pagination mt-20 pt-8 border-t border-zinc-100 flex justify-between items-center" aria-label="文章分页">
  <button class="{buttonBase} -ml-4{(previousDisabled ? disabledClass : string.Empty)}" {(previousDisabled ? "disabled" : string.Empty)} data-aot-action="page-prev">上一页</button>
  <span class="text-xs font-mono font-medium text-zinc-300 tabular-nums">{Encode($"{currentPage} / {totalPages}")}</span>
  <button class="{buttonBase} -mr-4{(nextDisabled ? disabledClass : string.Empty)}" {(nextDisabled ? "disabled" : string.Empty)} data-aot-action="page-next">下一页</button>
</nav>
""";
    }

    private static string BuildShell(string title, string eyebrow, string leadHtml, string bootstrapJson, string footerText)
    {
        return $"""
<div id="fsus-aot-shell" data-aot-page="{Encode(eyebrow)}" class="fsus-aot-shell">
  <section class="max-w-3xl mx-auto px-6 sm:px-8 py-10 sm:py-16 min-h-[60vh] flex flex-col justify-center">
    <p class="text-[10px] sm:text-xs font-bold tracking-[0.3em] text-zinc-400 uppercase mb-4">{Encode(eyebrow)}</p>
    <h1 class="text-3xl sm:text-5xl font-bold tracking-tighter text-zinc-950">{Encode(title)}</h1>
    {leadHtml}
    <div class="mt-10 rounded-2xl border border-zinc-100 bg-white/80 p-5 sm:p-6">
      <p class="text-xs font-mono text-zinc-400 uppercase tracking-[0.2em] mb-4">AOT Bootstrap</p>
      <p class="text-sm text-zinc-500">{Encode(footerText)}</p>
    </div>
  </section>
</div>
""";
    }

    private static string BuildDescription(PublicPageKind kind, string bootstrapJson, string fallback)
    {
        try
        {
            using JsonDocument document = JsonDocument.Parse(bootstrapJson);
            JsonElement root = document.RootElement;
            return kind switch
            {
                PublicPageKind.ArticleDetail when root.TryGetProperty("article", out JsonElement article) =>
                    BuildArticleDescription(article, fallback),
                PublicPageKind.About when root.TryGetProperty("about", out JsonElement about) =>
                    SummarizeForMeta(TryGetString(about, "content"), fallback),
                _ => fallback
            };
        }
        catch
        {
            return fallback;
        }
    }

    private static string BuildArticleDescription(JsonElement article, string fallback)
    {
        string summary = TryGetString(article, "summary");
        if (!string.IsNullOrWhiteSpace(summary))
        {
            return SummarizeForMeta(summary, fallback);
        }

        string content = TryGetString(article, "content");
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

    private static string BuildNoScriptBlock(string title, string description) =>
        $"""
<noscript>
  <section class="max-w-3xl mx-auto px-6 sm:px-8 py-8 text-zinc-700">
    <h1 class="text-xl font-bold text-zinc-950">{Encode(title)}</h1>
    <p class="mt-3 text-sm leading-7">{Encode(description)}</p>
  </section>
</noscript>
""";

    private static string PreparePublicDocumentTemplate(string template)
    {
        string result = StripImmediateSpaEntryScript(template);
        result = StripModulePreloadLinks(result);
        return result;
    }

    private string EnsureDevCssDirectLinks(string template)
    {
        if (!env.IsDevelopment())
        {
            return template;
        }

        const string linkPattern = "<link\\b[^>]*\\brel\\s*=\\s*([\"'])stylesheet\\1[^>]*>";
        string rewritten = Regex.Replace(
            template,
            linkPattern,
            static match =>
            {
                string linkTag = match.Value;
                string href = ExtractAttributeValue(linkTag, "href");
                if (string.IsNullOrWhiteSpace(href))
                {
                    return linkTag;
                }

                string normalizedHref = href;
                if (IsSrcAssetCssHref(href))
                {
                    normalizedHref = EnsureDirectQueryFlag(href);
                }
                else if (IsBuiltAssetCssHref(href))
                {
                    // In debug/dev mode we prefer Vite direct CSS to avoid stale hashed asset links.
                    normalizedHref = "/src/assets/main.css?direct";
                }

                return TryReplaceAttributeValue(linkTag, "href", normalizedHref, out string replacedTag)
                    ? replacedTag
                    : linkTag;
            },
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

        const string criticalHref = "/src/assets/critical-public.css";
        if (!rewritten.Contains($"href=\"{criticalHref}\"", StringComparison.Ordinal))
        {
            const string headClose = "</head>";
            string criticalTag = $"""<link rel="stylesheet" href="{criticalHref}" data-fsus-style="public-critical-dev" />""";
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
        if (env.IsDevelopment())
        {
            return "/src/assets/main.css?direct";
        }

        string webRoot = string.IsNullOrWhiteSpace(env.WebRootPath)
            ? Path.Combine(env.ContentRootPath, "wwwroot")
            : env.WebRootPath;
        string assetsRoot = Path.Combine(webRoot, "assets");
        if (!Directory.Exists(assetsRoot))
        {
            return null;
        }

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
            ?? PickByPrefix(files, "vendor-element-plus-")
            ?? PickByPrefix(files, "vendor-progress-");
        return string.IsNullOrWhiteSpace(match) ? null : $"/assets/{match}";
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

    private static string StripImmediateSpaEntryScript(string template)
    {
        int scriptIndex = template.IndexOf("<script", StringComparison.OrdinalIgnoreCase);
        while (scriptIndex >= 0)
        {
            int scriptEnd = template.IndexOf("</script>", scriptIndex, StringComparison.OrdinalIgnoreCase);
            if (scriptEnd < 0)
            {
                break;
            }

            int closeEnd = scriptEnd + "</script>".Length;
            string scriptTag = template[scriptIndex..closeEnd];
            bool isModuleScript = scriptTag.Contains("type=\"module\"", StringComparison.OrdinalIgnoreCase);
            bool pointsToSpaEntry = scriptTag.Contains("src=\"/assets/", StringComparison.OrdinalIgnoreCase)
                || scriptTag.Contains("src='/assets/", StringComparison.OrdinalIgnoreCase)
                || scriptTag.Contains("src=\"assets/", StringComparison.OrdinalIgnoreCase)
                || scriptTag.Contains("src='assets/", StringComparison.OrdinalIgnoreCase)
                || scriptTag.Contains("src=\"/src/", StringComparison.OrdinalIgnoreCase)
                || scriptTag.Contains("src='/src/", StringComparison.OrdinalIgnoreCase)
                || scriptTag.Contains("src=\"src/", StringComparison.OrdinalIgnoreCase)
                || scriptTag.Contains("src='src/", StringComparison.OrdinalIgnoreCase);

            if (isModuleScript && pointsToSpaEntry)
            {
                return template.Remove(scriptIndex, closeEnd - scriptIndex);
            }

            scriptIndex = template.IndexOf("<script", closeEnd, StringComparison.OrdinalIgnoreCase);
        }

        return template;
    }

    private static string StripModulePreloadLinks(string template)
    {
        const string marker = "<link";
        int linkIndex = template.IndexOf(marker, StringComparison.OrdinalIgnoreCase);
        while (linkIndex >= 0)
        {
            int linkEnd = template.IndexOf('>', linkIndex);
            if (linkEnd < 0)
            {
                break;
            }

            string linkTag = template.Substring(linkIndex, linkEnd - linkIndex + 1);
            bool isModulePreload = linkTag.Contains("rel=\"modulepreload\"", StringComparison.OrdinalIgnoreCase)
                || linkTag.Contains("rel='modulepreload'", StringComparison.OrdinalIgnoreCase);
            if (isModulePreload)
            {
                template = template.Remove(linkIndex, linkEnd - linkIndex + 1);
                linkIndex = template.IndexOf(marker, linkIndex, StringComparison.OrdinalIgnoreCase);
                continue;
            }

            linkIndex = template.IndexOf(marker, linkEnd + 1, StringComparison.OrdinalIgnoreCase);
        }

        return template;
    }

    private static string BuildDeferredSpaBootScript(string template)
    {
        string entryScriptSrc = TryExtractSpaEntryScriptSrc(template);
        if (string.IsNullOrWhiteSpace(entryScriptSrc))
        {
            return string.Empty;
        }

        string encodedSrc = JavaScriptEncoder.Default.Encode(entryScriptSrc);
        return $@"<script id=""fsus-spa-boot"" data-fsus-spa-entry=""{Encode(entryScriptSrc)}"">
  (() => {{
    const entrySrc = ""{encodedSrc}"";
    const mark = (name) => {{
      try {{
        if (window.performance && typeof window.performance.mark === 'function') {{
          window.performance.mark('fsus:start:' + name);
        }}
      }} catch {{
      }}
    }};

    let preloadWarmed = false;
    let injectScheduled = false;
    let forcedInjectTimer = 0;

    const warmPreload = () => {{
      if (preloadWarmed) {{
        return;
      }}
      preloadWarmed = true;

      if (!document.querySelector('link[rel=""modulepreload""][href=""' + entrySrc + '""]')) {{
        const preload = document.createElement('link');
        preload.rel = 'modulepreload';
        preload.crossOrigin = 'anonymous';
        preload.href = entrySrc;
        preload.fetchPriority = 'low';
        preload.dataset.fsusSpaPreload = 'deferred';
        (document.head || document.body).appendChild(preload);
      }}
      mark('server-spa-preload');
    }};

    const loadSpaEntry = () => {{
      injectScheduled = false;
      if (document.querySelector('script[data-fsus-spa-entry][src=""' + entrySrc + '""]') ||
          document.querySelector('script[type=""module""][src=""' + entrySrc + '""]')) {{
        return;
      }}

      mark('server-spa-entry-injected');
      const script = document.createElement('script');
      script.type = 'module';
      script.crossOrigin = 'anonymous';
      script.src = entrySrc;
      script.dataset.fsusSpaEntry = 'deferred';
      document.body.appendChild(script);
    }};

    const scheduleInject = () => {{
      if (injectScheduled) {{
        return;
      }}
      injectScheduled = true;

      if ('requestIdleCallback' in window) {{
        window.requestIdleCallback((deadline) => {{
          if (!deadline.didTimeout && deadline.timeRemaining() < 8) {{
            window.setTimeout(loadSpaEntry, 96);
            return;
          }}
          loadSpaEntry();
        }}, {{ timeout: 1200 }});
        return;
      }}

      window.setTimeout(loadSpaEntry, 96);
    }};

    const scheduleForcedInject = () => {{
      if (forcedInjectTimer) {{
        return;
      }}

      forcedInjectTimer = window.setTimeout(() => {{
        warmPreload();
        loadSpaEntry();
      }}, 1800);
    }};

    const onIntent = () => {{
      warmPreload();
      scheduleInject();
    }};

    window.addEventListener('pointerdown', onIntent, {{ once: true, passive: true }});
    window.addEventListener('touchstart', onIntent, {{ once: true, passive: true }});
    window.addEventListener('keydown', onIntent, {{ once: true }});
    window.addEventListener('scroll', onIntent, {{ once: true, passive: true }});

    const kickoff = () => {{
      window.requestAnimationFrame(() => {{
        warmPreload();
        scheduleInject();
        scheduleForcedInject();
      }});
    }};

    if (document.readyState === 'interactive' || document.readyState === 'complete') {{
      kickoff();
      return;
    }}

    document.addEventListener('DOMContentLoaded', kickoff, {{ once: true }});
  }})();
</script>";
    }

    private static string TryExtractSpaEntryScriptSrc(string template)
    {
        int scriptIndex = template.IndexOf("<script", StringComparison.OrdinalIgnoreCase);
        while (scriptIndex >= 0)
        {
            int scriptEnd = template.IndexOf("</script>", scriptIndex, StringComparison.OrdinalIgnoreCase);
            if (scriptEnd < 0)
            {
                break;
            }

            int closeEnd = scriptEnd + "</script>".Length;
            string scriptTag = template[scriptIndex..closeEnd];
            if (scriptTag.Contains("type=\"module\"", StringComparison.OrdinalIgnoreCase))
            {
                string src = ExtractAttributeValue(scriptTag, "src");
                if (!string.IsNullOrWhiteSpace(src) &&
                    (src.StartsWith("/assets/", StringComparison.OrdinalIgnoreCase)
                     || src.StartsWith("assets/", StringComparison.OrdinalIgnoreCase)
                     || src.StartsWith("/src/", StringComparison.OrdinalIgnoreCase)
                     || src.StartsWith("src/", StringComparison.OrdinalIgnoreCase)))
                {
                    return src;
                }
            }

            scriptIndex = template.IndexOf("<script", closeEnd, StringComparison.OrdinalIgnoreCase);
        }

        return string.Empty;
    }

    private static string ExtractAttributeValue(string tag, string attributeName)
    {
        string doubleQuotedToken = $"{attributeName}=\"";
        int attrIndex = tag.IndexOf(doubleQuotedToken, StringComparison.OrdinalIgnoreCase);
        if (attrIndex >= 0)
        {
            int start = attrIndex + doubleQuotedToken.Length;
            int end = tag.IndexOf('"', start);
            return end > start ? tag[start..end] : string.Empty;
        }

        string singleQuotedToken = $"{attributeName}='";
        attrIndex = tag.IndexOf(singleQuotedToken, StringComparison.OrdinalIgnoreCase);
        if (attrIndex < 0)
        {
            return string.Empty;
        }

        int valueStart = attrIndex + singleQuotedToken.Length;
        int valueEnd = tag.IndexOf('\'', valueStart);
        return valueEnd > valueStart ? tag[valueStart..valueEnd] : string.Empty;
    }

    private async Task<List<ArticleListDto>> LoadAllArchiveArticlesAsync(CancellationToken cancellationToken)
    {
        const int pageSize = 100;
        var results = new List<ArticleListDto>(pageSize);
        int pageIndex = 1;

        while (!cancellationToken.IsCancellationRequested)
        {
            PageResultDto<ArticleListDto> page = await articleService.GetPageListAsync(pageIndex, pageSize, null, null, false);
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

    private static string BuildSeoHeadTags(
        PublicPageKind kind,
        string title,
        string siteTitle,
        string description,
        string canonicalUrl)
    {
        string ogType = kind == PublicPageKind.ArticleDetail ? "article" : "website";
        string fullTitle = string.IsNullOrWhiteSpace(siteTitle) ? title : $"{title} - {siteTitle}";

        return $"""
<meta name="description" content="{Encode(description)}" />
<meta property="og:title" content="{Encode(fullTitle)}" />
<meta property="og:description" content="{Encode(description)}" />
<meta property="og:type" content="{Encode(ogType)}" />
<meta property="og:url" content="{Encode(canonicalUrl)}" />
<link rel="canonical" href="{Encode(canonicalUrl)}" />
""";
    }

    private static string EnsureShellRoot(string html, PublicPageKind kind)
    {
        if (html.Contains("id=\"fsus-aot-shell\"", StringComparison.Ordinal))
        {
            return EnsureHydrationKindAttribute(html, kind);
        }

        string hydrationKind = ResolveHydrationKind(kind);

        string hydrationAttribute = string.IsNullOrWhiteSpace(hydrationKind)
            ? string.Empty
            : $" data-public-hydration-kind=\"{Encode(hydrationKind)}\"";

        return $"""
<div id="fsus-aot-shell" data-aot-page="{Encode(kind.ToString())}"{hydrationAttribute} class="fsus-aot-shell">
{html}
</div>
""";
    }

    private static string ResolveHydrationKind(PublicPageKind kind)
        => HydrationKindMap.TryGetValue(kind, out string? hydrationKind)
            ? hydrationKind
            : string.Empty;

    private static string EnsureHydrationKindAttribute(string html, PublicPageKind kind)
    {
        string hydrationKind = ResolveHydrationKind(kind);
        if (string.IsNullOrWhiteSpace(hydrationKind) ||
            html.Contains("data-public-hydration-kind=", StringComparison.OrdinalIgnoreCase))
        {
            return html;
        }

        const string marker = "id=\"fsus-aot-shell\"";
        int markerIndex = html.IndexOf(marker, StringComparison.Ordinal);
        if (markerIndex < 0)
        {
            return html;
        }

        int insertIndex = markerIndex + marker.Length;
        return html.Insert(insertIndex, $" data-public-hydration-kind=\"{Encode(hydrationKind)}\"");
    }

    private static string FormatPublicTime(string raw)
    {
        if (DateTimeOffset.TryParse(raw, out DateTimeOffset timestamp))
        {
            return timestamp.ToLocalTime().ToString("yyyy-MM-dd");
        }

        return raw;
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
        if (CanonicalFixedPathByPageIdMap.TryGetValue(entry.PageId, out string? fixedPath))
        {
            path = fixedPath;
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

    private static string TryGetString(JsonElement element, string propertyName)
    {
        if (element.ValueKind == JsonValueKind.Object && element.TryGetProperty(propertyName, out JsonElement value))
        {
            return value.ValueKind switch
            {
                JsonValueKind.String => value.GetString() ?? string.Empty,
                JsonValueKind.Number => value.ToString(),
                _ => string.Empty
            };
        }

        return string.Empty;
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

    private static string ResolveDocumentTitle(PublicPageKind kind, string bootstrapJson, string siteTitle)
    {
        if (kind != PublicPageKind.ArticleDetail)
        {
            return GetTitle(kind, PathString.Empty, siteTitle);
        }

        try
        {
            using JsonDocument document = JsonDocument.Parse(bootstrapJson);
            JsonElement root = document.RootElement;
            if (root.TryGetProperty("article", out JsonElement article))
            {
                string articleTitle = TryGetString(article, "title");
                if (!string.IsNullOrWhiteSpace(articleTitle))
                {
                    return articleTitle;
                }
            }
        }
        catch
        {
        }

        return GetTitle(kind, PathString.Empty, siteTitle);
    }

    private static string BuildHydrationPropsJson(PublicPageKind kind, string bootstrapJson, string siteTitle, string siteDescription)
    {
        using JsonDocument document = JsonDocument.Parse(bootstrapJson);
        JsonElement root = document.RootElement;

        return HydrationPropsBuilders.TryGetValue(kind, out HydrationPropsBuilder? builder)
            ? builder(root, siteTitle, siteDescription)
            : string.Empty;
    }

    private static string BuildIslandsJson(PublicPageKind kind, string bootstrapJson)
    {
        if (kind != PublicPageKind.ArticleDetail)
        {
            return string.Empty;
        }

        using JsonDocument document = JsonDocument.Parse(bootstrapJson);
        JsonElement root = document.RootElement;
        int articleId = TryGetInt32(root, "articleId", TryGetInt32(root.TryGetProperty("article", out JsonElement article) ? article : default, "id"));
        if (articleId <= 0)
        {
            return string.Empty;
        }

        return JsonSerializer.Serialize(new
        {
            comments = new
            {
                articleId
            }
        }, JsonOptions);
    }

    private static string BuildHomeHydrationPropsJson(JsonElement root, string siteTitle, string siteDescription)
    {
        int currentPage = TryGetInt32(root, "pageIndex", 1);
        int pageSize = TryGetInt32(root, "pageSize", 8);
        int total = TryGetInt32(root, "total");
        int totalPages = Math.Max(1, (int)Math.Ceiling(total / (double)Math.Max(1, pageSize)));
        JsonElement articles = root.TryGetProperty("articles", out JsonElement items) ? items : default;

        var viewItems = articles.ValueKind == JsonValueKind.Array
            ? articles.EnumerateArray().Select((article, index) => new
            {
                card = new
                {
                    kind = "article-list-card",
                    index
                },
                id = TryGetInt32(article, "id"),
                href = $"/article/{TryGetInt32(article, "id")}",
                title = TryGetString(article, "title"),
                summary = string.IsNullOrWhiteSpace(TryGetString(article, "snippet")) ? TryGetString(article, "summary") : TryGetString(article, "snippet"),
                meta = new
                {
                    isoTime = TryGetString(article, "createTime"),
                    displayTime = FormatPublicTime(TryGetString(article, "createTime")),
                    fullTime = FormatFullPublicTime(TryGetString(article, "createTime")),
                    categoryName = TryGetNestedString(article, "category")
                },
                tags = BuildHydrationTagItems(article)
            }).ToArray()
            : [];

        var payload = new
        {
            pageKind = "Home",
            routeKey = "home",
            rendererVersion = PublicRendererVersion,
            title = siteTitle,
            siteTitle,
            siteDescription,
            baseUrl = (string?)null,
            currentPage,
            pageSize,
            total,
            view = new
            {
                items = viewItems,
                pagination = new
                {
                    previous = new
                    {
                        label = "上一页",
                        variant = "quiet",
                        disabled = currentPage <= 1,
                        action = new { action = "page-prev" }
                    },
                    next = new
                    {
                        label = "下一页",
                        variant = "quiet",
                        disabled = currentPage >= totalPages,
                        action = new { action = "page-next" }
                    },
                    indicator = $"{currentPage} / {totalPages}"
                },
                showPagination = totalPages > 1,
                emptyState = new
                {
                    title = "没有找到文章。"
                },
                searchKeyword = string.Empty
            }
        };

        return JsonSerializer.Serialize(payload, JsonOptions);
    }

    private static string BuildArticleDetailHydrationPropsJson(JsonElement root, string siteTitle, string siteDescription)
    {
        if (!root.TryGetProperty("article", out JsonElement article) || article.ValueKind != JsonValueKind.Object)
        {
            return string.Empty;
        }

        int articleId = TryGetInt32(root, "articleId", TryGetInt32(article, "id"));
        string routeKey = articleId > 0 ? $"article:{articleId}" : "article:0";
        string content = TryGetString(article, "content");
        string commentsPlaceholder = TryGetString(root, "commentsPlaceholder");
        string renderedBody = RenderArticleDetailMarkdownHtml(content);

        var payload = new
        {
            pageKind = "ArticleDetail",
            routeKey,
            articleId,
            rendererVersion = PublicRendererVersion,
            title = TryGetString(article, "title"),
            siteTitle,
            siteDescription,
            baseUrl = (string?)null,
            detailView = new
            {
                header = new
                {
                    id = articleId,
                    title = TryGetString(article, "title"),
                    viewsText = $"{TryGetInt32(article, "views")} 浏览",
                    meta = new
                    {
                        isoTime = TryGetString(article, "createTime"),
                        displayTime = FormatPublicTime(TryGetString(article, "createTime")),
                        fullTime = FormatFullPublicTime(TryGetString(article, "createTime")),
                        categoryName = TryGetNestedString(article, "category")
                    },
                    tags = BuildHydrationTagItems(article)
                },
                body = new
                {
                    content = renderedBody
                },
                comments = new
                {
                    title = "评论",
                    headingText = "评论",
                    loadingText = "加载中",
                    endText = "暂无评论。",
                    placeholderTitle = "评论流正在接管中",
                    placeholderBody = string.IsNullOrWhiteSpace(commentsPlaceholder) ? "AOT 会先直出正文与评论占位，Vue SPA 接管后会自动插入真实评论流。" : commentsPlaceholder,
                    placeholderHint = "这里预留真实评论列表容器，避免首屏与接管后的布局跳变。"
                },
                errorState = new
                {
                    title = "数据加载异常，请稍后重试。",
                    retryText = "重载页面"
                },
                notFoundState = new
                {
                    title = "文章未找到。",
                    actionText = "回到主页",
                    actionHref = "/"
                }
            },
            commentsIsland = new
            {
                articleId,
                placeholderTitle = "评论流正在接管中",
                placeholderBody = string.IsNullOrWhiteSpace(commentsPlaceholder) ? "AOT 会先直出正文与评论占位，Vue SPA 接管后会自动插入真实评论流。" : commentsPlaceholder,
                placeholderHint = "这里预留真实评论列表容器，避免首屏与接管后的布局跳变。"
            }
        };

        return JsonSerializer.Serialize(payload, JsonOptions);
    }

    private static string BuildAboutHydrationPropsJson(JsonElement root, string siteTitle, string siteDescription)
    {
        JsonElement about = root.TryGetProperty("about", out JsonElement aboutPayload) ? aboutPayload : default;
        string routeKey = TryGetString(root, "routeKey");
        if (string.IsNullOrWhiteSpace(routeKey))
        {
            routeKey = "about";
        }

        var payload = new
        {
            pageKind = "About",
            routeKey,
            rendererVersion = PublicRendererVersion,
            title = "关于",
            siteTitle,
            siteDescription,
            baseUrl = (string?)null,
            about = new
            {
                slug = TryGetString(about, "slug"),
                content = TryGetString(about, "content")
            }
        };

        return JsonSerializer.Serialize(payload, JsonOptions);
    }

    private static string BuildArchiveHydrationPropsJson(JsonElement root, string siteTitle, string siteDescription)
    {
        string routeKey = TryGetString(root, "routeKey");
        if (string.IsNullOrWhiteSpace(routeKey))
        {
            routeKey = "archive";
        }

        JsonElement articles = root.TryGetProperty("articles", out JsonElement archiveItems) ? archiveItems : default;
        int total = TryGetInt32(root, "total");
        var payload = new
        {
            pageKind = "Archive",
            routeKey,
            rendererVersion = PublicRendererVersion,
            title = "归档",
            siteTitle,
            siteDescription,
            baseUrl = (string?)null,
            total,
            articles = articles.ValueKind == JsonValueKind.Array
                ? articles.EnumerateArray().Select(article => new
                {
                    id = TryGetInt32(article, "id"),
                    title = TryGetString(article, "title"),
                    createTime = TryGetString(article, "createTime")
                }).ToArray()
                : []
        };

        return JsonSerializer.Serialize(payload, JsonOptions);
    }

    private static string BuildFilterHydrationPropsJson(JsonElement root, string siteTitle, string siteDescription)
    {
        string routeKey = TryGetString(root, "routeKey");
        if (string.IsNullOrWhiteSpace(routeKey))
        {
            routeKey = "filter:unknown";
        }

        JsonElement filter = root.TryGetProperty("filter", out JsonElement filterPayload) ? filterPayload : default;
        JsonElement articles = filter.TryGetProperty("articles", out JsonElement filterArticles) ? filterArticles : default;

        var payload = new
        {
            pageKind = "Filter",
            routeKey,
            rendererVersion = PublicRendererVersion,
            title = "筛选",
            siteTitle,
            siteDescription,
            baseUrl = (string?)null,
            filter = new
            {
                pageIndex = TryGetInt32(filter, "pageIndex", 1),
                pageSize = TryGetInt32(filter, "pageSize", 10),
                total = TryGetInt32(filter, "total"),
                articles = articles.ValueKind == JsonValueKind.Array
                    ? articles.EnumerateArray().Select(article => new
                    {
                        id = TryGetInt32(article, "id"),
                        title = TryGetString(article, "title"),
                        summary = string.IsNullOrWhiteSpace(TryGetString(article, "summary")) ? TryGetString(article, "snippet") : TryGetString(article, "summary"),
                        createTime = TryGetString(article, "createTime")
                    }).ToArray()
                    : []
            }
        };

        return JsonSerializer.Serialize(payload, JsonOptions);
    }

    private static object[] BuildHydrationTagItems(JsonElement article)
    {
        if (!article.TryGetProperty("tags", out JsonElement tags) || tags.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        return tags.EnumerateArray()
            .Select(tag => tag.ValueKind == JsonValueKind.String ? tag.GetString() ?? string.Empty : TryGetString(tag, "name"))
            .Where(name => !string.IsNullOrWhiteSpace(name))
            .Take(5)
            .Select(name => (object)new
            {
                label = $"#{name}"
            })
            .ToArray();
    }

    private static string RenderArticleDetailMarkdownHtml(string raw)
    {
        string source = NormalizeMarkdownSource(raw);
        if (string.IsNullOrWhiteSpace(source))
        {
            return string.Empty;
        }

        string[] lines = source.Split('\n');
        var html = new StringBuilder(source.Length + 256);
        int index = 0;

        while (index < lines.Length)
        {
            string line = lines[index];
            string trimmed = line.Trim();
            if (string.IsNullOrWhiteSpace(trimmed))
            {
                index++;
                continue;
            }

            if (TryParseFenceStart(trimmed, out string fence, out string language))
            {
                index++;
                var codeLines = new List<string>();
                while (index < lines.Length && !lines[index].TrimStart().StartsWith(fence, StringComparison.Ordinal))
                {
                    codeLines.Add(lines[index]);
                    index++;
                }
                if (index < lines.Length)
                {
                    index++;
                }

                string code = string.Join('\n', codeLines);
                if (string.Equals(language, "mermaid", StringComparison.OrdinalIgnoreCase))
                {
                    html.Append("<figure class=\"markdown-renderer__mermaid\" data-mermaid-placeholder=\"true\"><figcaption class=\"markdown-renderer__placeholder-title\">Mermaid 图表将在交互层激活</figcaption><pre class=\"shiki\"><code class=\"language-mermaid\">")
                        .Append(Encode(code))
                        .Append("</code></pre></figure>");
                }
                else
                {
                    html.Append("<pre class=\"shiki\"><code");
                    if (!string.IsNullOrWhiteSpace(language))
                    {
                        html.Append(" class=\"language-").Append(Encode(language)).Append('"');
                    }
                    html.Append('>').Append(Encode(code)).Append("</code></pre>");
                }
                continue;
            }

            if (trimmed.Equals(":::mermaid", StringComparison.OrdinalIgnoreCase))
            {
                index++;
                var mermaidLines = new List<string>();
                while (index < lines.Length && !lines[index].Trim().Equals(":::", StringComparison.Ordinal))
                {
                    mermaidLines.Add(lines[index]);
                    index++;
                }
                if (index < lines.Length)
                {
                    index++;
                }

                string graph = string.Join('\n', mermaidLines);
                html.Append("<figure class=\"markdown-renderer__mermaid\" data-mermaid-placeholder=\"true\"><figcaption class=\"markdown-renderer__placeholder-title\">Mermaid 图表将在交互层激活</figcaption><pre class=\"shiki\"><code class=\"language-mermaid\">")
                    .Append(Encode(graph))
                    .Append("</code></pre></figure>");
                continue;
            }

            if (trimmed == "$$")
            {
                index++;
                var latexLines = new List<string>();
                while (index < lines.Length && lines[index].Trim() != "$$")
                {
                    latexLines.Add(lines[index]);
                    index++;
                }
                if (index < lines.Length)
                {
                    index++;
                }

                string math = string.Join('\n', latexLines);
                html.Append("<div class=\"markdown-renderer__latex\" data-latex-placeholder=\"true\"><p class=\"markdown-renderer__placeholder-title\">LaTeX 公式将在交互层激活</p><pre class=\"shiki\"><code class=\"language-latex\">")
                    .Append(Encode(math))
                    .Append("</code></pre></div>");
                continue;
            }

            int headingLevel = CountHeadingLevel(trimmed);
            if (headingLevel > 0)
            {
                string headingText = trimmed[(headingLevel + 1)..].Trim();
                html.Append("<h").Append(headingLevel).Append('>').Append(RenderInlineMarkdown(headingText)).Append("</h").Append(headingLevel).Append('>');
                index++;
                continue;
            }

            if (HorizontalRuleRegex.IsMatch(trimmed))
            {
                html.Append("<hr />");
                index++;
                continue;
            }

            if (trimmed.StartsWith('>'))
            {
                html.Append("<blockquote>");
                while (index < lines.Length)
                {
                    string quoteLine = lines[index].TrimStart();
                    if (!quoteLine.StartsWith('>'))
                    {
                        break;
                    }

                    string quote = quoteLine[1..].TrimStart();
                    if (!string.IsNullOrWhiteSpace(quote))
                    {
                        html.Append("<p>").Append(RenderInlineMarkdown(quote)).Append("</p>");
                    }
                    index++;
                }
                html.Append("</blockquote>");
                continue;
            }

            if (IsListItem(trimmed, out bool ordered, out string item))
            {
                html.Append(ordered ? "<ol>" : "<ul>");
                html.Append("<li><p>").Append(RenderInlineMarkdown(item)).Append("</p></li>");
                index++;

                while (index < lines.Length && IsListItem(lines[index].Trim(), out bool nextOrdered, out string nextItem) && nextOrdered == ordered)
                {
                    html.Append("<li><p>").Append(RenderInlineMarkdown(nextItem)).Append("</p></li>");
                    index++;
                }

                html.Append(ordered ? "</ol>" : "</ul>");
                continue;
            }

            if (LooksLikeTableHeader(trimmed, index, lines))
            {
                string[] headers = SplitTableCells(trimmed);
                string[] alignments = SplitTableCells(lines[index + 1].Trim());
                index += 2;

                html.Append("<table><thead><tr>");
                for (int i = 0; i < headers.Length; i++)
                {
                    string align = i < alignments.Length ? ResolveTableAlign(alignments[i]) : string.Empty;
                    html.Append("<th");
                    if (!string.IsNullOrEmpty(align))
                    {
                        html.Append(" style=\"text-align: ").Append(align).Append('"');
                    }
                    html.Append('>').Append(RenderInlineMarkdown(headers[i])).Append("</th>");
                }
                html.Append("</tr></thead><tbody>");

                while (index < lines.Length && lines[index].Contains('|', StringComparison.Ordinal))
                {
                    string rowLine = lines[index].Trim();
                    if (string.IsNullOrWhiteSpace(rowLine))
                    {
                        break;
                    }

                    string[] cells = SplitTableCells(rowLine);
                    html.Append("<tr>");
                    for (int i = 0; i < headers.Length; i++)
                    {
                        string cell = i < cells.Length ? cells[i] : string.Empty;
                        string align = i < alignments.Length ? ResolveTableAlign(alignments[i]) : string.Empty;
                        html.Append("<td");
                        if (!string.IsNullOrEmpty(align))
                        {
                            html.Append(" style=\"text-align: ").Append(align).Append('"');
                        }
                        html.Append('>').Append(RenderInlineMarkdown(cell)).Append("</td>");
                    }
                    html.Append("</tr>");
                    index++;
                }
                html.Append("</tbody></table>");
                continue;
            }

            var paragraph = new List<string>();
            while (index < lines.Length && !string.IsNullOrWhiteSpace(lines[index].Trim()) && !IsMarkdownBlockStart(lines, index))
            {
                paragraph.Add(lines[index].Trim());
                index++;
            }

            if (paragraph.Count > 0)
            {
                html.Append("<p>").Append(RenderInlineMarkdown(string.Join(' ', paragraph))).Append("</p>");
            }
            else
            {
                index++;
            }
        }

        return html.ToString();
    }

    private static string NormalizeMarkdownSource(string input)
        => (input ?? string.Empty).Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n');

    private static bool TryParseFenceStart(string trimmed, out string fence, out string language)
    {
        fence = string.Empty;
        language = string.Empty;

        if (!(trimmed.StartsWith("```", StringComparison.Ordinal) || trimmed.StartsWith("~~~", StringComparison.Ordinal)))
        {
            return false;
        }

        fence = trimmed[..3];
        language = trimmed.Length > 3 ? trimmed[3..].Trim() : string.Empty;
        return true;
    }

    private static int CountHeadingLevel(string trimmed)
    {
        if (trimmed.Length < 2 || trimmed[0] != '#')
        {
            return 0;
        }

        int level = 0;
        while (level < trimmed.Length && trimmed[level] == '#')
        {
            level++;
        }

        return level is >= 1 and <= 6 && level < trimmed.Length && trimmed[level] == ' ' ? level : 0;
    }

    private static bool IsListItem(string trimmed, out bool ordered, out string content)
    {
        ordered = false;
        content = string.Empty;
        if (string.IsNullOrWhiteSpace(trimmed))
        {
            return false;
        }

        if (trimmed.StartsWith("- ", StringComparison.Ordinal) || trimmed.StartsWith("* ", StringComparison.Ordinal) || trimmed.StartsWith("+ ", StringComparison.Ordinal))
        {
            content = trimmed[2..].Trim();
            return true;
        }

        if (!OrderedListRegex.IsMatch(trimmed))
        {
            return false;
        }

        int dot = trimmed.IndexOf('.', StringComparison.Ordinal);
        if (dot < 0)
        {
            return false;
        }

        ordered = true;
        content = trimmed[(dot + 1)..].Trim();
        return true;
    }

    private static bool LooksLikeTableHeader(string trimmed, int index, string[] lines)
        => index + 1 < lines.Length
           && trimmed.Contains('|', StringComparison.Ordinal)
           && TableSeparatorRegex.IsMatch(lines[index + 1].Trim());

    private static string[] SplitTableCells(string row)
    {
        string normalized = row.Trim();
        if (normalized.StartsWith('|'))
        {
            normalized = normalized[1..];
        }

        if (normalized.EndsWith('|'))
        {
            normalized = normalized[..^1];
        }

        string[] cells = normalized.Split('|');
        for (int i = 0; i < cells.Length; i++)
        {
            cells[i] = cells[i].Trim();
        }
        return cells;
    }

    private static string ResolveTableAlign(string marker)
    {
        string value = marker.Trim();
        bool left = value.StartsWith(':');
        bool right = value.EndsWith(':');
        if (left && right)
        {
            return "center";
        }

        if (right)
        {
            return "right";
        }

        return left ? "left" : string.Empty;
    }

    private static bool IsMarkdownBlockStart(string[] lines, int index)
    {
        if (index < 0 || index >= lines.Length)
        {
            return false;
        }

        string trimmed = lines[index].Trim();
        return TryParseFenceStart(trimmed, out _, out _)
               || trimmed.Equals(":::mermaid", StringComparison.OrdinalIgnoreCase)
               || trimmed == "$$"
               || CountHeadingLevel(trimmed) > 0
               || HorizontalRuleRegex.IsMatch(trimmed)
               || trimmed.StartsWith('>')
               || IsListItem(trimmed, out _, out _)
               || LooksLikeTableHeader(trimmed, index, lines);
    }

    private static string RenderInlineMarkdown(string input)
    {
        if (string.IsNullOrEmpty(input))
        {
            return string.Empty;
        }

        var output = new StringBuilder(input.Length + 32);
        int index = 0;

        while (index < input.Length)
        {
            if (index + 1 < input.Length && input[index] == '\\' && input[index + 1] == '(')
            {
                int close = input.IndexOf(@"\)", index + 2, StringComparison.Ordinal);
                if (close > index)
                {
                    string formula = input[(index + 2)..close];
                    output.Append("<span class=\"markdown-renderer__latex\" data-latex-placeholder=\"true\"><span class=\"markdown-renderer__placeholder-title\">LaTeX 公式将在交互层激活</span><code class=\"language-latex\">")
                        .Append(Encode(formula))
                        .Append("</code></span>");
                    index = close + 2;
                    continue;
                }
            }

            if (input[index] == '`')
            {
                int close = input.IndexOf('`', index + 1);
                if (close > index)
                {
                    output.Append("<code>").Append(Encode(input[(index + 1)..close])).Append("</code>");
                    index = close + 1;
                    continue;
                }
            }

            if (index + 2 < input.Length && input[index] == '!' && input[index + 1] == '[')
            {
                int labelEnd = input.IndexOf(']', index + 2);
                int urlStart = labelEnd >= 0 && labelEnd + 1 < input.Length && input[labelEnd + 1] == '(' ? labelEnd + 2 : -1;
                int urlEnd = urlStart > 0 ? input.IndexOf(')', urlStart) : -1;
                if (labelEnd > index && urlEnd > urlStart)
                {
                    string alt = input[(index + 2)..labelEnd];
                    string url = input[urlStart..urlEnd];
                    output.Append("<img loading=\"lazy\" decoding=\"async\" referrerpolicy=\"no-referrer\" src=\"")
                        .Append(Encode(ResolveSafeUrl(url)))
                        .Append("\" alt=\"")
                        .Append(Encode(alt))
                        .Append("\" />");
                    index = urlEnd + 1;
                    continue;
                }
            }

            if (input[index] == '[')
            {
                int labelEnd = input.IndexOf(']', index + 1);
                int urlStart = labelEnd >= 0 && labelEnd + 1 < input.Length && input[labelEnd + 1] == '(' ? labelEnd + 2 : -1;
                int urlEnd = urlStart > 0 ? input.IndexOf(')', urlStart) : -1;
                if (labelEnd > index && urlEnd > urlStart)
                {
                    string label = input[(index + 1)..labelEnd];
                    string url = input[urlStart..urlEnd];
                    output.Append("<a href=\"")
                        .Append(Encode(ResolveSafeUrl(url)))
                        .Append("\" rel=\"noopener noreferrer\" target=\"_blank\">")
                        .Append(Encode(label))
                        .Append("</a>");
                    index = urlEnd + 1;
                    continue;
                }
            }

            char ch = input[index];
            output.Append(ch switch
            {
                '&' => "&amp;",
                '<' => "&lt;",
                '>' => "&gt;",
                '"' => "&quot;",
                '\'' => "&#39;",
                _ => ch.ToString()
            });
            index++;
        }

        return output.ToString();
    }

    private static string ResolveSafeUrl(string input)
    {
        string url = (input ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(url))
        {
            return "#";
        }

        if (url.StartsWith("//", StringComparison.Ordinal))
        {
            return "#";
        }

        if (url.StartsWith("/", StringComparison.Ordinal)
            || url.StartsWith("#", StringComparison.Ordinal)
            || url.StartsWith("./", StringComparison.Ordinal)
            || url.StartsWith("../", StringComparison.Ordinal))
        {
            return url;
        }

        if (!Uri.TryCreate(url, UriKind.Absolute, out Uri? uri))
        {
            return url;
        }

        return uri.Scheme is "http" or "https" or "mailto" or "tel" ? url : "#";
    }

    private static string FormatFullPublicTime(string raw)
    {
        if (DateTimeOffset.TryParse(raw, out DateTimeOffset timestamp))
        {
            return timestamp.ToLocalTime().ToString("yyyy-MM-dd HH:mm:ss");
        }

        return raw;
    }

    private static int TryGetInt32(JsonElement element, string propertyName, int fallback = 0)
    {
        if (element.ValueKind == JsonValueKind.Object &&
            element.TryGetProperty(propertyName, out JsonElement value) &&
            value.ValueKind == JsonValueKind.Number &&
            value.TryGetInt32(out int result))
        {
            return result;
        }

        return fallback;
    }

    private static string TryGetNestedString(JsonElement element, string propertyName)
    {
        if (!element.TryGetProperty(propertyName, out JsonElement value))
        {
            return string.Empty;
        }

        if (value.ValueKind == JsonValueKind.String)
        {
            return value.GetString() ?? string.Empty;
        }

        if (value.ValueKind == JsonValueKind.Object)
        {
            return TryGetString(value, "name");
        }

        return string.Empty;
    }

    private static string Encode(string? value) => WebUtility.HtmlEncode(value ?? string.Empty);

    private static string EncodeJson(string json) => WebUtility.HtmlEncode(json);
}
