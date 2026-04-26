using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.CoreBridge.Gateways;

public sealed class StatsCoreGateway(StatsService service, IUnifiedCache cache) : IStatsCoreGateway
{
    public async Task<SiteStatsCoreModel> GetAdminStatsAsync()
    {
        const string identity = "core:main";
        var hit = await cache.TryGetAsync(CachePolicyId.AdminStats, identity, DecodeSiteStats);
        if (hit.Hit && hit.Value is not null)
        {
            return hit.Value.GetValueOrDefault();
        }

        SiteStatsCoreModel loaded = await LoadAdminStatsAsync();
        await cache.SetRawAsync(CachePolicyId.AdminStats, identity, PodBinaryCodec.EncodeSiteStats(loaded), TimeSpan.FromMinutes(10));
        return loaded;
    }

    private async Task<SiteStatsCoreModel> LoadAdminStatsAsync()
    {
        AdminStatsOverviewDto overview = await service.GetAdminStatsOverviewAsync();
        List<RecentCommentStatItemDto> recentItems = await service.GetAdminRecentCommentsAsync();
        List<RegionStatItemDto> regionItems = await service.GetAdminRegionStatsAsync();

        var popular = new List<PopularArticleCoreModel>(overview.PopularArticles.Count);
        foreach (PopularArticleStatItemDto item in overview.PopularArticles)
        {
            var pod = PodProjector.ProjectPopularArticle(item.Id, item.Title, item.Views);
            popular.Add(new PopularArticleCoreModel(pod, item.Id, item.Title, item.Views));
        }

        var recent = new List<RecentCommentCoreModel>(recentItems.Count);
        foreach (RecentCommentStatItemDto item in recentItems)
        {
            var pod = PodProjector.ProjectRecentComment(item.UserId, item.CreateTime, item.UserName, item.Content, out _);
            recent.Add(new RecentCommentCoreModel(pod, item.UserId, item.UserName, item.Content, item.CreateTime));
        }

        var regions = new List<RegionDistributionCoreModel>(regionItems.Count);
        foreach (RegionStatItemDto item in regionItems)
        {
            var pod = PodProjector.ProjectRegionDistribution(item.Region, item.Count);
            regions.Add(new RegionDistributionCoreModel(pod, item.Region, item.Count));
        }

        var statsPod = PodProjector.ProjectSiteStats(
            overview.Summary.TotalArticles,
            overview.Summary.TotalComments,
            overview.Summary.TrashCount,
            overview.Summary.TotalVisits,
            overview.Summary.RegisteredVisits,
            overview.Summary.AnonymousVisits,
            popular.Count,
            recent.Count,
            regions.Count);

        return new SiteStatsCoreModel(
            statsPod,
            overview.Summary.TotalArticles,
            overview.Summary.TotalComments,
            overview.Summary.TrashCount,
            overview.Summary.TotalVisits,
            overview.Summary.RegisteredVisits,
            overview.Summary.AnonymousVisits,
            popular,
            recent,
            regions);
    }

    private static (bool Success, SiteStatsCoreModel? Value) DecodeSiteStats(ReadOnlyMemory<byte> bytes)
    {
        bool success = PodBinaryCodec.TryDecodeSiteStats(bytes, out SiteStatsCoreModel value);
        return (success, success ? value : default);
    }
}
