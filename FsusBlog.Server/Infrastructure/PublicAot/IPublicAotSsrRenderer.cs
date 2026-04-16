using FsusBlog.Core.Common;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public interface IPublicAotSsrRenderer
{
    Task<Result<PublicAotSsrRenderResult>> RenderAsync(
        PublicPageKind kind,
        string hydrationPropsJson,
        CancellationToken cancellationToken = default);
}
