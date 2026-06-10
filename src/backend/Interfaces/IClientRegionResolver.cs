using FsusBlog.Server.Models.Moderation;

namespace FsusBlog.Server.Interfaces;

public interface IClientRegionResolver
{
    ClientRegionResolution Resolve(HttpContext httpContext);
}
