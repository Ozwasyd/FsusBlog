using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Interfaces;

namespace FsusBlog.Server.Services.VisitLog;

public interface IArticleViewProjectionService
{
    Task ApplyAsync(IReadOnlyDictionary<int, int> articleCounts, CancellationToken cancellationToken);
}

public sealed class ArticleViewProjectionService(
    IArticleService articleService,
    ICacheInvalidationDispatcher dispatcher,
    IHotStatsInvalidationCoalescer hotStatsInvalidation,
    PublicHotArtifactUpdateQueue publicHotUpdates,
    ILogger<ArticleViewProjectionService> logger) : IArticleViewProjectionService
{
    internal const int MaxPerBatchViewInvalidations = 128;

    public async Task ApplyAsync(IReadOnlyDictionary<int, int> articleCounts, CancellationToken cancellationToken)
    {
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

        await hotStatsInvalidation.MarkStatsDirtyAsync("article-view-projection", cancellationToken).ConfigureAwait(false);
        await hotStatsInvalidation.MarkHotArticlesDirtyAsync("article-view-projection", cancellationToken).ConfigureAwait(false);

        foreach (int articleId in updatedArticleIds)
        {
            if (!publicHotUpdates.TryEnqueue(articleId, "article-view-projection-batch"))
            {
                logger.LogWarning("public-hot-read-update-enqueue-failed {ArticleId} {Reason}", articleId, "article-view-projection-batch");
            }
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
