using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Interfaces;
using VisitLogEntity = FsusBlog.Server.Entities.VisitLog;

namespace FsusBlog.Server.Services.VisitLog;

public interface IArticleViewProjectionService
{
    Task ApplyAsync(IReadOnlyList<VisitLogEntity> batch, CancellationToken cancellationToken);
}

public sealed class ArticleViewProjectionService(
    IArticleService articleService,
    ICacheInvalidationDispatcher dispatcher,
    PublicHotArtifactUpdateQueue publicHotUpdates,
    ILogger<ArticleViewProjectionService> logger) : IArticleViewProjectionService
{
    public async Task ApplyAsync(IReadOnlyList<VisitLogEntity> batch, CancellationToken cancellationToken)
    {
        var articleCounts = batch
            .Where(static item => item.EventType == HumanReadEventTypes.ArticleRead && item.ArticleId is > 0)
            .GroupBy(static item => item.ArticleId!.Value)
            .Select(static group => (ArticleId: group.Key, Count: group.Count()))
            .ToArray();
        if (articleCounts.Length == 0)
        {
            return;
        }

        foreach ((int articleId, int count) in articleCounts)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await articleService.IncreaseViewCountAsync(articleId, count);
            await dispatcher.InvalidateArticleViewAsync(articleId, cancellationToken);
            if (!publicHotUpdates.TryEnqueue(articleId, "article-view-projection"))
            {
                logger.LogWarning("public-hot-read-update-enqueue-failed {ArticleId} {Reason}", articleId, "article-view-projection");
            }
        }
    }
}
