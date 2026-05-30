using FsusBlog.Core.Common;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public interface IPublicAotDocumentService
{
    Task<Result<string>> ComposeAsync(
        PublicAotShellEntryContract entry,
        CancellationToken cancellationToken = default);
}
