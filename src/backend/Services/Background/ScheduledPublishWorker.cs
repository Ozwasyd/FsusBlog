using System.Data.Common;
using System.Diagnostics;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Operations;
using SqlSugar;

namespace FsusBlog.Server.Services.Background;

public sealed class ScheduledPublishWorker(
    IServiceScopeFactory scopeFactory,
    ILogger<ScheduledPublishWorker> logger,
    TimeProvider timeProvider,
    ScheduledPublishRuntimeState runtimeState,
    IBackgroundWorkerLease workerLease,
    IActiveReleaseTransactionalCommitGuard transactionalCommitGuard,
    IActiveReleaseCommitGuard? activeReleaseCommitGuard = null) : BackgroundService
{
    internal const string FencedCommitOperationScope = "scheduled-publish";
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(1);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using PeriodicTimer timer = new(Interval, timeProvider);
        while (!stoppingToken.IsCancellationRequested)
        {
            await workerLease.TryRunAsLeaderAsync("scheduled-publish-worker", token => PublishDueArticlesAsync(token), stoppingToken);
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
                    await using ObservedAsyncServiceScope scope = DependencyInjectionScopeTelemetry.CreateAsyncScope(
                        scopeFactory,
                        "scheduled_publish");
                    ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
                    IDbConcurrencyGate dbGate = scope.ServiceProvider.GetRequiredService<IDbConcurrencyGate>();
                    IArticleMutationSideEffectCoordinator mutationSideEffects =
                        scope.ServiceProvider.GetRequiredService<IArticleMutationSideEffectCoordinator>();
                    DateTime now = timeProvider.GetUtcNow().UtcDateTime;
                    if (activeReleaseCommitGuard is not null)
                    {
                        await activeReleaseCommitGuard.EnsureCurrentAsync(cancellationToken).ConfigureAwait(false);
                    }

                    IReadOnlyList<int> candidates = await dbGate.ExecuteAsync(
                        "scheduled-publish-fence-candidates",
                        gateCt => LoadDueArticleIdsAsync(db, now, gateCt),
                        _ => Task.FromResult<IReadOnlyList<int>>(Array.Empty<int>()),
                        cancellationToken);
                    if (candidates.Count == 0)
                    {
                        runtimeState.ReportResult(0, 0, 0);
                        resultForMetrics = "empty";
                        return 0;
                    }

                    ScheduledPublishBatchCommit commit = ScheduledPublishBatchCommit.Timeout;
                    bool fenceEstablished = false;
                    try
                    {
                        await mutationSideEffects
                            .BeginPublicMutationFenceAsync(null, cancellationToken)
                            .ConfigureAwait(false);
                        fenceEstablished = true;

                        commit = await dbGate.ExecuteAsync(
                            "scheduled-publish-batch-commit",
                            gateCt => ClaimDueArticlesAsync(
                                db,
                                now,
                                candidates,
                                logger,
                                transactionalCommitGuard,
                                gateCt),
                            _ => Task.FromResult(ScheduledPublishBatchCommit.Timeout),
                            cancellationToken);
                    }
                    finally
                    {
                        if (fenceEstablished && (!commit.Committed || commit.ClaimedArticleIds.Count == 0))
                        {
                            await RecoverAbortedFenceAsync(
                                    mutationSideEffects,
                                    logger)
                                .ConfigureAwait(false);
                        }
                    }

                    if (!commit.Committed)
                    {
                        runtimeState.ReportResult(0, 1, 1, "batch_commit_failed");
                        failedForMetrics = 1;
                        backlogForMetrics = 1;
                        resultForMetrics = "failed";
                        logger.LogError("Scheduled publish batch commit failed; scheduled rows remain eligible if unchanged.");
                        return 0;
                    }

                    if (commit.ClaimedArticleIds.Count == 0)
                    {
                        runtimeState.ReportResult(0, 0, 0);
                        resultForMetrics = "empty";
                        return 0;
                    }

                    await mutationSideEffects
                        .CommitPublicMutationFenceAsync(
                            null,
                            ArticleMutationEventTypes.ScheduledPublished,
                            CancellationToken.None)
                        .ConfigureAwait(false);

                    int published = commit.ClaimedArticleIds.Count;
                    int backlog = await dbGate.ExecuteAsync(
                        "scheduled-publish-backlog-exists",
                        gateCt => EstimateBacklogAsync(db, now, gateCt),
                        _ => Task.FromResult(1),
                        cancellationToken);
                    runtimeState.ReportResult(
                        published,
                        0,
                        backlog);
                    publishedForMetrics = published;
                    failedForMetrics = 0;
                    backlogForMetrics = backlog;
                    resultForMetrics = "ok";

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

    private static async Task<ScheduledPublishBatchCommit> ClaimDueArticlesAsync(
        ISqlSugarClient db,
        DateTime now,
        IReadOnlyList<int> candidateArticleIds,
        ILogger<ScheduledPublishWorker> logger,
        IActiveReleaseTransactionalCommitGuard transactionalCommitGuard,
        CancellationToken cancellationToken)
    {
        List<int> claimedArticleIds = [];
        int insertedOutboxEvents = 0;
        var tran = await db.Ado.UseTranAsync(async () =>
        {
            using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                       """
                       UPDATE article
                       SET status = @PublishedStatus,
                           published_at = @Now,
                           scheduled_publish_at = NULL
                       WHERE id IN (
                           SELECT id
                           FROM article
                           WHERE id IN (@CandidateArticleIds)
                             AND isdeleted = false
                             AND status = @ScheduledStatus
                             AND scheduled_publish_at <= @Now
                           ORDER BY scheduled_publish_at, id
                           LIMIT @BatchSize
                           FOR UPDATE SKIP LOCKED
                       )
                       RETURNING id;
                       """,
                       new SugarParameter[]
                       {
                           new("@PublishedStatus", (int)ArticleStatus.Published),
                           new("@Now", now),
                           new("@ScheduledStatus", (int)ArticleStatus.Scheduled),
                           new("@CandidateArticleIds", candidateArticleIds.ToArray()),
                           new("@BatchSize", 100)
                       }))
            {
                while (await reader.ReadAsync(cancellationToken))
                {
                    claimedArticleIds.Add(reader.ReadInt32("id"));
                }
            }

            if (claimedArticleIds.Count == 0)
            {
                return;
            }

            List<ArticleMutationOutboxEvent> outboxEvents = claimedArticleIds
                .Select(articleId => BuildScheduledPublishOutboxEvent(articleId, now))
                .ToList();
            insertedOutboxEvents = await db.Insertable(outboxEvents).ExecuteCommandAsync(cancellationToken);
            if (insertedOutboxEvents != claimedArticleIds.Count)
            {
                throw new InvalidOperationException("Scheduled publish outbox batch did not match claimed article count.");
            }

            string mutationKey = string.Create(
                System.Globalization.CultureInfo.InvariantCulture,
                $"scheduled-publish:{now:O}:{claimedArticleIds.Count}:{claimedArticleIds[0]}:{claimedArticleIds[^1]}");
            await transactionalCommitGuard.EnlistAsync(
                db,
                FencedCommitOperationScope,
                mutationKey,
                cancellationToken).ConfigureAwait(false);
        });

        bool committed = TransactionSideEffectGuard.CanPublishAfterCommit(tran, logger, "scheduled-publish-batch-commit");
        return new ScheduledPublishBatchCommit(
            committed ? claimedArticleIds : [],
            committed,
            committed ? insertedOutboxEvents : 0);
    }

    private static async Task<IReadOnlyList<int>> LoadDueArticleIdsAsync(
        ISqlSugarClient db,
        DateTime now,
        CancellationToken cancellationToken)
    {
        var articleIds = new List<int>(100);
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT id
            FROM article
            WHERE isdeleted = false
              AND status = @ScheduledStatus
              AND scheduled_publish_at <= @Now
            ORDER BY scheduled_publish_at, id
            LIMIT @BatchSize;
            """,
            new SugarParameter("@ScheduledStatus", (int)ArticleStatus.Scheduled),
            new SugarParameter("@Now", now),
            new SugarParameter("@BatchSize", 100));
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            articleIds.Add(reader.ReadInt32("id"));
        }

        return articleIds;
    }

    private static async Task RecoverAbortedFenceAsync(
        IArticleMutationSideEffectCoordinator mutationSideEffects,
        ILogger<ScheduledPublishWorker> logger)
    {
        try
        {
            await mutationSideEffects
                .RecoverAbortedPublicMutationFenceAsync(
                    null,
                    "scheduled-publish-fence-aborted",
                    CancellationToken.None)
                .ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            logger.LogWarning(
                ex,
                "Failed to queue rebuild for aborted scheduled publish fence");
        }
    }

    private static async Task<int> EstimateBacklogAsync(ISqlSugarClient db, DateTime now, CancellationToken cancellationToken)
    {
        bool hasBacklog = await db.Queryable<Article>()
            .Where(article => !article.IsDeleted
                && article.Status == ArticleStatus.Scheduled
                && article.ScheduledPublishAt <= now)
            .AnyAsync(cancellationToken);
        return hasBacklog ? 1 : 0;
    }

    private static ArticleMutationOutboxEvent BuildScheduledPublishOutboxEvent(int articleId, DateTime now)
        => new()
        {
            EventId = Guid.NewGuid().ToString("N"),
            AggregateId = articleId,
            EventType = ArticleMutationEventTypes.ScheduledPublished,
            PayloadJson = $"{{\"articleId\":{articleId},\"eventType\":\"scheduled-published\"}}",
            Status = "pending",
            RetryCount = 0,
            NextRetryAt = now,
            CreatedAt = now
        };

    private sealed record ScheduledPublishBatchCommit(
        IReadOnlyList<int> ClaimedArticleIds,
        bool Committed,
        int OutboxInsertCount)
    {
        public static readonly ScheduledPublishBatchCommit Timeout = new(Array.Empty<int>(), false, 0);
    }
}
