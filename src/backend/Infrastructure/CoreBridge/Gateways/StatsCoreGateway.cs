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

        var recent = new List<RecentCommentCoreModel>(query.RecentComments.Count);
        foreach (RecentCommentStatItemDto item in query.RecentComments)
        {
            var pod = PodProjector.ProjectRecentComment(item.UserId, item.CreateTime, item.UserName, item.Content, out _);
            recent.Add(new RecentCommentCoreModel(pod, item.UserId, item.UserName, item.Content, item.CreateTime));
        }

        var regions = new List<RegionDistributionCoreModel>(query.Regions.Count);
        foreach (RegionStatItemDto item in query.Regions)
        {
            var pod = PodProjector.ProjectRegionDistribution(item.Region, item.Count);
            regions.Add(new RegionDistributionCoreModel(pod, item.Region, item.Count));
        }

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
}
