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
    {
        var result = await core.GetAdminRecentCommentsAsync();
        return result.IsSuccess && result.Value is not null
            ? ToRecentComments(result.Value)
            : [];
    }

    public async Task<List<RegionStatItemDto>> GetAdminRegionStatsAsync()
    {
        var result = await core.GetAdminRegionStatsAsync();
        return result.IsSuccess && result.Value is not null
            ? ToRegionStats(result.Value)
            : [];
    }

    private static AdminStatsOverviewDto ToOverview(FsusBlog.Core.Mapping.Models.SiteStatsCoreModel value)
    {
        return new AdminStatsOverviewDto
        {
            Summary = new StatsSummaryDto
            {
                TotalArticles = value.TotalArticles,
                TotalComments = value.TotalComments,
                TrashCount = value.TrashCount,
                TotalReads = value.TotalReads,
                HumanVerifiedReads = value.HumanVerifiedReads,
                UniqueViewerKeyEstimate = value.UniqueViewerKeyEstimate,
                ArticleReads = value.ArticleReads,
                SiteReads = value.SiteReads
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
            items.Add(new RecentCommentStatItemDto(
                item.AuthorDisplayName,
                item.AuthorMode,
                item.AuthorBadge,
                item.AuthorScopeLabel,
                item.CredentialLevel,
                item.Content,
                item.CreateTime));
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
