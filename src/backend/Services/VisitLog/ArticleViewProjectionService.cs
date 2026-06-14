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
        int invalidated = await InvalidateArticleViewsAsync(
            updatedArticleIds,
            MaxPerBatchViewInvalidations,
            cancellationToken).ConfigureAwait(false);
        if (invalidated < updatedArticleIds.Count)
        {
            logger.LogWarning(
                "article-view-projection-invalidation-capped {UpdatedCount} {InvalidatedCount}",
                updatedArticleIds.Count,
                invalidated);
        }

        hotStatsInvalidation.MarkStatsDirty("article-view-projection");
        hotStatsInvalidation.MarkHotArticlesDirty("article-view-projection");

        if (!publicHotUpdates.TryEnqueue(null, "article-view-projection-batch"))
        {
            logger.LogWarning("public-hot-read-update-enqueue-failed {ArticleId} {Reason}", null, "article-view-projection-batch");
        }
    }

    private async Task<int> InvalidateArticleViewsAsync(
        IReadOnlySet<int> articleIds,
        int maxPerBatchViewInvalidations,
        CancellationToken cancellationToken)
    {
        int limit = Math.Min(articleIds.Count, maxPerBatchViewInvalidations);
        var tasks = new List<Task>(limit);
        foreach (int articleId in articleIds)
        {
            if (tasks.Count >= limit)
            {
                break;
            }

            cancellationToken.ThrowIfCancellationRequested();
            tasks.Add(dispatcher.InvalidateArticleViewAsync(articleId, cancellationToken));
        }

        await Task.WhenAll(tasks).ConfigureAwait(false);
        return tasks.Count;
    }
}
