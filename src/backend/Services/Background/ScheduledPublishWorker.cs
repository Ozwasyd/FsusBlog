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
    private static readonly TimeSpan s_interval = TimeSpan.FromMinutes(1);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using PeriodicTimer timer = new(s_interval, timeProvider);
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
                    IArticlePublicMutationFence mutationFence =
                        scope.ServiceProvider.GetRequiredService<IArticlePublicMutationFence>();
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
                        await mutationFence
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
                                    mutationFence,
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

                    await mutationFence
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
            var due = new List<ScheduledPublicationCandidate>();
            using (var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
                """
                SELECT
                    article.id,
                    revision.id AS revision_id,
                    revision.revision_no,
                    rights.id AS rights_snapshot_id,
                    responsibility.id AS responsibility_snapshot_id
                FROM article article
                JOIN article_revision revision ON revision.id = article.current_revision_id
                JOIN article_rights_snapshot rights
                  ON rights.article_id = article.id
                 AND rights.article_revision_id = revision.id
                LEFT JOIN article_responsibility_snapshot responsibility
                  ON responsibility.article_revision_id = revision.id
                WHERE article.id IN (@CandidateArticleIds)
                  AND article.isdeleted = false
                  AND (
                    (article.status = @ScheduledStatus AND article.scheduled_publish_at <= @Now)
                    OR
                    (article.status = @PublishedStatus AND article.pending_publication_at <= @Now)
                  )
                ORDER BY COALESCE(article.pending_publication_at, article.scheduled_publish_at), article.id
                LIMIT @BatchSize
                FOR UPDATE OF article SKIP LOCKED;
                """,
                new SugarParameter("@PublishedStatus", (int)ArticleStatus.Published),
                new SugarParameter("@Now", now),
                new SugarParameter("@ScheduledStatus", (int)ArticleStatus.Scheduled),
                new SugarParameter("@CandidateArticleIds", candidateArticleIds.ToArray()),
                new SugarParameter("@BatchSize", 100)))
            {
                while (await reader.ReadAsync(cancellationToken))
                {
                    due.Add(new ScheduledPublicationCandidate(
                        reader.ReadInt32("id"),
                        reader.ReadInt64("revision_id"),
                        reader.ReadInt32("revision_no"),
                        reader.ReadInt64("rights_snapshot_id"),
                        reader.IsNull("responsibility_snapshot_id")
                            ? null
                            : reader.ReadInt64("responsibility_snapshot_id")));
                }
            }

            if (due.Count == 0)
            {
                return;
            }

            var outboxEvents = new List<ArticleMutationOutboxEvent>(due.Count);
            foreach (ScheduledPublicationCandidate candidate in due)
            {
                ArticleVersionCoordinates published = await ArticlePublicationTransitionWriter.ApplyAsync(
                    db,
                    new ArticlePublicationTransitionRequest(
                        candidate.ArticleId,
                        ArticleVersionCoordinates.Revision(
                            candidate.RevisionId,
                            candidate.RevisionNo,
                            candidate.RightsSnapshotId,
                            candidate.ResponsibilitySnapshotId),
                        ArticleStatus.Published,
                        null,
                        now,
                        ArticlePublicationTransitionKinds.ScheduledPublish),
                    cancellationToken).ConfigureAwait(false);
                claimedArticleIds.Add(candidate.ArticleId);
                outboxEvents.Add(BuildScheduledPublishOutboxEvent(candidate.ArticleId, published, now));
            }
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
              AND (
                (status = @ScheduledStatus AND scheduled_publish_at <= @Now)
                OR
                (status = @PublishedStatus AND pending_publication_at <= @Now)
              )
            ORDER BY COALESCE(pending_publication_at, scheduled_publish_at), id
            LIMIT @BatchSize;
            """,
            new SugarParameter("@ScheduledStatus", (int)ArticleStatus.Scheduled),
            new SugarParameter("@PublishedStatus", (int)ArticleStatus.Published),
            new SugarParameter("@Now", now),
            new SugarParameter("@BatchSize", 100));
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            articleIds.Add(reader.ReadInt32("id"));
        }

        return articleIds;
    }

    private static async Task RecoverAbortedFenceAsync(
        IArticlePublicMutationFence mutationFence,
        ILogger<ScheduledPublishWorker> logger)
    {
        try
        {
            await mutationFence
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
                && ((article.Status == ArticleStatus.Scheduled && article.ScheduledPublishAt <= now)
                    || (article.Status == ArticleStatus.Published && article.PendingPublicationAt <= now)))
            .AnyAsync(cancellationToken);
        return hasBacklog ? 1 : 0;
    }

    private static ArticleMutationOutboxEvent BuildScheduledPublishOutboxEvent(
        int articleId,
        ArticleVersionCoordinates version,
        DateTime now)
        => new()
        {
            EventId = Guid.NewGuid().ToString("N"),
            AggregateId = articleId,
            ArticleRevisionId = version.RevisionId,
            RevisionNo = version.RevisionNo,
            ArticlePublicationId = version.PublicationId,
            PublicationNo = version.PublicationNo,
            EventType = ArticleMutationEventTypes.ScheduledPublished,
            PayloadJson = ArticlePublicationTransitionWriter.BuildOutboxPayload(
                articleId,
                ArticleMutationEventTypes.ScheduledPublished,
                version),
            Status = "pending",
            RetryCount = 0,
            NextRetryAt = now,
            CreatedAt = now
        };

    private sealed record ScheduledPublicationCandidate(
        int ArticleId,
        long RevisionId,
        int RevisionNo,
        long RightsSnapshotId,
        long? ResponsibilitySnapshotId);

    private sealed record ScheduledPublishBatchCommit(
        IReadOnlyList<int> ClaimedArticleIds,
        bool Committed,
        int OutboxInsertCount)
    {
        public static readonly ScheduledPublishBatchCommit Timeout = new(Array.Empty<int>(), false, 0);
    }
}
