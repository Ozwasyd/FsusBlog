using Microsoft.AspNetCore.Http;

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
        string canonicalPath = PublicRouteIdentity.BuildCanonicalPath(descriptor.PageId, routeKey, null);
        match = new PublicAotRouteMatch(
            kind,
            descriptor.PageId,
            routeKey,
            canonicalPath,
            context.Request.Path.Value ?? string.Empty,
            context.Request.QueryString.Value ?? string.Empty);
        return true;
    }
}
