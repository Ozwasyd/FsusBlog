using FsusBlog.Core.Common;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public interface IPublicAotEntryRenderer
{
    Task<Result<PublicAotShellEntryContract>> BuildEntryAsync(
        PublicAotRenderRequest request,
        CancellationToken cancellationToken = default);

    Task<Result> ValidateBundleAsync(
        PublicAotShellBundleContract bundle,
        CancellationToken cancellationToken = default);
}
