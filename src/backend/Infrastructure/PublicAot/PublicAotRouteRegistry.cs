using Microsoft.AspNetCore.Http;
using System.Globalization;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed class PublicAotRouteRegistry : IPublicAotRouteRegistry
{
    public bool TryResolve(HttpContext context, out PublicAotRouteMatch match)
    {
        match = default!;
        if (!PublicRouteIdentity.TryResolveKind(context.Request.Path, out PublicPageKind kind))
        {
            return false;
        }

        PublicAotPageDescriptor descriptor = PublicAotPageCatalog.GetRequired(kind);
        if (!descriptor.AotShellReady)
        {
            return false;
        }

        string routeKey = PublicRouteIdentity.BuildRouteKey(context, kind);
        int page = 1;
        bool requiresPaginationRedirect = false;
        string canonicalQueryString = string.Empty;
        if (PublicRouteIdentity.SupportsPagination(descriptor.PageId))
        {
            (page, canonicalQueryString, requiresPaginationRedirect) = ResolvePagination(context.Request);
            routeKey = PublicRouteIdentity.BuildPaginatedRouteKey(routeKey, page);
        }
        string canonicalPath = PublicRouteIdentity.BuildCanonicalPath(descriptor.PageId, routeKey, null);
        match = new PublicAotRouteMatch(
            kind,
            descriptor.PageId,
            routeKey,
            canonicalPath,
            context.Request.Path.Value ?? string.Empty,
            canonicalQueryString)
        {
            Page = page,
            RequiresPaginationRedirect = requiresPaginationRedirect
        };
        return true;
    }

    private static (int Page, string CanonicalQueryString, bool RequiresRedirect) ResolvePagination(HttpRequest request)
    {
        bool hasOnlyPageKey = request.Query.Count == 0
            || request.Query.Keys.All(static key => string.Equals(key, "page", StringComparison.Ordinal));
        Microsoft.Extensions.Primitives.StringValues pageValues = request.Query["page"];
        string rawPage = pageValues.Count == 1 ? pageValues[0] ?? string.Empty : string.Empty;
        bool hasValidPage = pageValues.Count == 0
            || (pageValues.Count == 1
                && int.TryParse(rawPage, NumberStyles.None, CultureInfo.InvariantCulture, out int parsedPage)
                && parsedPage > 0);
        int page = hasValidPage && pageValues.Count == 1
            ? int.Parse(rawPage, CultureInfo.InvariantCulture)
            : 1;
        string canonicalQueryString = PublicRouteIdentity.BuildPaginationQueryString(page);
        string originalQueryString = request.QueryString.Value ?? string.Empty;
        bool requiresRedirect = !hasOnlyPageKey
            || !hasValidPage
            || !string.Equals(originalQueryString, canonicalQueryString, StringComparison.Ordinal);
        return (page, canonicalQueryString, requiresRedirect);
    }
}
