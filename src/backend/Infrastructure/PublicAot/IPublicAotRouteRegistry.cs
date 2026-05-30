using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public interface IPublicAotRouteRegistry
{
    bool TryResolve(HttpContext context, out PublicAotRouteMatch match);
}
