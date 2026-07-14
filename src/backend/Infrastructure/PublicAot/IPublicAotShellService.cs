using Microsoft.AspNetCore.Http;
using FsusBlog.Core.Common;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public interface IPublicAotShellService
{
    bool TryResolve(HttpContext context, out PublicAotRouteMatch match);

    Task<PublicAotCacheEntry?> RenderAsync(HttpContext context, PublicAotRouteMatch match, CancellationToken cancellationToken = default);

    Task<PublicAotRenderOutcome> RenderClassifiedAsync(
        HttpContext context,
        PublicAotRouteMatch match,
        CancellationToken cancellationToken = default);

    Task<Result<PublicAotNavigationSnapshot>> BuildNavigationSnapshotAsync(
        HttpContext context,
        PublicAotRouteMatch match,
        CancellationToken cancellationToken = default);

    Task<Result> InvalidateAllAsync(CancellationToken cancellationToken = default);
}
