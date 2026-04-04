using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;

namespace FsusBlog.Server.Infrastructure.CoreBridge.Adapters;

public sealed class StatsServiceCoreAdapter(IStatsCoreService core) : IStatsService
{
    public async Task<SiteStatsDto> GetAdminStatsAsync()
    {
        var result = await core.GetAdminStatsAsync();
        if (!result.IsSuccess)
        {
            return new SiteStatsDto();
        }

        return new SiteStatsDto
        {
            TotalArticles = result.Value.TotalArticles,
            TotalComments = result.Value.TotalComments,
            TrashCount = result.Value.TrashCount,
            TotalVisits = result.Value.TotalVisits,
            RegisteredVisits = result.Value.RegisteredVisits,
            AnonymousVisits = result.Value.AnonymousVisits,
            PopularArticles = result.Value.PopularArticles.Select(p => new PopularArticleDto
            {
                Id = p.Id,
                Title = p.Title,
                Views = p.Views
            }).ToList(),
            RecentComments = result.Value.RecentComments.Select(c => new RecentCommentDto
            {
                UserId = c.UserId,
                UserName = c.UserName,
                Content = c.Content,
                CreateTime = c.CreateTime
            }).ToList(),
            RegionDistributions = result.Value.RegionDistributions.Select(r => new RegionDistributionDto
            {
                Region = r.Region,
                Count = r.Count
            }).ToList()
        };
    }
}
