using System.Text.Json;

namespace FsusBlog.Shared.Contracts.Outputs;

public static class PublicAotShellContractRules
{
    private const string RendererVersionPrefix = "public-vue-renderer@";

    public static bool TryValidateEntry(
        PublicAotShellEntryContract entry,
        out string normalizedRouteKey,
        out string normalizedHtml,
        out string error)
    {
        normalizedRouteKey = string.Empty;
        normalizedHtml = string.Empty;
        error = string.Empty;

        if (!Enum.IsDefined(typeof(PublicPageId), entry.PageId))
        {
            error = "AOT 页面类型非法";
            return false;
        }

        if (string.IsNullOrWhiteSpace(entry.RendererVersion))
        {
            error = "AOT rendererVersion 为空";
            return false;
        }

        if (!entry.RendererVersion.Trim().StartsWith(RendererVersionPrefix, StringComparison.OrdinalIgnoreCase))
        {
            error = "AOT rendererVersion 非法";
            return false;
        }

        if (string.IsNullOrWhiteSpace(entry.RouteKey))
        {
            error = "AOT 路由为空";
            return false;
        }

        if (string.IsNullOrWhiteSpace(entry.Html))
        {
            error = "AOT HTML 为空";
            return false;
        }

        if (string.IsNullOrWhiteSpace(entry.BootstrapJson))
        {
            error = "AOT bootstrap 为空";
            return false;
        }

        if (string.IsNullOrWhiteSpace(entry.HydrationPropsJson))
        {
            error = "AOT hydration props 为空";
            return false;
        }

        normalizedRouteKey = NormalizeRouteKey(entry.PageId, entry.RouteKey, entry.ArticleId);
        normalizedHtml = NormalizeHtml(entry.Html, entry.ArticleId);

        if (!TryValidateBootstrapJson(entry, normalizedRouteKey, out error))
        {
            return false;
        }

        if (!TryValidateHydrationPropsJson(entry, normalizedRouteKey, out error))
        {
            return false;
        }

        if (!TryValidateIslandsJson(entry, out error))
        {
            return false;
        }

        return true;
    }

    public static string NormalizeRouteKey(PublicPageId pageId, string routeKey, int? articleId)
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

    public static string NormalizeHtml(string html, int? articleId)
    {
        if (articleId is not > 0)
        {
            return html;
        }

        return html.Replace("{{articleId}}", articleId.Value.ToString(), StringComparison.OrdinalIgnoreCase);
    }

    private static bool TryValidateBootstrapJson(PublicAotShellEntryContract entry, string normalizedRouteKey, out string error)
    {
        error = string.Empty;

        try
        {
            using JsonDocument document = JsonDocument.Parse(entry.BootstrapJson!);
            JsonElement root = document.RootElement;
            if (root.TryGetProperty("kind", out JsonElement kindElement) &&
                !kindElement.ValueKind.Equals(JsonValueKind.String))
            {
                error = "AOT bootstrap.kind 非法";
                return false;
            }

            string? kind = root.TryGetProperty("kind", out JsonElement kindValue) ? kindValue.GetString() : null;
            string? pageKind = root.TryGetProperty("pageKind", out JsonElement pageKindValue) ? pageKindValue.GetString() : null;
            string? routeKey = root.TryGetProperty("routeKey", out JsonElement routeKeyValue) ? routeKeyValue.GetString() : null;
            string? rendererVersion = root.TryGetProperty("rendererVersion", out JsonElement rendererVersionValue) ? rendererVersionValue.GetString() : null;

            string expectedPageKind = entry.PageId.ToString();
            if (!string.IsNullOrWhiteSpace(kind) && !string.Equals(kind, expectedPageKind, StringComparison.Ordinal))
            {
                error = $"AOT bootstrap.kind 与页面类型不一致，应为 {expectedPageKind}";
                return false;
            }

            if (!string.IsNullOrWhiteSpace(pageKind) && !string.Equals(pageKind, expectedPageKind, StringComparison.Ordinal))
            {
                error = $"AOT bootstrap.pageKind 与页面类型不一致，应为 {expectedPageKind}";
                return false;
            }

            if (!string.IsNullOrWhiteSpace(routeKey) && !string.Equals(routeKey, normalizedRouteKey, StringComparison.Ordinal))
            {
                error = $"AOT bootstrap.routeKey 与页面路由不一致，应为 {normalizedRouteKey}";
                return false;
            }

            if (!string.IsNullOrWhiteSpace(rendererVersion) &&
                !string.Equals(rendererVersion, entry.RendererVersion, StringComparison.Ordinal))
            {
                error = "AOT bootstrap.rendererVersion 与 entry 不一致";
                return false;
            }

            if (entry.PageId == PublicPageId.ArticleDetail)
            {
                if (!root.TryGetProperty("article", out JsonElement article) || article.ValueKind != JsonValueKind.Object)
                {
                    error = "AOT bootstrap.article 缺失";
                    return false;
                }

                if (!article.TryGetProperty("id", out JsonElement articleIdElement) ||
                    !TryGetInt32(articleIdElement, out int articleId) ||
                    articleId != entry.ArticleId)
                {
                    error = "AOT bootstrap.article.id 与 entry.articleId 不一致";
                    return false;
                }

                if (!root.TryGetProperty("commentsPlaceholder", out JsonElement placeholder) ||
                    placeholder.ValueKind != JsonValueKind.String ||
                    string.IsNullOrWhiteSpace(placeholder.GetString()))
                {
                    error = "AOT bootstrap.commentsPlaceholder 缺失";
                    return false;
                }
            }

            return true;
        }
        catch (JsonException)
        {
            error = "AOT bootstrap 不是合法 JSON";
            return false;
        }
    }

