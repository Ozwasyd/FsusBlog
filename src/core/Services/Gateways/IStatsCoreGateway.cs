using FsusBlog.Core.Mapping.Models;

namespace FsusBlog.Core.Services.Gateways;

public interface IStatsCoreGateway
{
    Task<SiteStatsCoreModel> GetAdminStatsAsync();
    Task<IReadOnlyList<RecentCommentCoreModel>> GetAdminRecentCommentsAsync();
    Task<IReadOnlyList<RegionDistributionCoreModel>> GetAdminRegionStatsAsync();
}
