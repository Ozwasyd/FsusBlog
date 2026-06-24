using System.Diagnostics;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Observability;
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
                    IDbConcurrencyGate dbGate = scope.ServiceProvider.GetRequiredService<IDbConcurrencyGate>();
                    DateTime now = timeProvider.GetUtcNow().UtcDateTime;

                    List<Article> due = await dbGate.ExecuteAsync(
                        "scheduled-publish-due-query",
                        gateCt => db.Queryable<Article>()
                            .Where(article => !article.IsDeleted
                                && article.Status == ArticleStatus.Scheduled
                                && article.ScheduledPublishAt <= now)
                            .OrderBy(article => new { article.ScheduledPublishAt, article.Id })
                            .Take(100)
                            .ToListAsync(gateCt),
                        _ => Task.FromResult(new List<Article>()),
                        cancellationToken);
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
                            ScheduledPublishCommit commit = await dbGate.ExecuteAsync(
                                "scheduled-publish-commit",
                                async gateCt =>
                                {
                                    int updatedRows = 0;
                                    string outboxEventId = Guid.NewGuid().ToString("N");
                                    var tran = await db.Ado.UseTranAsync(async () =>
                                    {
                                        updatedRows = await db.Updateable<Article>()
                                            .SetColumns(it => it.Status == ArticleStatus.Published)
                                            .SetColumns(it => it.PublishedAt == now)
                                            .SetColumns(it => it.ScheduledPublishAt == null)
                                            .Where(it => it.Id == article.Id && it.Status == ArticleStatus.Scheduled)
                                            .ExecuteCommandAsync(gateCt);
                                        if (updatedRows > 0)
                                        {
                                            await db.Insertable(BuildScheduledPublishOutboxEvent(article.Id, outboxEventId, now))
                                                .ExecuteCommandAsync(gateCt);
                                        }
                                    });

                                    bool committed = TransactionSideEffectGuard.CanPublishAfterCommit(tran, logger, "scheduled-publish-commit");
                                    return new ScheduledPublishCommit(updatedRows, outboxEventId, committed);
                                },
                                _ => Task.FromResult(ScheduledPublishCommit.Timeout),
                                cancellationToken);
                            if (!commit.Committed)
                            {
                                failed++;
                                logger.LogError("Scheduled publish commit failed for article {ArticleId}; scheduled row remains eligible if unchanged.", article.Id);
                                continue;
                            }

                            if (commit.UpdatedRows == 0)
                            {
                                continue;
                            }

                            article.Status = ArticleStatus.Published;
                            article.PublishedAt = now;
                            article.ScheduledPublishAt = null;
                            published++;
                        }
                        catch (Exception ex) when (ex is not OperationCanceledException)
                        {
                            failed++;
                            logger.LogError(ex, "Scheduled publish failed before durable outbox for article {ArticleId}.", article.Id);
                        }
                    }

                    int backlog = await dbGate.ExecuteAsync(
                        "scheduled-publish-backlog-count",
                        gateCt => db.Queryable<Article>()
                            .Where(article => !article.IsDeleted
                                && article.Status == ArticleStatus.Scheduled
                                && article.ScheduledPublishAt <= now)
                            .CountAsync(gateCt),
                        _ => Task.FromResult(0),
                        cancellationToken);
                    runtimeState.ReportResult(
                        published,
                        failed,
                        backlog,
                        failed > 0 ? "one_or_more_articles_failed" : null);
                    publishedForMetrics = published;
                    failedForMetrics = failed;
                    backlogForMetrics = backlog;
                    resultForMetrics = failed > 0 ? "partial_failure" : "ok";

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

    private static ArticleMutationOutboxEvent BuildScheduledPublishOutboxEvent(int articleId, string eventId, DateTime now)
        => new()
        {
            EventId = eventId,
            AggregateId = articleId,
            EventType = "scheduled-published",
            PayloadJson = $"{{\"articleId\":{articleId},\"eventType\":\"scheduled-published\"}}",
            Status = "pending",
            RetryCount = 0,
            NextRetryAt = now,
            CreatedAt = now
        };

    private sealed record ScheduledPublishCommit(int UpdatedRows, string OutboxEventId, bool Committed)
    {
        public static readonly ScheduledPublishCommit Timeout = new(0, string.Empty, false);
    }
}