    private static bool TryValidateHydrationPropsJson(PublicAotShellEntryContract entry, string normalizedRouteKey, out string error)
    {
        error = string.Empty;

        try
        {
            using JsonDocument document = JsonDocument.Parse(entry.HydrationPropsJson!);
            JsonElement root = document.RootElement;
            string? pageKind = root.TryGetProperty("pageKind", out JsonElement pageKindValue) ? pageKindValue.GetString() : null;
            string? routeKey = root.TryGetProperty("routeKey", out JsonElement routeKeyValue) ? routeKeyValue.GetString() : null;
            string? rendererVersion = root.TryGetProperty("rendererVersion", out JsonElement rendererVersionValue) ? rendererVersionValue.GetString() : null;

            string expectedPageKind = entry.PageId.ToString();
            if (!string.Equals(pageKind, expectedPageKind, StringComparison.Ordinal))
            {
                error = $"AOT hydration.pageKind 与页面类型不一致，应为 {expectedPageKind}";
                return false;
            }

            if (!string.Equals(routeKey, normalizedRouteKey, StringComparison.Ordinal))
            {
                error = $"AOT hydration.routeKey 与页面路由不一致，应为 {normalizedRouteKey}";
                return false;
            }

            if (!string.IsNullOrWhiteSpace(rendererVersion) &&
                !string.Equals(rendererVersion, entry.RendererVersion, StringComparison.Ordinal))
            {
                error = "AOT hydration.rendererVersion 与 entry 不一致";
                return false;
            }

            if (entry.PageId == PublicPageId.ArticleDetail)
            {
                if (!root.TryGetProperty("articleId", out JsonElement articleIdElement) ||
                    !TryGetInt32(articleIdElement, out int articleId) ||
                    articleId != entry.ArticleId)
                {
                    error = "AOT hydration.articleId 与 entry.articleId 不一致";
                    return false;
                }

                if (!root.TryGetProperty("commentsIsland", out JsonElement commentsIsland) ||
                    commentsIsland.ValueKind != JsonValueKind.Object)
                {
                    error = "AOT hydration.commentsIsland 缺失";
                    return false;
                }

                if (!commentsIsland.TryGetProperty("articleId", out JsonElement islandArticleIdElement) ||
                    !TryGetInt32(islandArticleIdElement, out int islandArticleId) ||
                    islandArticleId != entry.ArticleId)
                {
                    error = "AOT hydration.commentsIsland.articleId 与 entry.articleId 不一致";
                    return false;
                }
            }

            return true;
        }
        catch (JsonException)
        {
            error = "AOT hydration props 不是合法 JSON";
            return false;
        }
    }

    private static bool TryValidateIslandsJson(PublicAotShellEntryContract entry, out string error)
    {
        error = string.Empty;

        if (entry.PageId != PublicPageId.ArticleDetail)
        {
            if (!string.IsNullOrWhiteSpace(entry.IslandsJson))
            {
                error = "非文章详情页不应携带 islands";
                return false;
            }

            return true;
        }

        if (string.IsNullOrWhiteSpace(entry.IslandsJson))
        {
            error = "文章详情页 islands 缺失";
            return false;
        }

        try
        {
            using JsonDocument document = JsonDocument.Parse(entry.IslandsJson!);
            JsonElement root = document.RootElement;
            if (!root.TryGetProperty("comments", out JsonElement comments) || comments.ValueKind != JsonValueKind.Object)
            {
                error = "AOT islands.comments 缺失";
                return false;
            }

            if (!comments.TryGetProperty("articleId", out JsonElement articleIdElement) ||
                !TryGetInt32(articleIdElement, out int articleId) ||
                articleId != entry.ArticleId)
            {
                error = "AOT islands.comments.articleId 与 entry.articleId 不一致";
                return false;
            }

            return true;
        }
        catch (JsonException)
        {
            error = "AOT islands 不是合法 JSON";
            return false;
        }
    }

    private static bool TryGetInt32(JsonElement element, out int value)
    {
        if (element.ValueKind == JsonValueKind.Number && element.TryGetInt32(out value))
        {
            return true;
        }

        if (element.ValueKind == JsonValueKind.String && int.TryParse(element.GetString(), out value))
        {
            return true;
        }

        value = 0;
        return false;
    }
}
