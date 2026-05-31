using System.Diagnostics;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Interfaces;
using SqlSugar;

namespace FsusBlog.Server.Services.Background;

public sealed class ScheduledPublishWorker(
    IServiceScopeFactory scopeFactory,
    ILogger<ScheduledPublishWorker> logger,
    TimeProvider timeProvider,
    ScheduledPublishRuntimeState runtimeState) : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(1);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using PeriodicTimer timer = new(Interval, timeProvider);
        while (!stoppingToken.IsCancellationRequested)
        {
            await PublishDueArticlesAsync(stoppingToken);
            try
            {
                await timer.WaitForNextTickAsync(stoppingToken);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
        }
    }

    internal async Task<int> PublishDueArticlesAsync(CancellationToken cancellationToken)
    {
        long startedAt = Stopwatch.GetTimestamp();
        int publishedForMetrics = 0;
        int failedForMetrics = 0;
        int backlogForMetrics = 0;
        string resultForMetrics = "ok";
        using Activity? activity = FsusObservability.StartActivity("background.scheduled_publish", "background");
        FsusObservability.SetTag(activity, "fsus.background.job", "scheduled_publish");
        try
        {
            return await BoundaryExecutor.ExecuteValueAsync(
                async () =>
                {
                    await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
                    ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
                    ICacheInvalidationDispatcher invalidation = scope.ServiceProvider.GetRequiredService<ICacheInvalidationDispatcher>();
                    ISearchIndexService searchIndex = scope.ServiceProvider.GetRequiredService<ISearchIndexService>();
                    PublicHotArtifactUpdateQueue publicHotUpdates = scope.ServiceProvider.GetRequiredService<PublicHotArtifactUpdateQueue>();
                    DateTime now = timeProvider.GetUtcNow().UtcDateTime;

                    List<Article> due = await db.Queryable<Article>()
                        .Where(article => !article.IsDeleted
                            && article.Status == ArticleStatus.Scheduled
                            && article.ScheduledPublishAt <= now)
                        .Take(100)
                        .ToListAsync(cancellationToken);
                    if (due.Count == 0)
                    {
                        runtimeState.ReportResult(0, 0, 0);
                        resultForMetrics = "empty";
                        return 0;
                    }

                    int published = 0;
                    int failed = 0;
                    foreach (Article article in due)
                    {
                        try
                        {
                            int updated = await db.Updateable<Article>()
                                .SetColumns(it => it.Status == ArticleStatus.Published)
                                .SetColumns(it => it.PublishedAt == now)
                                .SetColumns(it => it.ScheduledPublishAt == null)
                                .Where(it => it.Id == article.Id && it.Status == ArticleStatus.Scheduled)
                                .ExecuteCommandAsync(cancellationToken);
                            if (updated == 0)
                            {
                                continue;
                            }

                            article.Status = ArticleStatus.Published;
                            article.PublishedAt = now;
                            article.ScheduledPublishAt = null;
                            article.Content = await db.Queryable<ArticleBody>()
                                .Where(it => it.ArticleId == article.Id)
                                .Select(it => it.MarkdownContent)
                                .FirstAsync(cancellationToken) ?? string.Empty;
                            await searchIndex.AddOrUpdateIndexAsync(article);
                            await invalidation.InvalidateArticleMutationAsync(article.Id, cancellationToken);
                            published++;
                        }
                        catch (Exception ex) when (ex is not OperationCanceledException)
                        {
                            failed++;
                            logger.LogError(ex, "Scheduled publish failed for article {ArticleId}; it remains scheduled for retry.", article.Id);
                        }
                    }

                    int backlog = await db.Queryable<Article>()
                        .Where(article => !article.IsDeleted
                            && article.Status == ArticleStatus.Scheduled
                            && article.ScheduledPublishAt <= now)
                        .CountAsync(cancellationToken);
                    runtimeState.ReportResult(
                        published,
                        failed,
                        backlog,
                        failed > 0 ? "one_or_more_articles_failed" : null);
                    publishedForMetrics = published;
                    failedForMetrics = failed;
                    backlogForMetrics = backlog;
                    resultForMetrics = failed > 0 ? "partial_failure" : "ok";
                    if (published > 0 && !publicHotUpdates.TryEnqueue(null, "scheduled-publish"))
                    {
                        logger.LogWarning("public-hot-read-update-enqueue-failed {Reason}", "scheduled-publish");
                    }

                    return published;
                },
                ex =>
                {
                    logger.LogError(ex, "Scheduled publish worker failed.");
                    runtimeState.ReportFailure(ex.GetType().Name);
                    resultForMetrics = "failed";
                    return 0;
                },
                logger,
                "scheduled-publish-worker",
                LogLevel.Error);
        }
        finally
        {
            FsusObservability.SetTag(activity, "fsus.result", resultForMetrics);
            FsusObservability.RecordBackgroundJob(
                "scheduled_publish",
                resultForMetrics,
                FsusObservability.GetElapsed(startedAt),
                publishedForMetrics,
                failedForMetrics,
                backlogForMetrics);
        }
    }
}
