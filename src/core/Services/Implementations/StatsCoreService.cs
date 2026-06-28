using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Core.Services.Gateways;

namespace FsusBlog.Core.Services.Implementations;

public sealed class StatsCoreService(IStatsCoreGateway gateway) : IStatsCoreService
{
    public async Task<Result<SiteStatsCoreModel>> GetAdminStatsAsync() => Result<SiteStatsCoreModel>.Success(await gateway.GetAdminStatsAsync());

    public async Task<Result<IReadOnlyList<RecentCommentCoreModel>>> GetAdminRecentCommentsAsync()
        => Result<IReadOnlyList<RecentCommentCoreModel>>.Success(await gateway.GetAdminRecentCommentsAsync());

    public async Task<Result<IReadOnlyList<RegionDistributionCoreModel>>> GetAdminRegionStatsAsync()
        => Result<IReadOnlyList<RegionDistributionCoreModel>>.Success(await gateway.GetAdminRegionStatsAsync());
}
