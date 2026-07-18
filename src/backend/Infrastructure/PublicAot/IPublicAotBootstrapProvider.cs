using FsusBlog.Core.Common;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public interface IPublicAotBootstrapProvider
{
    PublicPageKind Kind
    {
        get;
    }

    Task<Result<PublicPageSnapshot>> BuildSnapshotAsync(
        PublicAotRouteMatch match,
        CancellationToken cancellationToken = default);
}
