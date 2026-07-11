using System.Data.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Interfaces;
using SqlSugar;

namespace FsusBlog.Server.Services.Background;

public sealed class ArticleMutationOutboxDispatcher(
    IServiceScopeFactory scopeFactory,
    ILogger<ArticleMutationOutboxDispatcher> logger,
    TimeProvider timeProvider,
    IBackgroundWorkerLease workerLease,
    IActiveReleaseCommitGuard? activeReleaseCommitGuard = null) : BackgroundService
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
            await EnsureCurrentGenerationAsync(cancellationToken).ConfigureAwait(false);
            List<ArticleMutationOutboxEvent> pending = await dbGate.ExecuteAsync(
                "article-outbox-batch-claim",
                gateCt => ClaimPendingOutboxEventsAsync(db, now, now.AddMinutes(5), gateCt),
                _ => Task.FromResult(new List<ArticleMutationOutboxEvent>()),
                cancellationToken).ConfigureAwait(false);
            if (pending.Count == 0)
            {
                return 0;
            }

            Dictionary<long, HashSet<string>> completedEdgesByOutboxId = await LoadCompletedEdgesByOutboxIdAsync(
                    db,
                    dbGate,
                    pending.Select(static item => item.Id).ToArray(),
                    cancellationToken)
                .ConfigureAwait(false);
            Dictionary<int, ArticleMutationAotScope> aotScopesByArticleId = await LoadAotScopesByArticleIdAsync(
                    db,
                    dbGate,
                    pending.Select(static item => item.AggregateId).Where(static articleId => articleId > 0).Distinct().ToArray(),
                    cancellationToken)
                .ConfigureAwait(false);

            int processed = 0;
            foreach (ArticleMutationOutboxEvent item in pending)
            {
                cancellationToken.ThrowIfCancellationRequested();
                completedEdgesByOutboxId.TryGetValue(item.Id, out HashSet<string>? completedEdges);
                aotScopesByArticleId.TryGetValue(item.AggregateId, out ArticleMutationAotScope? aotScope);
                bool ok = await ProcessOneAsync(
                        db,
                        dbGate,
                        cacheInvalidation,
                        publicAotInvalidation,
                        coordinator,
                        item,
                        completedEdges ?? [],
                        aotScope ?? ArticleMutationAotScope.Empty,
                        cancellationToken)
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
        IReadOnlySet<string> completedEdges,
        ArticleMutationAotScope aotScope,
        CancellationToken cancellationToken)
    {
        try
        {
            var completedAfterReplay = new HashSet<string>(completedEdges, StringComparer.Ordinal);

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

            await EnsureCurrentGenerationAsync(cancellationToken).ConfigureAwait(false);
            ArticleMutationReplayResult replay = await coordinator.ReplayOutboxAsync(item.AggregateId, item.EventType, completedAfterReplay, cancellationToken)
                .ConfigureAwait(false);
            await EnsureCurrentGenerationAsync(cancellationToken).ConfigureAwait(false);
            await UpsertReplayEdgesAsync(db, dbGate, item.Id, replay, cancellationToken)
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
            await EnsureCurrentGenerationAsync(cancellationToken).ConfigureAwait(false);
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
        catch (ActiveReleaseFenceLostException)
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
            await EnsureCurrentGenerationAsync(cancellationToken).ConfigureAwait(false);
            await action(cancellationToken).ConfigureAwait(false);
            completedAfterReplay.Add(edgeName);
            await EnsureCurrentGenerationAsync(cancellationToken).ConfigureAwait(false);
            await UpsertReplayEdgesAsync(
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
        catch (ActiveReleaseFenceLostException)
        {
            throw;
        }
        catch (Exception ex)
        {
            string error = NormalizeLastError(ex.Message);
            await UpsertReplayEdgesAsync(
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
        await EnsureCurrentGenerationAsync(cancellationToken).ConfigureAwait(false);
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

    private Task EnsureCurrentGenerationAsync(CancellationToken cancellationToken)
        => activeReleaseCommitGuard?.EnsureCurrentAsync(cancellationToken) ?? Task.CompletedTask;

    private static async Task<List<ArticleMutationOutboxEvent>> ClaimPendingOutboxEventsAsync(
        ISqlSugarClient db,
        DateTime claimNow,
        DateTime claimDeadline,
        CancellationToken cancellationToken)
    {
        var claimed = new List<ArticleMutationOutboxEvent>(BatchSize);
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            UPDATE article_mutation_outbox
            SET status = 'processing',
                next_retry_at = @ClaimDeadline
            WHERE id IN (
                SELECT id
                FROM article_mutation_outbox
                WHERE aggregate_type = 'article'
                  AND (status = 'pending' OR status = 'processing')
                  AND next_retry_at <= @ClaimNow
                ORDER BY id
                LIMIT @BatchSize
                FOR UPDATE SKIP LOCKED
            )
            RETURNING id,
                      event_id,
                      aggregate_type,
                      aggregate_id,
                      event_type,
                      payload_json,
                      status,
                      retry_count,
                      next_retry_at,
                      created_at,
                      processed_at,
                      last_error;
            """,
            new SugarParameter[]
            {
                new("@ClaimNow", claimNow),
                new("@ClaimDeadline", claimDeadline),
                new("@BatchSize", BatchSize)
            });
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            claimed.Add(new ArticleMutationOutboxEvent
            {
                Id = reader.GetInt64(0),
                EventId = reader.GetString(1),
                AggregateType = reader.GetString(2),
                AggregateId = reader.GetInt32(3),
                EventType = reader.GetString(4),
                PayloadJson = reader.GetString(5),
                Status = reader.GetString(6),
                RetryCount = reader.GetInt32(7),
                NextRetryAt = reader.GetDateTime(8),
                CreatedAt = reader.GetDateTime(9),
                ProcessedAt = reader.IsDBNull(10) ? null : reader.GetDateTime(10),
                LastError = reader.IsDBNull(11) ? null : reader.GetString(11)
            });
        }

        return claimed;
    }

    private static async Task<Dictionary<long, HashSet<string>>> LoadCompletedEdgesByOutboxIdAsync(
        ISqlSugarClient db,
        IDbConcurrencyGate dbGate,
        IReadOnlyCollection<long> outboxEventIds,
        CancellationToken cancellationToken)
    {
        if (outboxEventIds.Count == 0)
        {
            return [];
        }

        List<ArticleMutationOutboxEdge> completedEdges = await dbGate.ExecuteAsync(
                "article-outbox-edge-batch-read",
                gateCt => db.Queryable<ArticleMutationOutboxEdge>()
                    .Where(edge => outboxEventIds.Contains(edge.OutboxEventId)
                        && edge.Status == ArticleMutationOutboxEdgeStatus.Completed)
                    .ToListAsync(gateCt),
                _ => Task.FromResult(new List<ArticleMutationOutboxEdge>()),
                cancellationToken)
            .ConfigureAwait(false);

        var result = new Dictionary<long, HashSet<string>>();
        foreach (ArticleMutationOutboxEdge edge in completedEdges)
        {
            if (string.IsNullOrWhiteSpace(edge.EdgeName))
            {
                continue;
            }

            if (!result.TryGetValue(edge.OutboxEventId, out HashSet<string>? edgeNames))
            {
                edgeNames = new HashSet<string>(StringComparer.Ordinal);
                result[edge.OutboxEventId] = edgeNames;
            }

            edgeNames.Add(edge.EdgeName);
        }

        return result;
    }

    private async Task UpsertReplayEdgesAsync(
        ISqlSugarClient db,
        IDbConcurrencyGate dbGate,
        long outboxEventId,
        ArticleMutationReplayResult replay,
        CancellationToken cancellationToken)
    {
        var rows = new List<ArticleMutationOutboxEdgeWrite>(replay.CompletedEdges.Count + replay.FailedEdges.Count);
        foreach (string edgeName in replay.CompletedEdges)
        {
            if (!string.IsNullOrWhiteSpace(edgeName))
            {
                rows.Add(new ArticleMutationOutboxEdgeWrite(
                    outboxEventId,
                    edgeName,
                    ArticleMutationOutboxEdgeStatus.Completed,
                    null));
            }
        }

        foreach (KeyValuePair<string, string> failedEdge in replay.FailedEdges)
        {
            if (!string.IsNullOrWhiteSpace(failedEdge.Key))
            {
                rows.Add(new ArticleMutationOutboxEdgeWrite(
                    outboxEventId,
                    failedEdge.Key,
                    ArticleMutationOutboxEdgeStatus.Failed,
                    failedEdge.Value));
            }
        }

        if (rows.Count == 0)
        {
            return;
        }

        DateTime updatedAt = timeProvider.GetUtcNow().UtcDateTime;
        await dbGate.ExecuteAsync(
            "article-outbox-edge-upsert",
            gateCt => db.Ado.ExecuteCommandAsync(
                BuildReplayEdgeUpsertSql(rows.Count),
                BuildReplayEdgeUpsertParameters(rows, updatedAt)),
            _ => Task.FromResult(0),
            cancellationToken).ConfigureAwait(false);
    }

    private static async Task<Dictionary<int, ArticleMutationAotScope>> LoadAotScopesByArticleIdAsync(
        ISqlSugarClient db,
        IDbConcurrencyGate dbGate,
        IReadOnlyCollection<int> articleIds,
        CancellationToken cancellationToken)
    {
        if (articleIds.Count == 0)
        {
            return [];
        }

        List<ArticleAotCategoryRow> categories = await dbGate.ExecuteAsync(
                "article-outbox-aot-scope-batch-category",
                gateCt => db.Queryable<Article>()
                    .ClearFilter()
                    .Where(article => articleIds.Contains(article.Id))
                    .Select(article => new ArticleAotCategoryRow
                    {
                        ArticleId = article.Id,
                        CategoryId = article.CategoryId
                    })
                    .ToListAsync(gateCt),
                _ => Task.FromResult(new List<ArticleAotCategoryRow>()),
                cancellationToken)
            .ConfigureAwait(false);

        List<ArticleAotTagRow> tags = await dbGate.ExecuteAsync(
                "article-outbox-aot-scope-batch-tags",
                gateCt => db.Queryable<ArticleTag>()
                    .Where(articleTag => articleIds.Contains(articleTag.ArticleId))
                    .Select(articleTag => new ArticleAotTagRow
                    {
                        ArticleId = articleTag.ArticleId,
                        TagId = articleTag.TagId
                    })
                    .ToListAsync(gateCt),
                _ => Task.FromResult(new List<ArticleAotTagRow>()),
                cancellationToken)
            .ConfigureAwait(false);

        var categoryMap = categories.ToDictionary(static row => row.ArticleId, static row => row.CategoryId);
        var tagMap = tags
            .GroupBy(static row => row.ArticleId)
            .ToDictionary(
                static group => group.Key,
                static group => (IReadOnlyList<int>)group.Select(static row => row.TagId).Distinct().ToArray());
        var result = new Dictionary<int, ArticleMutationAotScope>();
        foreach (int articleId in articleIds)
        {
            categoryMap.TryGetValue(articleId, out int categoryId);
            tagMap.TryGetValue(articleId, out IReadOnlyList<int>? tagIds);
            result[articleId] = new ArticleMutationAotScope(
                categoryId > 0 ? [categoryId] : [],
                tagIds ?? []);
        }

        return result;
    }

    private static string BuildReplayEdgeUpsertSql(int count)
    {
        var values = new List<string>(count);
        for (int i = 0; i < count; i++)
        {
            values.Add($"(@OutboxEventId{i}, @EdgeName{i}, @Status{i}, 1, @LastError{i}, @UpdatedAt)");
        }

        return $$"""
            INSERT INTO article_mutation_outbox_edge (
                outbox_event_id,
                edge_name,
                status,
                attempt_count,
                last_error,
                updated_at
            )
            VALUES {{string.Join(", ", values)}}
            ON CONFLICT (outbox_event_id, edge_name) DO UPDATE
            SET status = EXCLUDED.status,
                attempt_count = article_mutation_outbox_edge.attempt_count + EXCLUDED.attempt_count,
                last_error = EXCLUDED.last_error,
                updated_at = EXCLUDED.updated_at;
            """;
    }

    private static SugarParameter[] BuildReplayEdgeUpsertParameters(
        IReadOnlyList<ArticleMutationOutboxEdgeWrite> rows,
        DateTime updatedAt)
    {
        var parameters = new List<SugarParameter>(rows.Count * 4 + 1)
        {
            new("@UpdatedAt", updatedAt)
        };
        for (int i = 0; i < rows.Count; i++)
        {
            ArticleMutationOutboxEdgeWrite row = rows[i];
            parameters.Add(new SugarParameter($"@OutboxEventId{i}", row.OutboxEventId));
            parameters.Add(new SugarParameter($"@EdgeName{i}", row.EdgeName));
            parameters.Add(new SugarParameter($"@Status{i}", row.Status));
            parameters.Add(new SugarParameter($"@LastError{i}", row.LastError is null ? DBNull.Value : NormalizeLastError(row.LastError)));
        }

        return parameters.ToArray();
    }

    private static TimeSpan ComputeBackoff(int retryCount)
        => TimeSpan.FromSeconds(Math.Min(300, Math.Pow(2, Math.Clamp(retryCount, 1, 8))));

    private static string NormalizeLastError(string error)
        => error.Length <= 1024 ? error : error[..1024];

    private sealed record ArticleMutationAotScope(IReadOnlyList<int> CategoryIds, IReadOnlyList<int> TagIds)
    {
        public static readonly ArticleMutationAotScope Empty = new([], []);
    }

    private sealed record ArticleMutationOutboxEdgeWrite(
        long OutboxEventId,
        string EdgeName,
        string Status,
        string? LastError);

    private sealed class ArticleAotCategoryRow
    {
        public int ArticleId { get; set; }

        public int CategoryId { get; set; }
    }

    private sealed class ArticleAotTagRow
    {
        public int ArticleId { get; set; }

        public int TagId { get; set; }
    }
}
