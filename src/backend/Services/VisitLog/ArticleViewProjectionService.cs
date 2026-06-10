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
    IHotStatsInvalidationCoalescer hotStatsInvalidation,
    PublicHotArtifactUpdateQueue publicHotUpdates,
    ILogger<ArticleViewProjectionService> logger) : IArticleViewProjectionService
{
    public async Task ApplyAsync(IReadOnlyList<VisitLogEntity> batch, CancellationToken cancellationToken)
    {
        Dictionary<int, int> articleCounts = batch
            .Where(static item => item.EventType == HumanReadEventTypes.ArticleRead && item.ArticleId is > 0)
            .GroupBy(static item => item.ArticleId!.Value)
            .ToDictionary(static group => group.Key, static group => group.Count());
        if (articleCounts.Count == 0)
        {
            return;
        }

        IReadOnlySet<int> updatedArticleIds = await articleService
            .IncreaseViewCountsAsync(articleCounts, cancellationToken)
            .ConfigureAwait(false);
        if (updatedArticleIds.Count == 0)
        {
            return;
        }

        const int MaxPerBatchViewInvalidations = 128;
        int invalidated = 0;
        foreach (int articleId in updatedArticleIds)
        {
            if (invalidated >= MaxPerBatchViewInvalidations)
            {
                logger.LogWarning(
                    "article-view-projection-invalidation-capped {UpdatedCount} {InvalidatedCount}",
                    updatedArticleIds.Count,
                    invalidated);
                break;
            }

            await dispatcher.InvalidateArticleViewAsync(articleId, cancellationToken).ConfigureAwait(false);
            invalidated++;
        }

        hotStatsInvalidation.MarkStatsDirty("article-view-projection");
        hotStatsInvalidation.MarkHotArticlesDirty("article-view-projection");

        if (!publicHotUpdates.TryEnqueue(null, "article-view-projection-batch"))
        {
            logger.LogWarning("public-hot-read-update-enqueue-failed {ArticleId} {Reason}", null, "article-view-projection-batch");
        }
    }
}
