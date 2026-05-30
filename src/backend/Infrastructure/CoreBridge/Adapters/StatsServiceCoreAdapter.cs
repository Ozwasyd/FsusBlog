using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.CoreBridge.Adapters;

public sealed class StatsServiceCoreAdapter(IStatsCoreService core) : IStatsService
{
    public async Task<AdminStatsQueryDto> GetAdminStatsAsync()
    {
        var result = await core.GetAdminStatsAsync();
        if (!result.IsSuccess)
        {
            return new AdminStatsQueryDto();
        }

        return new AdminStatsQueryDto
        {
            Overview = ToOverview(result.Value),
            RecentComments = result.Value.RecentComments.Select(c => new RecentCommentStatItemDto(c.UserId, c.UserName, c.Content, c.CreateTime)).ToList(),
            Regions = result.Value.RegionDistributions.Select(r => new RegionStatItemDto(r.Region, r.Count)).ToList()
        };
    }

    public async Task<AdminStatsOverviewDto> GetAdminStatsOverviewAsync()
        => (await GetAdminStatsAsync()).Overview;

    public async Task<List<RecentCommentStatItemDto>> GetAdminRecentCommentsAsync()
        => (await GetAdminStatsAsync()).RecentComments;

    public async Task<List<RegionStatItemDto>> GetAdminRegionStatsAsync()
        => (await GetAdminStatsAsync()).Regions;

    private static AdminStatsOverviewDto ToOverview(FsusBlog.Core.Mapping.Models.SiteStatsCoreModel value)
    {
        return new AdminStatsOverviewDto
        {
            Summary = new StatsSummaryDto
            {
                TotalArticles = value.TotalArticles,
                TotalComments = value.TotalComments,
                TrashCount = value.TrashCount,
                TotalVisits = value.TotalVisits,
                RegisteredVisits = value.RegisteredVisits,
                AnonymousVisits = value.AnonymousVisits
            },
            PopularArticles = value.PopularArticles.Select(p => new PopularArticleStatItemDto
            (
                p.Id,
                p.Title,
                p.Views
            )).ToList()
        };
    }
}
