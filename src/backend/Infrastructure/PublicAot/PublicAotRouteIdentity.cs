using FsusBlog.Shared.Contracts.Localization;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public interface IPublicAotRouteIdentity
{
    bool TryResolve(HttpContext context, out PublicAotRouteMatch match);

    PublicAotRouteMatch ResolveBackfillMatch(PublicAotBackfillRequest request);
}

internal sealed class PublicAotRouteIdentity(
    IPublicAotRouteRegistry routeRegistry) : IPublicAotRouteIdentity
{
    public bool TryResolve(HttpContext context, out PublicAotRouteMatch match)
        => routeRegistry.TryResolve(context, out match);

    public PublicAotRouteMatch ResolveBackfillMatch(PublicAotBackfillRequest request)
    {
        if (!LocaleCatalog.TryParse(request.Locale, out LocaleDescriptor locale)
            || !string.Equals(request.Locale, locale.Code, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("public_aot_backfill_locale_invalid");
        }

        var localeResolution = new LocaleResolutionResult(
            locale,
            LocaleResolutionSource.Default,
            locale.Code,
            LocaleCatalog.Digest);
        var context = new DefaultHttpContext();
        context.Request.Path = string.IsNullOrWhiteSpace(request.Path) ? "/" : request.Path;
        context.Request.QueryString = string.IsNullOrWhiteSpace(request.QueryString)
            ? QueryString.Empty
            : new QueryString(request.QueryString);

        if (routeRegistry.TryResolve(context, out PublicAotRouteMatch match))
        {
            return match with
            {
                LocaleResolution = localeResolution
            };
        }

        PublicAotPageDescriptor descriptor = PublicAotPageCatalog.GetRequired(request.Kind);
        if (PublicRouteIdentity.SupportsPagination(descriptor.PageId))
        {
            throw new InvalidOperationException("public_aot_cursor_only_route_required");
        }

        return new PublicAotRouteMatch(
            request.Kind,
            descriptor.PageId,
            request.RouteKey,
            PublicRouteIdentity.BuildCanonicalPath(descriptor.PageId, request.RouteKey, null),
            request.Path,
            request.QueryString)
        {
            Page = 1,
            LocaleResolution = localeResolution
        };
    }
}
