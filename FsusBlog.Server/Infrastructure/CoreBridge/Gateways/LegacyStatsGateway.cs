using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;

namespace FsusBlog.Server.Infrastructure.CoreBridge.Gateways;

public sealed class LegacyStatsGateway(StatsService legacy, ICacheManager cacheManager) : ILegacyStatsGateway
{
    public async Task<SiteStatsCoreModel> GetAdminStatsAsync()
    {
        string key = CacheKeyBuilder.AdminStats();
        var result = await cacheManager.GetOrLoadAsync(
            key,
            PodBinaryCodec.TryDecodeSiteStats,
            PodBinaryCodec.EncodeSiteStats,
            _ => LoadAdminStatsAsync(),
            TimeSpan.FromMinutes(10));

        return result.Value;
    }

    private async Task<SiteStatsCoreModel> LoadAdminStatsAsync()
    {
        SiteStatsDto dto = await legacy.GetAdminStatsAsync();

        var popular = new List<PopularArticleCoreModel>(dto.PopularArticles.Count);
        foreach (PopularArticleDto item in dto.PopularArticles)
        {
            var pod = PodProjector.ProjectPopularArticle(item.Id, item.Title, item.Views);
            popular.Add(new PopularArticleCoreModel(pod, item.Id, item.Title, item.Views));
        }

        var recent = new List<RecentCommentCoreModel>(dto.RecentComments.Count);
        foreach (RecentCommentDto item in dto.RecentComments)
        {
            var pod = PodProjector.ProjectRecentComment(item.UserId, item.CreateTime, item.UserName, item.Content, out _);
            recent.Add(new RecentCommentCoreModel(pod, item.UserId, item.UserName, item.Content, item.CreateTime));
        }

        var regions = new List<RegionDistributionCoreModel>(dto.RegionDistributions.Count);
        foreach (RegionDistributionDto item in dto.RegionDistributions)
        {
            var pod = PodProjector.ProjectRegionDistribution(item.Region, item.Count);
            regions.Add(new RegionDistributionCoreModel(pod, item.Region, item.Count));
        }

        var statsPod = PodProjector.ProjectSiteStats(
            dto.TotalArticles,
            dto.TotalComments,
            dto.TrashCount,
            dto.TotalVisits,
            dto.RegisteredVisits,
            dto.AnonymousVisits,
            popular.Count,
            recent.Count,
            regions.Count);

        return new SiteStatsCoreModel(
            statsPod,
            dto.TotalArticles,
            dto.TotalComments,
            dto.TrashCount,
            dto.TotalVisits,
            dto.RegisteredVisits,
            dto.AnonymousVisits,
            popular,
            recent,
            regions);
    }
}
