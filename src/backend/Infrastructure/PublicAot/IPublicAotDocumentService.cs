using FsusBlog.Core.Common;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public interface IPublicAotDocumentService
{
    Task<Result<string>> ComposeAsync(
        PublicAotShellEntryContract entry,
        CancellationToken cancellationToken = default);

    Task<Result<string>> ComposeAsync(
        PublicAotShellEntryContract entry,
        HttpContext? context,
        CancellationToken cancellationToken = default);
}
