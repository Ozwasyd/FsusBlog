using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Interfaces;

public interface IStatsService
{
    Task<AdminStatsQueryDto> GetAdminStatsAsync();
    Task<AdminStatsOverviewDto> GetAdminStatsOverviewAsync();
    Task<List<RecentCommentStatItemDto>> GetAdminRecentCommentsAsync();
    Task<List<RegionStatItemDto>> GetAdminRegionStatsAsync();
}
