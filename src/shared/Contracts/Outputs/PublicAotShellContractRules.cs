namespace FsusBlog.Shared.Contracts.Outputs;

/// <summary>
/// Provides canonical markers and validation rules for public AOT shell output.
/// </summary>
public static class PublicAotShellContractRules
{
    private const string RendererVersionPrefix = "public-app-ssr@";

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

        PublicPageDescriptor pageDescriptor = PublicPageRegistry.GetRequired(entry.PageId);
        if (!pageDescriptor.AotShellReady)
        {
            error = $"AOT 页面类型未启用公开 shell: {entry.PageId}";
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

        if (string.IsNullOrWhiteSpace(entry.BootstrapPayload))
        {
            error = "AOT bootstrap 为空";
            return false;
        }

        if (string.IsNullOrWhiteSpace(entry.HydrationPropsPayload))
        {
            error = "AOT hydration props 为空";
            return false;
        }

        normalizedRouteKey = NormalizeRouteKey(entry.PageId, entry.RouteKey, entry.ArticleId);
        normalizedHtml = NormalizeHtml(entry.Html, entry.ArticleId);

        if (!PublicAotEntryPayloadView.TryCreate(entry, out PublicAotEntryPayloadView? payloadView, out error))
        {
            return false;
        }

        PublicAotEntryPayloadView view = payloadView!;
        {
            if (!TryValidateBootstrapPayload(entry, normalizedRouteKey, view, out error))
            {
                return false;
            }

            if (!TryValidateHydrationPropsPayload(entry, normalizedRouteKey, view, out error))
            {
                return false;
            }

            if (!TryValidateIslandsPayload(entry, view, out error))
            {
                return false;
            }

            return true;
        }
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
            PublicPageId.Home => NormalizePaginatedFixedRouteKey("home", resolved),
            PublicPageId.About => "about",
            PublicPageId.Archive => "archive",
            PublicPageId.Account => "account",
            _ => resolved
        };
    }

    private static string NormalizePaginatedFixedRouteKey(string fixedRouteKey, string routeKey)
    {
        const string Marker = ":page:";
        int markerIndex = routeKey.LastIndexOf(Marker, StringComparison.OrdinalIgnoreCase);
        if (markerIndex <= 0
            || !int.TryParse(routeKey.AsSpan(markerIndex + Marker.Length), out int page)
            || page <= 1)
        {
            return fixedRouteKey;
        }

        return string.Concat(fixedRouteKey, Marker, page.ToString(System.Globalization.CultureInfo.InvariantCulture));
    }

    public static string NormalizeHtml(string html, int? articleId)
    {
        if (articleId is not > 0)
        {
            return html;
        }

        return html.Replace("{{articleId}}", articleId.Value.ToString(), StringComparison.OrdinalIgnoreCase);
    }

    private static bool TryValidateBootstrapPayload(PublicAotShellEntryContract entry, string normalizedRouteKey, PublicAotEntryPayloadView payloadView, out string error)
    {
        error = string.Empty;
        IReadOnlyDictionary<string, object?> root = payloadView.Bootstrap;
        if (root.TryGetValue("kind", out object? kindElement) &&
            kindElement is not string)
        {
            error = "AOT bootstrap.kind 非法";
            return false;
        }

        string? kind = TryGetString(root, "kind");
        string? pageKind = TryGetString(root, "pageKind");
        string? routeKey = TryGetString(root, "routeKey");
        string? rendererVersion = TryGetString(root, "rendererVersion");

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
            if (!TryGetObject(root, "article", out IReadOnlyDictionary<string, object?> article))
            {
                error = "AOT bootstrap.article 缺失";
                return false;
            }

            if (!article.TryGetValue("id", out object? articleIdElement) ||
                !TryGetInt32(articleIdElement, out int articleId) ||
                articleId != entry.ArticleId)
            {
                error = "AOT bootstrap.article.id 与 entry.articleId 不一致";
                return false;
            }

        }

        return true;
    }

    private static bool TryValidateHydrationPropsPayload(PublicAotShellEntryContract entry, string normalizedRouteKey, PublicAotEntryPayloadView payloadView, out string error)
    {
        error = string.Empty;
        IReadOnlyDictionary<string, object?> root = payloadView.Hydration;
        string? pageKind = TryGetString(root, "pageKind");
        string? routeKey = TryGetString(root, "routeKey");
        string? rendererVersion = TryGetString(root, "rendererVersion");

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
            if (!root.TryGetValue("articleId", out object? articleIdElement) ||
                !TryGetInt32(articleIdElement, out int articleId) ||
                articleId != entry.ArticleId)
            {
                error = "AOT hydration.articleId 与 entry.articleId 不一致";
                return false;
            }

            if (!TryGetObject(root, "commentsIsland", out IReadOnlyDictionary<string, object?> commentsIsland))
            {
                error = "AOT hydration.commentsIsland 缺失";
                return false;
            }

            if (!commentsIsland.TryGetValue("articleId", out object? islandArticleIdElement) ||
                !TryGetInt32(islandArticleIdElement, out int islandArticleId) ||
                islandArticleId != entry.ArticleId)
            {
                error = "AOT hydration.commentsIsland.articleId 与 entry.articleId 不一致";
                return false;
            }
        }

        return true;
    }

    private static bool TryValidateIslandsPayload(PublicAotShellEntryContract entry, PublicAotEntryPayloadView payloadView, out string error)
    {
        error = string.Empty;

        if (payloadView.HasIslands)
        {
            error = "AOT islands payload retired; use hydration commentsIsland";
            return false;
        }

        return true;
    }


    private static string? TryGetString(IReadOnlyDictionary<string, object?> payload, string propertyName)
        => payload.TryGetValue(propertyName, out object? value) && value is string text ? text : null;

    private static bool TryGetObject(
        IReadOnlyDictionary<string, object?> payload,
        string propertyName,
        out IReadOnlyDictionary<string, object?> value)
    {
        if (payload.TryGetValue(propertyName, out object? item) &&
            item is IReadOnlyDictionary<string, object?> objectValue)
        {
            value = objectValue;
            return true;
        }

        value = new Dictionary<string, object?>(StringComparer.Ordinal);
        return false;
    }

    private static bool TryGetInt32(object? element, out int value)
    {
        if (element is int intValue)
        {
            value = intValue;
            return true;
        }

        if (element is long longValue && longValue >= int.MinValue && longValue <= int.MaxValue)
        {
            value = (int)longValue;
            return true;
        }

        if (element is double doubleValue && doubleValue >= int.MinValue && doubleValue <= int.MaxValue)
        {
            value = (int)doubleValue;
            return true;
        }

        if (element is string text && int.TryParse(text, out value))
        {
            return true;
        }

        value = 0;
        return false;
    }
}
