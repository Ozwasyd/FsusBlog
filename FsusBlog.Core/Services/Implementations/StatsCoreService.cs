using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Core.Services.Gateways;

namespace FsusBlog.Core.Services.Implementations;

public sealed class StatsCoreService(ILegacyStatsGateway gateway) : IStatsCoreService
{
    public async Task<Result<SiteStatsCoreModel>> GetAdminStatsAsync() => Result<SiteStatsCoreModel>.Success(await gateway.GetAdminStatsAsync());
}
