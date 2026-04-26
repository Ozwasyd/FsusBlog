using FsusBlog.Core.Common;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Infrastructure.PublicAot;

internal static class PublicAotShellKeyBuilder
{
    internal static PublicPageId ToPageId(PublicPageKind kind)
        => PublicAotPageCatalog.GetRequired(kind).PageId;

    internal static string BuildRouteKey(HttpContext context, PublicPageKind kind)
    {
        string path = context.Request.Path.Value?.TrimEnd('/') ?? string.Empty;
        PublicAotPageDescriptor descriptor = PublicAotPageCatalog.GetRequired(kind);

        if (!string.IsNullOrWhiteSpace(descriptor.FixedRouteKey))
        {
            return descriptor.FixedRouteKey;
        }

        return kind switch
        {
            PublicPageKind.ArticleDetail when TryResolvePathId(context, "/article/", out int id) => $"article:{id}",
            PublicPageKind.Filter => BuildFilterRouteKey(path, context),
            _ => path
        };
    }

    internal static Result ValidateBundleEntry(PublicAotShellEntryContract entry, out string routeKey, out string html)
    {
        routeKey = string.Empty;
        html = string.Empty;

        if (!Enum.IsDefined(typeof(PublicPageId), entry.PageId))
        {
            return Result.Failure(ErrorCode.Validation, "AOT 页面类型非法");
        }

        if (string.IsNullOrWhiteSpace(entry.RouteKey))
        {
            return Result.Failure(ErrorCode.Validation, "AOT 路由为空");
        }

        if (string.IsNullOrWhiteSpace(entry.Html))
        {
            return Result.Failure(ErrorCode.Validation, "AOT HTML 为空");
        }

        if (!string.IsNullOrWhiteSpace(entry.HydrationPropsJson) && string.IsNullOrWhiteSpace(entry.RendererVersion))
        {
            return Result.Failure(ErrorCode.Validation, "HydrationProps 缺少 rendererVersion");
        }

        routeKey = NormalizeRouteKey(entry.PageId, entry.RouteKey, entry.ArticleId);
        html = NormalizeHtml(entry.Html, entry.ArticleId);
        return Result.Success();
    }

    private static string NormalizeRouteKey(PublicPageId pageId, string routeKey, int? articleId)
    {
        string resolved = routeKey.Trim();
        if (articleId is > 0)
        {
            resolved = resolved.Replace("{{articleId}}", articleId.Value.ToString(), StringComparison.OrdinalIgnoreCase);
        }

        PublicAotPageDescriptor descriptor = PublicAotPageCatalog.GetRequired(pageId);
        return string.IsNullOrWhiteSpace(descriptor.FixedRouteKey)
            ? resolved
            : descriptor.FixedRouteKey;
    }

    private static string NormalizeHtml(string html, int? articleId)
    {
        if (articleId is not > 0)
        {
            return html;
        }

        return html.Replace("{{articleId}}", articleId.Value.ToString(), StringComparison.OrdinalIgnoreCase);
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
}
