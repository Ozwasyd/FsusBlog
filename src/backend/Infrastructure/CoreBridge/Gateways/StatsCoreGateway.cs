using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Server.Infrastructure.CoreBridge.Caching;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.CoreBridge.Gateways;

public sealed class StatsCoreGateway(StatsService service, StatsCoreQueryCache queryCache) : IStatsCoreGateway
{
    public async Task<SiteStatsCoreModel> GetAdminStatsAsync()
    {
        return await queryCache.GetOrLoadAdminStatsAsync(() => LoadAdminStatsAsync());
    }

    public async Task<IReadOnlyList<RecentCommentCoreModel>> GetAdminRecentCommentsAsync()
        => await queryCache.GetOrLoadAdminRecentCommentsAsync(LoadAdminRecentCommentsAsync);

    public async Task<IReadOnlyList<RegionDistributionCoreModel>> GetAdminRegionStatsAsync()
        => await queryCache.GetOrLoadAdminRegionStatsAsync(LoadAdminRegionStatsAsync);

    private async Task<SiteStatsCoreModel> LoadAdminStatsAsync()
    {
        AdminStatsQueryDto query = await service.GetAdminStatsAsync();
        AdminStatsOverviewDto overview = query.Overview;

        var popular = new List<PopularArticleCoreModel>(overview.PopularArticles.Count);
        foreach (PopularArticleStatItemDto item in overview.PopularArticles)
        {
            var pod = PodProjector.ProjectPopularArticle(item.Id, item.Title, item.Views);
            popular.Add(new PopularArticleCoreModel(pod, item.Id, item.Title, item.Views));
        }

        List<RecentCommentCoreModel> recent = ToRecentCommentCoreModels(query.RecentComments);
        List<RegionDistributionCoreModel> regions = ToRegionDistributionCoreModels(query.Regions);

        var statsPod = PodProjector.ProjectSiteStats(
            overview.Summary.TotalArticles,
            overview.Summary.TotalComments,
            overview.Summary.TrashCount,
            overview.Summary.TotalReads,
            overview.Summary.HumanVerifiedReads,
            overview.Summary.UniqueViewerKeyEstimate,
            overview.Summary.ArticleReads,
            overview.Summary.SiteReads,
            popular.Count,
            recent.Count,
            regions.Count);

        return new SiteStatsCoreModel(
            statsPod,
            overview.Summary.TotalArticles,
            overview.Summary.TotalComments,
            overview.Summary.TrashCount,
            overview.Summary.TotalReads,
            overview.Summary.HumanVerifiedReads,
            overview.Summary.UniqueViewerKeyEstimate,
            overview.Summary.ArticleReads,
            overview.Summary.SiteReads,
            popular,
            recent,
            regions);
    }

    private async Task<IReadOnlyList<RecentCommentCoreModel>> LoadAdminRecentCommentsAsync()
        => ToRecentCommentCoreModels(await service.GetAdminRecentCommentsAsync());

    private async Task<IReadOnlyList<RegionDistributionCoreModel>> LoadAdminRegionStatsAsync()
        => ToRegionDistributionCoreModels(await service.GetAdminRegionStatsAsync());

    private static List<RecentCommentCoreModel> ToRecentCommentCoreModels(IReadOnlyList<RecentCommentStatItemDto> source)
    {
        var recent = new List<RecentCommentCoreModel>(source.Count);
        foreach (RecentCommentStatItemDto item in source)
        {
            var pod = PodProjector.ProjectRecentComment(
                item.CreateTime,
                item.AuthorDisplayName,
                item.AuthorMode,
                item.AuthorBadge,
                item.AuthorScopeLabel,
                item.CredentialLevel,
                item.Content,
                out _);
            recent.Add(new RecentCommentCoreModel(
                pod,
                item.AuthorDisplayName,
                item.AuthorMode,
                item.AuthorBadge,
                item.AuthorScopeLabel,
                item.CredentialLevel,
                item.Content,
                item.CreateTime));
        }

        return recent;
    }

    private static List<RegionDistributionCoreModel> ToRegionDistributionCoreModels(IReadOnlyList<RegionStatItemDto> source)
    {
        var regions = new List<RegionDistributionCoreModel>(source.Count);
        foreach (RegionStatItemDto item in source)
        {
            var pod = PodProjector.ProjectRegionDistribution(item.Region, item.Count);
            regions.Add(new RegionDistributionCoreModel(pod, item.Region, item.Count));
        }

        return regions;
    }
}
