using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.CoreBridge.Adapters;

public sealed class StatsServiceCoreAdapter(IStatsCoreService core) : IStatsService
{
    public async Task<AdminStatsOverviewDto> GetAdminStatsOverviewAsync()
    {
        var result = await core.GetAdminStatsAsync();
        if (!result.IsSuccess)
        {
            return new AdminStatsOverviewDto();
        }

        return new AdminStatsOverviewDto
        {
            Summary = new StatsSummaryDto
            {
                TotalArticles = result.Value.TotalArticles,
                TotalComments = result.Value.TotalComments,
                TrashCount = result.Value.TrashCount,
                TotalVisits = result.Value.TotalVisits,
                RegisteredVisits = result.Value.RegisteredVisits,
                AnonymousVisits = result.Value.AnonymousVisits
            },
            PopularArticles = result.Value.PopularArticles.Select(p => new PopularArticleStatItemDto
            (
                p.Id,
                p.Title,
                p.Views
            )).ToList()
        };
    }

    public async Task<List<RecentCommentStatItemDto>> GetAdminRecentCommentsAsync()
    {
        var result = await core.GetAdminStatsAsync();
        return !result.IsSuccess
            ? []
            : result.Value.RecentComments.Select(c => new RecentCommentStatItemDto(c.UserId, c.UserName, c.Content, c.CreateTime)).ToList();
    }

    public async Task<List<RegionStatItemDto>> GetAdminRegionStatsAsync()
    {
        var result = await core.GetAdminStatsAsync();
        return !result.IsSuccess
            ? []
            : result.Value.RegionDistributions.Select(r => new RegionStatItemDto(r.Region, r.Count)).ToList();
    }
}
