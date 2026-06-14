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
            RecentComments = ToRecentComments(result.Value.RecentComments),
            Regions = ToRegionStats(result.Value.RegionDistributions)
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
            PopularArticles = ToPopularArticles(value.PopularArticles)
        };
    }

    private static List<RecentCommentStatItemDto> ToRecentComments(IReadOnlyList<FsusBlog.Core.Mapping.Models.RecentCommentCoreModel> source)
    {
        var items = new List<RecentCommentStatItemDto>(source.Count);
        for (int i = 0; i < source.Count; i++)
        {
            var item = source[i];
            items.Add(new RecentCommentStatItemDto(item.UserId, item.UserName, item.Content, item.CreateTime));
        }

        return items;
    }

    private static List<RegionStatItemDto> ToRegionStats(IReadOnlyList<FsusBlog.Core.Mapping.Models.RegionDistributionCoreModel> source)
    {
        var items = new List<RegionStatItemDto>(source.Count);
        for (int i = 0; i < source.Count; i++)
        {
            var item = source[i];
            items.Add(new RegionStatItemDto(item.Region, item.Count));
        }

        return items;
    }

    private static List<PopularArticleStatItemDto> ToPopularArticles(IReadOnlyList<FsusBlog.Core.Mapping.Models.PopularArticleCoreModel> source)
    {
        var items = new List<PopularArticleStatItemDto>(source.Count);
        for (int i = 0; i < source.Count; i++)
        {
            var item = source[i];
            items.Add(new PopularArticleStatItemDto(item.Id, item.Title, item.Views));
        }

        return items;
    }
}
