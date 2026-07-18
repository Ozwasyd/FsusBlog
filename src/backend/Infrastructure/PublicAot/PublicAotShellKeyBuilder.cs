using FsusBlog.Core.Common;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Infrastructure.PublicAot;

internal static class PublicAotShellKeyBuilder
{
    internal static PublicPageId ToPageId(PublicPageKind kind)
        => PublicAotPageCatalog.GetRequired(kind).PageId;

    internal static string BuildRouteKey(HttpContext context, PublicPageKind kind)
        => PublicRouteIdentity.BuildRouteKey(context, kind);

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

        if (!string.IsNullOrWhiteSpace(entry.HydrationPropsPayload) && string.IsNullOrWhiteSpace(entry.RendererVersion))
        {
            return Result.Failure(ErrorCode.Validation, "HydrationProps 缺少 rendererVersion");
        }

        routeKey = PublicRouteIdentity.NormalizeRouteKey(entry.PageId, entry.RouteKey, entry.ArticleId);
        html = NormalizeHtml(entry.Html, entry.ArticleId);
        return Result.Success();
    }

    private static string NormalizeHtml(string html, int? articleId)
    {
        if (articleId is not > 0)
        {
            return html;
        }

        return html.Replace("{{articleId}}", articleId.Value.ToString(), StringComparison.OrdinalIgnoreCase);
    }
}
