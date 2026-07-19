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
        var context = new DefaultHttpContext();
        context.Request.Path = string.IsNullOrWhiteSpace(request.Path) ? "/" : request.Path;
        context.Request.QueryString = string.IsNullOrWhiteSpace(request.QueryString)
            ? QueryString.Empty
            : new QueryString(request.QueryString);

        if (routeRegistry.TryResolve(context, out PublicAotRouteMatch match))
        {
            return match;
        }

        PublicAotPageDescriptor descriptor = PublicAotPageCatalog.GetRequired(request.Kind);
        return new PublicAotRouteMatch(
            request.Kind,
            descriptor.PageId,
            request.RouteKey,
            PublicRouteIdentity.BuildCanonicalPath(descriptor.PageId, request.RouteKey, null),
            request.Path,
            request.QueryString)
        {
            Page = PublicRouteIdentity.ParsePageRouteKey(request.RouteKey)
        };
    }
}
