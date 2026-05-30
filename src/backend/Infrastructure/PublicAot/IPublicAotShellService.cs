using Microsoft.AspNetCore.Http;
using FsusBlog.Core.Common;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public interface IPublicAotShellService
{
    bool TryResolve(HttpContext context, out PublicPageKind kind);

    Task<string?> RenderAsync(HttpContext context, CancellationToken cancellationToken = default);

    Task<Result> InvalidateAllAsync(CancellationToken cancellationToken = default);
}
