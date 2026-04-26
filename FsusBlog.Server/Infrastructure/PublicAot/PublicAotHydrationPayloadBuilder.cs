using System.Text.Json;

namespace FsusBlog.Server.Infrastructure.PublicAot;

internal static class PublicAotHydrationPayloadBuilder
{
    internal static string BuildHome(JsonElement root, string siteTitle, string siteDescription)
    {
        int currentPage = PublicAotJsonHelpers.TryGetInt32(root, "pageIndex", 1);
        int pageSize = PublicAotJsonHelpers.TryGetInt32(root, "pageSize", 8);
        int total = PublicAotJsonHelpers.TryGetInt32(root, "total");
        int safePageSize = Math.Max(1, pageSize);
        int totalPages = Math.Max(1, (total + safePageSize - 1) / safePageSize);
        JsonElement articles = root.TryGetProperty("articles", out JsonElement items) ? items : default;

        var viewItems = articles.ValueKind == JsonValueKind.Array
            ? articles.EnumerateArray().Select((article, index) => new
            {
                card = new
                {
                    kind = "article-list-card",
                    index
                },
                id = PublicAotJsonHelpers.TryGetInt32(article, "id"),
                href = $"/article/{PublicAotJsonHelpers.TryGetInt32(article, "id")}",
                title = PublicAotJsonHelpers.TryGetString(article, "title"),
                summary = PublicAotJsonHelpers.TryGetString(article, "summary"),
                meta = new
                {
                    isoTime = PublicAotJsonHelpers.TryGetString(article, "createTime"),
                    displayTime = PublicAotJsonHelpers.FormatPublicTime(PublicAotJsonHelpers.TryGetString(article, "createTime")),
                    fullTime = PublicAotJsonHelpers.FormatFullPublicTime(PublicAotJsonHelpers.TryGetString(article, "createTime")),
                    categoryName = PublicAotJsonHelpers.TryGetNestedString(article, "category")
                },
                tags = BuildHydrationTagItems(article)
            }).ToArray()
            : [];

        var payload = new
        {
            pageKind = "Home",
            routeKey = "home",
            rendererVersion = PublicAotShellService.PublicRendererVersion,
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

        return JsonSerializer.Serialize(payload, PublicAotShellService.JsonOptions);
    }

    internal static string BuildArticleDetail(JsonElement root, string siteTitle, string siteDescription)
    {
        if (!root.TryGetProperty("article", out JsonElement article) || article.ValueKind != JsonValueKind.Object)
        {
            return string.Empty;
        }

        int articleId = PublicAotJsonHelpers.TryGetInt32(root, "articleId", PublicAotJsonHelpers.TryGetInt32(article, "id"));
        string routeKey = articleId > 0 ? $"article:{articleId}" : "article:0";
        string content = PublicAotJsonHelpers.TryGetString(article, "content");
        string authorName = PublicAotJsonHelpers.TryGetString(root, "authorName");
        if (string.IsNullOrWhiteSpace(authorName))
        {
            authorName = siteTitle;
        }

        string renderedBody = PublicAotMarkdownRenderer.RenderArticleDetailMarkdownHtml(content);
        int wordCount = (content ?? string.Empty).Count(static ch => !char.IsWhiteSpace(ch));
        int estimatedReadingMinutes = Math.Max(1, (wordCount + 299) / 300);
        bool showReadingNotice = wordCount > 5_000;
        string noticeLabel = showReadingNotice
            ? $"长文预警：全文约 {wordCount.ToString("N0", System.Globalization.CultureInfo.GetCultureInfo("zh-CN"))} 字，预计阅读 {Math.Max(1, estimatedReadingMinutes)} 分钟"
            : string.Empty;
        int categoryId = article.TryGetProperty("category", out JsonElement categoryElement)
            ? PublicAotJsonHelpers.TryGetInt32(categoryElement, "id")
            : 0;
        string categoryName = PublicAotJsonHelpers.TryGetNestedString(article, "category");

        var payload = new
        {
            pageKind = "ArticleDetail",
            routeKey,
            articleId,
            rendererVersion = PublicAotShellService.PublicRendererVersion,
            title = PublicAotJsonHelpers.TryGetString(article, "title"),
            authorName,
            siteTitle,
            siteDescription,
            baseUrl = (string?)null,
            detailView = new
            {
                header = new
                {
                    id = articleId,
                    title = PublicAotJsonHelpers.TryGetString(article, "title"),
                    viewsText = $"{PublicAotJsonHelpers.TryGetInt32(article, "views")} 浏览",
                    meta = new
                    {
                        isoTime = PublicAotJsonHelpers.TryGetString(article, "createTime"),
                        displayTime = PublicAotJsonHelpers.FormatPublicTime(PublicAotJsonHelpers.TryGetString(article, "createTime")),
                        fullTime = PublicAotJsonHelpers.FormatFullPublicTime(PublicAotJsonHelpers.TryGetString(article, "createTime")),
                        categoryName,
                        categoryHref = categoryId > 0 ? $"/category/{categoryId}" : null
                    },
                    tags = BuildHydrationTagItems(article)
                },
                body = new
                {
                    content = renderedBody,
                    notice = new
                    {
                        visible = showReadingNotice,
                        label = noticeLabel
                    }
                },
                comments = new
                {
                    title = "评论",
                    headingText = "评论",
                    loadingText = "加载中",
                    endText = "暂无评论。",
                    placeholderTitle = "暂无评论",
                    placeholderBody = string.Empty,
                    placeholderHint = string.Empty
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
            }
        };

        return JsonSerializer.Serialize(payload, PublicAotShellService.JsonOptions);
    }

    internal static string BuildAbout(JsonElement root, string siteTitle, string siteDescription)
    {
        JsonElement about = root.TryGetProperty("about", out JsonElement aboutPayload) ? aboutPayload : default;
        string routeKey = PublicAotJsonHelpers.TryGetString(root, "routeKey");
        if (string.IsNullOrWhiteSpace(routeKey))
        {
            routeKey = "about";
        }

        var payload = new
        {
            pageKind = "About",
            routeKey,
            rendererVersion = PublicAotShellService.PublicRendererVersion,
            title = "关于",
            siteTitle,
            siteDescription,
            baseUrl = (string?)null,
            about = new
            {
                slug = PublicAotJsonHelpers.TryGetString(about, "slug"),
                content = PublicAotJsonHelpers.TryGetString(about, "content")
            }
        };

        return JsonSerializer.Serialize(payload, PublicAotShellService.JsonOptions);
    }

    internal static string BuildArchive(JsonElement root, string siteTitle, string siteDescription)
    {
        string routeKey = PublicAotJsonHelpers.TryGetString(root, "routeKey");
        if (string.IsNullOrWhiteSpace(routeKey))
        {
            routeKey = "archive";
        }

        JsonElement articles = root.TryGetProperty("articles", out JsonElement archiveItems) ? archiveItems : default;
        int total = PublicAotJsonHelpers.TryGetInt32(root, "total");
        var payload = new
        {
            pageKind = "Archive",
            routeKey,
            rendererVersion = PublicAotShellService.PublicRendererVersion,
            title = "归档",
            siteTitle,
            siteDescription,
            baseUrl = (string?)null,
            total,
            articles = articles.ValueKind == JsonValueKind.Array
                ? articles.EnumerateArray().Select(article => new
                {
                    id = PublicAotJsonHelpers.TryGetInt32(article, "id"),
                    title = PublicAotJsonHelpers.TryGetString(article, "title"),
                    createTime = PublicAotJsonHelpers.TryGetString(article, "createTime")
                }).ToArray()
                : []
        };

        return JsonSerializer.Serialize(payload, PublicAotShellService.JsonOptions);
    }

    internal static string BuildFilter(JsonElement root, string siteTitle, string siteDescription)
    {
        string routeKey = PublicAotJsonHelpers.TryGetString(root, "routeKey");
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
            rendererVersion = PublicAotShellService.PublicRendererVersion,
            title = "筛选",
            siteTitle,
            siteDescription,
            baseUrl = (string?)null,
            filter = new
            {
                pageIndex = PublicAotJsonHelpers.TryGetInt32(filter, "pageIndex", 1),
                pageSize = PublicAotJsonHelpers.TryGetInt32(filter, "pageSize", 10),
                total = PublicAotJsonHelpers.TryGetInt32(filter, "total"),
                articles = articles.ValueKind == JsonValueKind.Array
                    ? articles.EnumerateArray().Select(article => new
                    {
                        id = PublicAotJsonHelpers.TryGetInt32(article, "id"),
                        title = PublicAotJsonHelpers.TryGetString(article, "title"),
                        summary = PublicAotJsonHelpers.TryGetString(article, "summary"),
                        createTime = PublicAotJsonHelpers.TryGetString(article, "createTime")
                    }).ToArray()
                    : []
            }
        };

        return JsonSerializer.Serialize(payload, PublicAotShellService.JsonOptions);
    }

    internal static string BuildIslands(PublicPageKind kind, JsonElement root)
        => string.Empty;

    private static object[] BuildHydrationTagItems(JsonElement article)
    {
        if (!article.TryGetProperty("tags", out JsonElement tags) || tags.ValueKind != JsonValueKind.Array)
        {
            return [];
        }

        return tags.EnumerateArray()
            .Select(tag => tag.ValueKind == JsonValueKind.String ? tag.GetString() ?? string.Empty : PublicAotJsonHelpers.TryGetString(tag, "name"))
            .Where(name => !string.IsNullOrWhiteSpace(name))
            .Take(5)
            .Select(name => (object)new
            {
                label = $"#{name}"
            })
            .ToArray();
    }
}
