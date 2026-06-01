using Microsoft.AspNetCore.Http;
using FsusBlog.Core.Common;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public interface IPublicAotShellService
{
    bool TryResolve(HttpContext context, out PublicAotRouteMatch match);

    Task<string?> RenderAsync(HttpContext context, PublicAotRouteMatch match, CancellationToken cancellationToken = default);

    Task<Result> InvalidateAllAsync(CancellationToken cancellationToken = default);
}
