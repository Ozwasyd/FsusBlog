using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Interfaces;
using SqlSugar;

namespace FsusBlog.Server.Services.Background;

public sealed class ArticleMutationOutboxDispatcher(
    IServiceScopeFactory scopeFactory,
    ILogger<ArticleMutationOutboxDispatcher> logger,
    TimeProvider timeProvider,
    IBackgroundWorkerLease workerLease) : BackgroundService
{
    private const int BatchSize = 50;
    private const int PoisonRetryThreshold = 10;
    private static readonly TimeSpan PollInterval = TimeSpan.FromSeconds(10);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using PeriodicTimer timer = new(PollInterval, timeProvider);
        while (!stoppingToken.IsCancellationRequested)
        {
            await workerLease.TryRunAsLeaderAsync("article-mutation-outbox-dispatcher", token => ProcessPendingAsync(token), stoppingToken)
                .ConfigureAwait(false);
            try
            {
                await timer.WaitForNextTickAsync(stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
        }
    }

    internal async Task<int> ProcessPendingAsync(CancellationToken cancellationToken)
    {
        try
        {
            await using AsyncServiceScope scope = scopeFactory.CreateAsyncScope();
            ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
            IDbConcurrencyGate dbGate = scope.ServiceProvider.GetRequiredService<IDbConcurrencyGate>();
            ICacheInvalidationDispatcher cacheInvalidation = scope.ServiceProvider.GetRequiredService<ICacheInvalidationDispatcher>();
            IPublicAotInvalidationService publicAotInvalidation =
                scope.ServiceProvider.GetRequiredService<IPublicAotInvalidationService>();
            IArticleMutationSideEffectCoordinator coordinator =
                scope.ServiceProvider.GetRequiredService<IArticleMutationSideEffectCoordinator>();

            DateTime now = timeProvider.GetUtcNow().UtcDateTime;
            List<ArticleMutationOutboxEvent> pending = await dbGate.ExecuteAsync(
                "article-outbox-read",
                gateCt => db.Queryable<ArticleMutationOutboxEvent>()
                    .Where(e => e.AggregateType == "article"
                        && (e.Status == "pending" || e.Status == "processing")
                        && e.NextRetryAt <= now)
                    .OrderBy(e => e.Id)
                    .Take(BatchSize)
                    .ToListAsync(gateCt),
                _ => Task.FromResult(new List<ArticleMutationOutboxEvent>()),
                cancellationToken).ConfigureAwait(false);

            int processed = 0;
            foreach (ArticleMutationOutboxEvent item in pending)
            {
                cancellationToken.ThrowIfCancellationRequested();
                bool ok = await ProcessOneAsync(db, dbGate, cacheInvalidation, publicAotInvalidation, coordinator, item, cancellationToken)
                    .ConfigureAwait(false);
                if (ok)
                {
                    processed++;
                }
            }

            return processed;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return 0;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "article-mutation-outbox-dispatcher-failed");
            return 0;
        }
    }

    private async Task<bool> ProcessOneAsync(
        ISqlSugarClient db,
        IDbConcurrencyGate dbGate,
        ICacheInvalidationDispatcher cacheInvalidation,
        IPublicAotInvalidationService publicAotInvalidation,
        IArticleMutationSideEffectCoordinator coordinator,
        ArticleMutationOutboxEvent item,
        CancellationToken cancellationToken)
    {
        DateTime claimNow = timeProvider.GetUtcNow().UtcDateTime;
        DateTime claimDeadline = claimNow.AddMinutes(5);
        int claimed = await dbGate.ExecuteAsync(
            "article-outbox-claim",
            gateCt => db.Updateable<ArticleMutationOutboxEvent>()
                .SetColumns(e => e.Status == "processing")
                .SetColumns(e => e.NextRetryAt == claimDeadline)
                .Where(e => e.Id == item.Id
                    && (e.Status == "pending" || e.Status == "processing")
                    && e.NextRetryAt <= claimNow)
                .ExecuteCommandAsync(gateCt),
            _ => Task.FromResult(0),
            cancellationToken).ConfigureAwait(false);
        if (claimed == 0)
        {
            return false;
        }

        try
        {
            IReadOnlySet<string> completedEdges = await LoadCompletedEdgesAsync(db, dbGate, item.Id, cancellationToken)
                .ConfigureAwait(false);
            var completedAfterReplay = new HashSet<string>(completedEdges, StringComparer.Ordinal);

            ArticleMutationAotScope aotScope = await LoadAotScopeAsync(db, dbGate, item.AggregateId, cancellationToken)
                .ConfigureAwait(false);
            if (!await RunDispatcherEdgeAsync(
                    db,
                    dbGate,
                    item,
                    completedAfterReplay,
                    ArticleMutationReplayEdges.PublicAotInvalidation,
                    ct => publicAotInvalidation.InvalidateArticleMutationAsync(
                        item.AggregateId,
                        aotScope.CategoryIds,
                        aotScope.TagIds,
                        ct),
                    cancellationToken).ConfigureAwait(false)
                || !await RunDispatcherEdgeAsync(
                    db,
                    dbGate,
                    item,
                    completedAfterReplay,
                    ArticleMutationReplayEdges.HttpCacheInvalidation,
                    ct => cacheInvalidation.InvalidateArticleMutationAsync(item.AggregateId, ct),
                    cancellationToken).ConfigureAwait(false))
            {
                return false;
            }

            ArticleMutationReplayResult replay = await coordinator.ReplayOutboxAsync(item.AggregateId, item.EventType, completedEdges, cancellationToken)
                .ConfigureAwait(false);
            await RecordReplayEdgesAsync(db, dbGate, item.Id, replay, cancellationToken)
                .ConfigureAwait(false);
            completedAfterReplay.UnionWith(replay.CompletedEdges);
            bool requiredEdgesComplete = ArticleMutationReplayEdges.Required.All(completedAfterReplay.Contains);
            if (!replay.IsSuccess)
            {
                return await MarkRetryAsync(db, dbGate, item, replay.Error ?? "article mutation replay failed", null, cancellationToken)
                    .ConfigureAwait(false);
            }

            if (!requiredEdgesComplete)
            {
                return await MarkRetryAsync(
                        db,
                        dbGate,
                        item,
                        "article mutation replay required edge incomplete",
                        null,
                        cancellationToken)
                    .ConfigureAwait(false);
            }

            DateTime processedAt = timeProvider.GetUtcNow().UtcDateTime;
            await dbGate.ExecuteAsync(
                "article-outbox-complete",
                gateCt => db.Updateable<ArticleMutationOutboxEvent>()
                    .SetColumns(e => e.Status == "processed")
                    .SetColumns(e => e.ProcessedAt == processedAt)
                    .SetColumns(e => e.LastError == null)
                    .Where(e => e.Id == item.Id)
                    .ExecuteCommandAsync(gateCt),
                _ => Task.FromResult(0),
                cancellationToken).ConfigureAwait(false);
            return true;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            return await MarkRetryAsync(db, dbGate, item, ex.Message, ex, cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task<bool> RunDispatcherEdgeAsync(
        ISqlSugarClient db,
        IDbConcurrencyGate dbGate,
        ArticleMutationOutboxEvent item,
        HashSet<string> completedAfterReplay,
        string edgeName,
        Func<CancellationToken, Task> action,
        CancellationToken cancellationToken)
    {
        if (completedAfterReplay.Contains(edgeName))
        {
            return true;
        }

        try
        {
            await action(cancellationToken).ConfigureAwait(false);
            completedAfterReplay.Add(edgeName);
            await RecordReplayEdgesAsync(
                    db,
                    dbGate,
                    item.Id,
                    ArticleMutationReplayResult.Success(new HashSet<string>(StringComparer.Ordinal) { edgeName }),
                    cancellationToken)
                .ConfigureAwait(false);
            return true;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            string error = NormalizeLastError(ex.Message);
            await RecordReplayEdgesAsync(
                    db,
                    dbGate,
                    item.Id,
                    ArticleMutationReplayResult.Failed(
                        error,
                        new HashSet<string>(StringComparer.Ordinal),
                        new Dictionary<string, string>(StringComparer.Ordinal) { [edgeName] = error }),
                    cancellationToken)
                .ConfigureAwait(false);
            return await MarkRetryAsync(db, dbGate, item, error, ex, cancellationToken).ConfigureAwait(false);
        }
    }

    private async Task<bool> MarkRetryAsync(
        ISqlSugarClient db,
        IDbConcurrencyGate dbGate,
        ArticleMutationOutboxEvent item,
        string error,
        Exception? exception,
        CancellationToken cancellationToken)
    {
        int nextRetryCount = item.RetryCount + 1;
        string status = nextRetryCount >= PoisonRetryThreshold ? "poison" : "pending";
        DateTime nextRetryAt = timeProvider.GetUtcNow().UtcDateTime.Add(ComputeBackoff(nextRetryCount));
        string lastError = NormalizeLastError(error);
        int updatedRows = await dbGate.ExecuteAsync(
            "article-outbox-retry",
            gateCt => db.Ado.ExecuteCommandAsync(
                """
                UPDATE article_mutation_outbox
                SET retry_count = retry_count + 1,
                    status = CASE
                        WHEN retry_count + 1 >= @PoisonRetryThreshold THEN 'poison'
                        ELSE 'pending'
                    END,
                    next_retry_at = @NextRetryAt,
                    last_error = @LastError
                WHERE id = @Id
                  AND retry_count = @ExpectedRetryCount
                  AND status = 'processing';
                """,
                new SugarParameter("@Id", item.Id),
                new SugarParameter("@ExpectedRetryCount", item.RetryCount),
                new SugarParameter("@PoisonRetryThreshold", PoisonRetryThreshold),
                new SugarParameter("@NextRetryAt", nextRetryAt),
                new SugarParameter("@LastError", lastError)),
            _ => Task.FromResult(0),
            cancellationToken).ConfigureAwait(false);
        if (updatedRows == 0)
        {
            logger.LogWarning(
                "article-mutation-outbox-retry-stale {OutboxId} {ArticleId} {EventType} {ExpectedRetryCount} {Error}",
                item.Id,
                item.AggregateId,
                item.EventType,
                item.RetryCount,
                lastError);
            return false;
        }

        logger.LogWarning(
            exception,
            "article-mutation-outbox-retry {OutboxId} {ArticleId} {EventType} {RetryCount} {Status} {Error}",
            item.Id,
            item.AggregateId,
            item.EventType,
            nextRetryCount,
            status,
            lastError);
        return false;
    }

    private static async Task<IReadOnlySet<string>> LoadCompletedEdgesAsync(
        ISqlSugarClient db,
        IDbConcurrencyGate dbGate,
        long outboxEventId,
        CancellationToken cancellationToken)
    {
        List<ArticleMutationOutboxEdge> completedEdges = await dbGate.ExecuteAsync(
                "article-outbox-edge-read",
                gateCt => db.Queryable<ArticleMutationOutboxEdge>()
                    .Where(edge => edge.OutboxEventId == outboxEventId
                        && edge.Status == ArticleMutationOutboxEdgeStatus.Completed)
                    .ToListAsync(gateCt),
                _ => Task.FromResult(new List<ArticleMutationOutboxEdge>()),
                cancellationToken)
            .ConfigureAwait(false);

        return completedEdges
            .Select(static edge => edge.EdgeName)
            .Where(static edgeName => !string.IsNullOrWhiteSpace(edgeName))
            .ToHashSet(StringComparer.Ordinal);
    }

    private async Task RecordReplayEdgesAsync(
        ISqlSugarClient db,
        IDbConcurrencyGate dbGate,
        long outboxEventId,
        ArticleMutationReplayResult replay,
        CancellationToken cancellationToken)
    {
        foreach (string edgeName in replay.CompletedEdges)
        {
            await RecordReplayEdgeAsync(
                    db,
                    dbGate,
                    outboxEventId,
                    edgeName,
                    ArticleMutationOutboxEdgeStatus.Completed,
                    null,
                    incrementAttempt: true,
                    cancellationToken)
                .ConfigureAwait(false);
        }

        foreach (KeyValuePair<string, string> failedEdge in replay.FailedEdges)
        {
            await RecordReplayEdgeAsync(
                    db,
                    dbGate,
                    outboxEventId,
                    failedEdge.Key,
                    ArticleMutationOutboxEdgeStatus.Failed,
                    failedEdge.Value,
                    incrementAttempt: true,
                    cancellationToken)
                .ConfigureAwait(false);
        }
    }

    private async Task RecordReplayEdgeAsync(
        ISqlSugarClient db,
        IDbConcurrencyGate dbGate,
        long outboxEventId,
        string edgeName,
        string status,
        string? lastError,
        bool incrementAttempt,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(edgeName))
        {
            return;
        }

        string operation = status == ArticleMutationOutboxEdgeStatus.Completed
            ? "article-outbox-edge-complete"
            : "article-outbox-edge-failed";
        DateTime updatedAt = timeProvider.GetUtcNow().UtcDateTime;
        string? normalizedError = lastError is null ? null : NormalizeLastError(lastError);
        await dbGate.ExecuteAsync(
            operation,
            async gateCt =>
            {
                ArticleMutationOutboxEdge? existing = await db.Queryable<ArticleMutationOutboxEdge>()
                    .Where(edge => edge.OutboxEventId == outboxEventId && edge.EdgeName == edgeName)
                    .FirstAsync(gateCt)
                    .ConfigureAwait(false);
                if (existing is null)
                {
                    await db.Insertable(new ArticleMutationOutboxEdge
                        {
                            OutboxEventId = outboxEventId,
                            EdgeName = edgeName,
                            Status = status,
                            AttemptCount = incrementAttempt ? 1 : 0,
                            LastError = normalizedError,
                            UpdatedAt = updatedAt
                        })
                        .ExecuteCommandAsync(gateCt)
                        .ConfigureAwait(false);
                    return 1;
                }

                int nextAttemptCount = incrementAttempt ? existing.AttemptCount + 1 : existing.AttemptCount;
                return await db.Updateable<ArticleMutationOutboxEdge>()
                    .SetColumns(edge => edge.Status == status)
                    .SetColumns(edge => edge.AttemptCount == nextAttemptCount)
                    .SetColumns(edge => edge.LastError == normalizedError)
                    .SetColumns(edge => edge.UpdatedAt == updatedAt)
                    .Where(edge => edge.Id == existing.Id)
                    .ExecuteCommandAsync(gateCt)
                    .ConfigureAwait(false);
            },
            _ => Task.FromResult(0),
            cancellationToken).ConfigureAwait(false);
    }

    private static async Task<ArticleMutationAotScope> LoadAotScopeAsync(
        ISqlSugarClient db,
        IDbConcurrencyGate dbGate,
        int articleId,
        CancellationToken cancellationToken)
    {
        if (articleId <= 0)
        {
            return ArticleMutationAotScope.Empty;
        }

        int categoryId = await dbGate.ExecuteAsync(
                "article-outbox-aot-scope-category",
                gateCt => db.Queryable<Article>()
                    .ClearFilter()
                    .Where(article => article.Id == articleId)
                    .Select(article => article.CategoryId)
                    .FirstAsync(gateCt),
                _ => Task.FromResult(0),
                cancellationToken)
            .ConfigureAwait(false);

        List<int> tagIds = await dbGate.ExecuteAsync(
                "article-outbox-aot-scope-tags",
                gateCt => db.Queryable<ArticleTag>()
                    .Where(articleTag => articleTag.ArticleId == articleId)
                    .Select(articleTag => articleTag.TagId)
                    .ToListAsync(gateCt),
                _ => Task.FromResult(new List<int>()),
                cancellationToken)
            .ConfigureAwait(false);

        return new ArticleMutationAotScope(
            categoryId > 0 ? [categoryId] : [],
            tagIds);
    }

    private static TimeSpan ComputeBackoff(int retryCount)
        => TimeSpan.FromSeconds(Math.Min(300, Math.Pow(2, Math.Clamp(retryCount, 1, 8))));

    private static string NormalizeLastError(string error)
        => error.Length <= 1024 ? error : error[..1024];

    private sealed record ArticleMutationAotScope(IReadOnlyList<int> CategoryIds, IReadOnlyList<int> TagIds)
    {
        public static readonly ArticleMutationAotScope Empty = new([], []);
    }
}
