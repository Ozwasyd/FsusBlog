using System.Data.Common;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Observability;
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
    IActiveReleaseTransactionalCommitGuard transactionalCommitGuard,
    IActiveReleaseCommitGuard? activeReleaseCommitGuard = null,
    IConfiguration? configuration = null) : BackgroundService
{
    internal const string FencedCommitOperationScope = "article-outbox-complete";
    private const int BatchSize = 50;
    private const int PoisonRetryThreshold = 10;
    private static readonly TimeSpan s_pollInterval = TimeSpan.FromSeconds(10);
    private static readonly string s_workerId = BuildWorkerId();

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using PeriodicTimer timer = new(s_pollInterval, timeProvider);
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
        if (configuration?.GetValue<bool?>("ArticleMutationOutbox:Enabled") == false)
        {
            return 0;
        }

        try
        {
            await using ObservedAsyncServiceScope scope = DependencyInjectionScopeTelemetry.CreateAsyncScope(
                scopeFactory,
                "article_outbox_dispatch");
            ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
            IDbConcurrencyGate dbGate = scope.ServiceProvider.GetRequiredService<IDbConcurrencyGate>();
            ICacheInvalidationDispatcher cacheInvalidation = scope.ServiceProvider.GetRequiredService<ICacheInvalidationDispatcher>();
            IPublicAotInvalidationService publicAotInvalidation =
                scope.ServiceProvider.GetRequiredService<IPublicAotInvalidationService>();
            IArticleMutationSideEffectCoordinator coordinator =
                scope.ServiceProvider.GetRequiredService<IArticleMutationSideEffectCoordinator>();

            DateTime now = timeProvider.GetUtcNow().UtcDateTime;
            await EnsureCurrentGenerationAsync(cancellationToken).ConfigureAwait(false);
            string claimToken = Guid.NewGuid().ToString("N");
            TimeSpan claimLease = GetClaimLeaseDuration();
            List<ClaimedArticleMutationOutboxEvent> claimed = await dbGate.ExecuteAsync(
                "article-outbox-batch-claim",
                gateCt => ExecuteFencedMutationAsync(
                    db,
                    "article-outbox-claim",
                    claimToken,
                    transactionToken => ClaimPendingOutboxEventsAsync(
                        db,
                        now,
                        now.Add(claimLease),
                        claimToken,
                        s_workerId,
                        transactionToken),
                    gateCt,
                    static rows => rows.Count > 0),
                _ => Task.FromResult(new List<ClaimedArticleMutationOutboxEvent>()),
                cancellationToken).ConfigureAwait(false);
            if (claimed.Count == 0)
            {
                await DetectStuckClaimsAsync(db, dbGate, now, cancellationToken).ConfigureAwait(false);
                return 0;
            }

            List<ArticleMutationOutboxEvent> pending = claimed.Select(static item => item.Event).ToList();
            int reclaimedCount = claimed.Count(static item => item.WasReclaimed);
            FsusObservability.RecordArticleOutboxClaim(claimed.Count, reclaimedCount);
            await DetectStuckClaimsAsync(db, dbGate, now, cancellationToken).ConfigureAwait(false);

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

            using var heartbeatCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            Task heartbeatTask = MaintainClaimHeartbeatsAsync(claimToken, heartbeatCts.Token);
            int processed = 0;
            try
            {
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
            }
            finally
            {
                await heartbeatCts.CancelAsync().ConfigureAwait(false);
                await heartbeatTask.ConfigureAwait(false);
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
            await EnsureClaimOwnedAsync(db, dbGate, item, cancellationToken).ConfigureAwait(false);
            var completedAfterReplay = new HashSet<string>(completedEdges, StringComparer.Ordinal);
            ArticleMutationOutboxEnvelope envelope = ArticleMutationOutboxEnvelopeCodec.Read(item);
            ArticleMutationVersionDisposition disposition = await ArticleMutationOutboxVersionGuard
                .EvaluateAsync(db, envelope, cancellationToken)
                .ConfigureAwait(false);
            bool processCurrentVersion = await RouteAfterVersionPreflightAsync(
                    disposition,
                    async reason =>
                    {
                        ArticleMutationReplayResult skipped = ArticleMutationReplayResult.ForSupersededPublication(
                            completedAfterReplay,
                            reason);
                        await UpsertReplayEdgesAsync(db, dbGate, item, skipped, cancellationToken).ConfigureAwait(false);
                        completedAfterReplay.UnionWith(skipped.SkippedEdges);
                        if (!ArticleMutationReplayEdges.Required.All(completedAfterReplay.Contains))
                        {
                            return await MarkRetryAsync(
                                    db,
                                    dbGate,
                                    item,
                                    "superseded article mutation did not reach a terminal edge state",
                                    null,
                                    cancellationToken)
                                .ConfigureAwait(false);
                        }

                        logger.LogInformation(
                            "article-mutation-outbox-version-skipped {OutboxId} {EventId} {ArticleId} {Reason}",
                            item.Id,
                            item.EventId,
                            item.AggregateId,
                            reason);
                        await CompleteAsync(db, dbGate, item, cancellationToken).ConfigureAwait(false);
                        return false;
                    },
                    static () => Task.FromResult(true))
                .ConfigureAwait(false);
            if (!processCurrentVersion)
            {
                return disposition.Kind == ArticleMutationVersionDispositionKind.Skip;
            }

            IReadOnlyList<int> categoryIds = envelope.Scope.CategoryIds.Count > 0
                ? envelope.Scope.CategoryIds
                : aotScope.CategoryIds;
            IReadOnlyList<int> tagIds = envelope.Scope.TagIds.Count > 0
                ? envelope.Scope.TagIds
                : aotScope.TagIds;

            if (!await RunDispatcherEdgeAsync(
                    db,
                    dbGate,
                    item,
                    completedAfterReplay,
                    ArticleMutationReplayEdges.PublicAotInvalidation,
                    ct => publicAotInvalidation.InvalidateArticleMutationAsync(
                        item.AggregateId,
                        categoryIds,
                        tagIds,
                        item.EventId,
                        ct),
                    cancellationToken).ConfigureAwait(false)
                || !await RunDispatcherEdgeAsync(
                    db,
                    dbGate,
                    item,
                    completedAfterReplay,
                    ArticleMutationReplayEdges.HttpCacheInvalidation,
                    ct => cacheInvalidation.InvalidateArticleMutationAsync(item.AggregateId, item.EventId, ct),
                    cancellationToken).ConfigureAwait(false))
            {
                return false;
            }

            await EnsureCurrentGenerationAsync(cancellationToken).ConfigureAwait(false);
            await EnsureClaimOwnedAsync(db, dbGate, item, cancellationToken).ConfigureAwait(false);
            ArticleMutationReplayResult replay = await coordinator.ReplayOutboxAsync(
                    item.AggregateId,
                    item.EventType,
                    item.EventId,
                    envelope.Version,
                    completedAfterReplay,
                    cancellationToken)
                .ConfigureAwait(false);
            await EnsureCurrentGenerationAsync(cancellationToken).ConfigureAwait(false);
            await UpsertReplayEdgesAsync(db, dbGate, item, replay, cancellationToken)
                .ConfigureAwait(false);
            completedAfterReplay.UnionWith(replay.CompletedEdges);
            completedAfterReplay.UnionWith(replay.SkippedEdges);
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

            return await CompleteAsync(db, dbGate, item, cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (ActiveReleaseFenceLostException)
        {
            throw;
        }
        catch (ArticleMutationOutboxClaimLostException ex)
        {
            FsusObservability.RecordArticleOutboxClaimLost();
            logger.LogWarning(ex, "article-mutation-outbox-claim-lost {OutboxId} {ArticleId}", item.Id, item.AggregateId);
            return false;
        }
        catch (Exception ex)
        {
            return await MarkRetryAsync(db, dbGate, item, ex.Message, ex, cancellationToken).ConfigureAwait(false);
        }
    }

    internal static Task<T> RouteAfterVersionPreflightAsync<T>(
        ArticleMutationVersionDisposition disposition,
        Func<string, Task<T>> onSkipped,
        Func<Task<T>> onCurrent)
        => disposition.Kind switch
        {
            ArticleMutationVersionDispositionKind.Process => onCurrent(),
            ArticleMutationVersionDispositionKind.Skip => onSkipped(
                disposition.Reason ?? "superseded-by-newer-version"),
            _ => throw new InvalidOperationException(
                disposition.Reason ?? "invalid-article-mutation-version-coordinate")
        };

    private async Task<bool> CompleteAsync(
        ISqlSugarClient db,
        IDbConcurrencyGate dbGate,
        ArticleMutationOutboxEvent item,
        CancellationToken cancellationToken)
    {
        DateTime processedAt = timeProvider.GetUtcNow().UtcDateTime;
        await EnsureCurrentGenerationAsync(cancellationToken).ConfigureAwait(false);
        int completedRows = await dbGate.ExecuteAsync(
            FencedCommitOperationScope,
            gateCt => ExecuteFencedMutationAsync(
                db,
                FencedCommitOperationScope,
                $"{item.Id}:{item.ClaimToken}",
                _ => db.Ado.ExecuteCommandAsync(
                    BuildCompleteSql(),
                    new SugarParameter("@Id", item.Id),
                    new SugarParameter("@ClaimToken", item.ClaimToken),
                    new SugarParameter("@ProcessedAt", processedAt)),
                gateCt,
                static updatedRows => updatedRows > 0),
            _ => Task.FromResult(0),
            cancellationToken).ConfigureAwait(false);
        if (completedRows != 1)
        {
            throw new ArticleMutationOutboxClaimLostException(item.Id);
        }

        return true;
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
            await EnsureClaimOwnedAsync(db, dbGate, item, cancellationToken).ConfigureAwait(false);
            await action(cancellationToken).ConfigureAwait(false);
            completedAfterReplay.Add(edgeName);
            await EnsureCurrentGenerationAsync(cancellationToken).ConfigureAwait(false);
            await UpsertReplayEdgesAsync(
                    db,
                    dbGate,
                    item,
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
                    item,
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
        DateTime transitionAt = timeProvider.GetUtcNow().UtcDateTime;
        DateTime nextRetryAt = transitionAt.Add(ComputeBackoff(nextRetryCount));
        string lastError = NormalizeLastError(error);
        await EnsureCurrentGenerationAsync(cancellationToken).ConfigureAwait(false);
        int updatedRows = await dbGate.ExecuteAsync(
            "article-outbox-retry",
            gateCt => ExecuteFencedMutationAsync(
                db,
                "article-outbox-retry",
                $"{item.Id}:{item.ClaimToken}:{item.RetryCount}",
                _ => db.Ado.ExecuteCommandAsync(
                    """
                    UPDATE article_mutation_outbox
                    SET retry_count = retry_count + 1,
                        status = CASE
                            WHEN retry_count + 1 >= @PoisonRetryThreshold THEN 'poison'
                            ELSE 'pending'
                        END,
                        next_retry_at = @NextRetryAt,
                        last_error = @LastError,
                        claim_token = NULL,
                        claimed_by = NULL,
                        claimed_at = NULL,
                        heartbeat_at = NULL,
                        claim_expires_at = NULL
                    WHERE id = @Id
                      AND retry_count = @ExpectedRetryCount
                      AND status = 'processing'
                      AND claim_token = @ClaimToken
                      AND claim_expires_at > @TransitionAt;
                    """,
                    new SugarParameter("@Id", item.Id),
                    new SugarParameter("@ExpectedRetryCount", item.RetryCount),
                    new SugarParameter("@ClaimToken", item.ClaimToken),
                    new SugarParameter("@TransitionAt", transitionAt),
                    new SugarParameter("@PoisonRetryThreshold", PoisonRetryThreshold),
                    new SugarParameter("@NextRetryAt", nextRetryAt),
                    new SugarParameter("@LastError", lastError)),
                gateCt,
                static updatedRows => updatedRows > 0),
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

    private async Task<T> ExecuteFencedMutationAsync<T>(
        ISqlSugarClient db,
        string operationScope,
        string mutationKey,
        Func<CancellationToken, Task<T>> mutation,
        CancellationToken cancellationToken,
        Func<T, bool>? shouldEnlist = null)
    {
        return await ActiveReleaseFencedTransaction.ExecuteAsync(
            db,
            transactionalCommitGuard,
            operationScope,
            mutationKey,
            mutation,
            cancellationToken,
            shouldEnlist).ConfigureAwait(false);
    }

    private async Task EnsureClaimOwnedAsync(
        ISqlSugarClient db,
        IDbConcurrencyGate dbGate,
        ArticleMutationOutboxEvent item,
        CancellationToken cancellationToken)
    {
        DateTime heartbeatAt = timeProvider.GetUtcNow().UtcDateTime;
        DateTime claimExpiresAt = heartbeatAt.Add(GetClaimLeaseDuration());
        int updatedRows = await dbGate.ExecuteAsync(
            "article-outbox-claim-heartbeat",
            gateCt => ExecuteFencedMutationAsync(
                db,
                "article-outbox-heartbeat",
                $"{item.Id}:{item.ClaimToken}:{heartbeatAt.Ticks}",
                _ => db.Ado.ExecuteCommandAsync(
                    """
                    UPDATE article_mutation_outbox
                    SET heartbeat_at = @HeartbeatAt,
                        claim_expires_at = @ClaimExpiresAt,
                        next_retry_at = @ClaimExpiresAt
                    WHERE id = @Id
                      AND status = 'processing'
                      AND claim_token = @ClaimToken
                      AND claim_expires_at > @HeartbeatAt;
                    """,
                    new SugarParameter("@Id", item.Id),
                    new SugarParameter("@ClaimToken", item.ClaimToken),
                    new SugarParameter("@HeartbeatAt", heartbeatAt),
                    new SugarParameter("@ClaimExpiresAt", claimExpiresAt)),
                gateCt,
                static updatedRows => updatedRows > 0),
            _ => Task.FromResult(0),
            cancellationToken).ConfigureAwait(false);
        FsusObservability.RecordArticleOutboxHeartbeat(updatedRows == 1 ? "renewed" : "lost", updatedRows);
        if (updatedRows != 1)
        {
            throw new ArticleMutationOutboxClaimLostException(item.Id);
        }

        item.HeartbeatAt = heartbeatAt;
        item.ClaimExpiresAt = claimExpiresAt;
    }

    private async Task MaintainClaimHeartbeatsAsync(string claimToken, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(GetHeartbeatInterval(), timeProvider, cancellationToken).ConfigureAwait(false);
                await EnsureCurrentGenerationAsync(cancellationToken).ConfigureAwait(false);
                DateTime heartbeatAt = timeProvider.GetUtcNow().UtcDateTime;
                DateTime claimExpiresAt = heartbeatAt.Add(GetClaimLeaseDuration());
                await using ObservedAsyncServiceScope scope = DependencyInjectionScopeTelemetry.CreateAsyncScope(
                    scopeFactory,
                    "article_outbox_reconcile");
                ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
                IDbConcurrencyGate dbGate = scope.ServiceProvider.GetRequiredService<IDbConcurrencyGate>();
                int updatedRows = await dbGate.ExecuteAsync(
                    "article-outbox-batch-heartbeat",
                    gateCt => ExecuteFencedMutationAsync(
                        db,
                        "article-outbox-batch-heartbeat",
                        $"{claimToken}:{heartbeatAt.Ticks}",
                        _ => db.Ado.ExecuteCommandAsync(
                            """
                            UPDATE article_mutation_outbox
                            SET heartbeat_at = @HeartbeatAt,
                                claim_expires_at = @ClaimExpiresAt,
                                next_retry_at = @ClaimExpiresAt
                            WHERE status = 'processing'
                              AND claim_token = @ClaimToken
                              AND claim_expires_at > @HeartbeatAt;
                            """,
                            new SugarParameter("@ClaimToken", claimToken),
                            new SugarParameter("@HeartbeatAt", heartbeatAt),
                            new SugarParameter("@ClaimExpiresAt", claimExpiresAt)),
                        gateCt,
                        static updatedRows => updatedRows > 0),
                    _ => Task.FromResult(0),
                    cancellationToken).ConfigureAwait(false);
                FsusObservability.RecordArticleOutboxHeartbeat(updatedRows > 0 ? "renewed" : "idle", updatedRows);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (ActiveReleaseFenceLostException)
            {
                return;
            }
            catch (Exception ex)
            {
                FsusObservability.RecordArticleOutboxHeartbeat("failed", 0);
                logger.LogError(ex, "article-mutation-outbox-heartbeat-failed {ClaimedBy}", s_workerId);
            }
        }
    }

    private async Task DetectStuckClaimsAsync(
        ISqlSugarClient db,
        IDbConcurrencyGate dbGate,
        DateTime now,
        CancellationToken cancellationToken)
    {
        int stuck = await dbGate.ExecuteAsync(
            "article-outbox-stuck-claim-count",
            gateCt => db.Ado.GetIntAsync(
                """
                SELECT COUNT(*)
                FROM article_mutation_outbox
                WHERE aggregate_type = 'article'
                  AND status = 'processing'
                  AND COALESCE(GREATEST(claim_expires_at, next_retry_at), claim_expires_at, next_retry_at) <= @Now;
                """,
                new SugarParameter[] { new("@Now", now) }),
            _ => Task.FromResult(0),
            cancellationToken).ConfigureAwait(false);
        FsusObservability.RecordArticleOutboxStuckClaims(stuck);
        if (stuck > 0)
        {
            logger.LogWarning("article-mutation-outbox-stale-claims-detected {StuckCount}", stuck);
        }
    }

    private TimeSpan GetClaimLeaseDuration()
    {
        int configuredSeconds = configuration?.GetValue<int?>("ArticleMutationOutbox:ClaimLeaseSeconds") ?? 120;
        return TimeSpan.FromSeconds(Math.Clamp(configuredSeconds, 30, 900));
    }

    private TimeSpan GetHeartbeatInterval()
    {
        int configuredSeconds = configuration?.GetValue<int?>("ArticleMutationOutbox:HeartbeatSeconds") ?? 20;
        double maximum = Math.Max(1, GetClaimLeaseDuration().TotalSeconds / 3);
        return TimeSpan.FromSeconds(Math.Clamp(configuredSeconds, 1, (int)maximum));
    }

    private static string BuildWorkerId()
    {
        string workerId = string.Concat(Environment.MachineName, ":", Environment.ProcessId.ToString());
        return workerId.Length <= 128 ? workerId : workerId[..128];
    }

    private static async Task<List<ClaimedArticleMutationOutboxEvent>> ClaimPendingOutboxEventsAsync(
        ISqlSugarClient db,
        DateTime claimNow,
        DateTime claimDeadline,
        string claimToken,
        string claimedBy,
        CancellationToken cancellationToken)
    {
        var claimed = new List<ClaimedArticleMutationOutboxEvent>(BatchSize);
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            WITH claim_candidates AS (
                SELECT id
                     , status AS previous_status
                FROM article_mutation_outbox
                WHERE aggregate_type = 'article'
                  AND (
                      (status = 'pending' AND next_retry_at <= @ClaimNow)
                      OR (
                          status = 'processing'
                          AND COALESCE(GREATEST(claim_expires_at, next_retry_at), claim_expires_at, next_retry_at) <= @ClaimNow
                      )
                  )
                ORDER BY id
                LIMIT @BatchSize
                FOR UPDATE SKIP LOCKED
            )
            UPDATE article_mutation_outbox AS outbox
            SET status = 'processing',
                claim_token = @ClaimToken,
                claimed_by = @ClaimedBy,
                claimed_at = @ClaimNow,
                heartbeat_at = @ClaimNow,
                claim_expires_at = @ClaimDeadline,
                next_retry_at = @ClaimDeadline
            FROM claim_candidates
            WHERE outbox.id = claim_candidates.id
            RETURNING outbox.id,
                      outbox.event_id,
                      outbox.aggregate_type,
                      outbox.aggregate_id,
                      outbox.schema_version,
                      outbox.article_revision_id,
                      outbox.revision_no,
                      outbox.rights_snapshot_id,
                      outbox.responsibility_snapshot_id,
                      outbox.responsibility_version,
                      outbox.article_publication_id,
                      outbox.publication_no,
                      outbox.event_type,
                      outbox.payload_json,
                      outbox.status,
                      outbox.retry_count,
                      outbox.next_retry_at,
                      outbox.created_at,
                      outbox.processed_at,
                      outbox.last_error,
                      outbox.claim_token,
                      outbox.claimed_by,
                      outbox.claimed_at,
                      outbox.heartbeat_at,
                      outbox.claim_expires_at,
                      claim_candidates.previous_status;
            """,
            new SugarParameter[]
            {
                new("@ClaimNow", claimNow),
                new("@ClaimDeadline", claimDeadline),
                new("@ClaimToken", claimToken),
                new("@ClaimedBy", claimedBy),
                new("@BatchSize", BatchSize)
            });
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            var item = new ArticleMutationOutboxEvent
            {
                Id = reader.ReadInt64("id"),
                EventId = reader.ReadString("event_id"),
                AggregateType = reader.ReadString("aggregate_type"),
                AggregateId = reader.ReadInt32("aggregate_id"),
                SchemaVersion = reader.ReadInt32("schema_version"),
                ArticleRevisionId = reader.IsNull("article_revision_id") ? null : reader.ReadInt64("article_revision_id"),
                RevisionNo = reader.IsNull("revision_no") ? null : reader.ReadInt32("revision_no"),
                RightsSnapshotId = reader.IsNull("rights_snapshot_id") ? null : reader.ReadInt64("rights_snapshot_id"),
                ResponsibilitySnapshotId = reader.IsNull("responsibility_snapshot_id") ? null : reader.ReadInt64("responsibility_snapshot_id"),
                ResponsibilityVersion = reader.IsNull("responsibility_version") ? null : reader.ReadInt32("responsibility_version"),
                ArticlePublicationId = reader.IsNull("article_publication_id") ? null : reader.ReadInt64("article_publication_id"),
                PublicationNo = reader.IsNull("publication_no") ? null : reader.ReadInt32("publication_no"),
                EventType = reader.ReadString("event_type"),
                PayloadJson = reader.ReadString("payload_json"),
                Status = reader.ReadString("status"),
                RetryCount = reader.ReadInt32("retry_count"),
                NextRetryAt = reader.ReadDateTime("next_retry_at"),
                CreatedAt = reader.ReadDateTime("created_at"),
                ProcessedAt = reader.IsNull("processed_at") ? null : reader.ReadDateTime("processed_at"),
                LastError = reader.IsNull("last_error") ? null : reader.ReadString("last_error"),
                ClaimToken = reader.ReadString("claim_token"),
                ClaimedBy = reader.ReadString("claimed_by"),
                ClaimedAt = reader.ReadDateTime("claimed_at"),
                HeartbeatAt = reader.ReadDateTime("heartbeat_at"),
                ClaimExpiresAt = reader.ReadDateTime("claim_expires_at")
            };
            claimed.Add(new ClaimedArticleMutationOutboxEvent(
                item,
                string.Equals(reader.ReadString("previous_status"), "processing", StringComparison.Ordinal)));
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

        List<ArticleMutationOutboxEdge> terminalEdges = await dbGate.ExecuteAsync(
                "article-outbox-edge-batch-read",
                gateCt => db.Queryable<ArticleMutationOutboxEdge>()
                    .Where(edge => outboxEventIds.Contains(edge.OutboxEventId)
                        && (edge.Status == ArticleMutationOutboxEdgeStatus.Completed
                            || edge.Status == ArticleMutationOutboxEdgeStatus.Skipped))
                    .ToListAsync(gateCt),
                _ => Task.FromResult(new List<ArticleMutationOutboxEdge>()),
                cancellationToken)
            .ConfigureAwait(false);

        var result = new Dictionary<long, HashSet<string>>();
        foreach (ArticleMutationOutboxEdge edge in terminalEdges)
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
        ArticleMutationOutboxEvent item,
        ArticleMutationReplayResult replay,
        CancellationToken cancellationToken)
    {
        var rows = new List<ArticleMutationOutboxEdgeWrite>(
            replay.CompletedEdges.Count + replay.SkippedEdges.Count + replay.FailedEdges.Count);
        foreach (string edgeName in replay.CompletedEdges)
        {
            if (!string.IsNullOrWhiteSpace(edgeName))
            {
                rows.Add(new ArticleMutationOutboxEdgeWrite(
                    item.Id,
                    edgeName,
                    ArticleMutationOutboxEdgeStatus.Completed,
                    null,
                    ArticleMutationDeliveryKey.Build(item.EventId, edgeName)));
            }
        }

        foreach (string edgeName in replay.SkippedEdges)
        {
            if (!string.IsNullOrWhiteSpace(edgeName))
            {
                rows.Add(new ArticleMutationOutboxEdgeWrite(
                    item.Id,
                    edgeName,
                    ArticleMutationOutboxEdgeStatus.Skipped,
                    replay.SkippedEdgeReasons.GetValueOrDefault(edgeName),
                    ArticleMutationDeliveryKey.Build(item.EventId, edgeName)));
            }
        }

        foreach (KeyValuePair<string, string> failedEdge in replay.FailedEdges)
        {
            if (!string.IsNullOrWhiteSpace(failedEdge.Key))
            {
                rows.Add(new ArticleMutationOutboxEdgeWrite(
                    item.Id,
                    failedEdge.Key,
                    ArticleMutationOutboxEdgeStatus.Failed,
                    failedEdge.Value,
                    ArticleMutationDeliveryKey.Build(item.EventId, failedEdge.Key)));
            }
        }

        if (rows.Count == 0)
        {
            return;
        }

        DateTime updatedAt = timeProvider.GetUtcNow().UtcDateTime;
        int updatedRows = await dbGate.ExecuteAsync(
            "article-outbox-edge-upsert",
            gateCt => ExecuteFencedMutationAsync(
                db,
                "article-outbox-edge-upsert",
                $"{item.Id}:{item.ClaimToken}:{updatedAt.Ticks}",
                _ => db.Ado.ExecuteCommandAsync(
                    BuildReplayEdgeUpsertSql(rows.Count),
                    BuildReplayEdgeUpsertParameters(rows, item.ClaimToken!, updatedAt)),
                gateCt,
                static updatedRows => updatedRows > 0),
            _ => Task.FromResult(0),
            cancellationToken).ConfigureAwait(false);
        if (updatedRows != rows.Count)
        {
            throw new ArticleMutationOutboxClaimLostException(item.Id);
        }
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
            values.Add($"(@OutboxEventId{i}, @EdgeName{i}, @Status{i}, 1, @LastError{i}, @UpdatedAt, @DeliveryKey{i})");
        }

        return $$"""
            WITH owned_claim AS (
                SELECT id
                FROM article_mutation_outbox
                WHERE id = @OwnedOutboxEventId
                  AND status = 'processing'
                  AND claim_token = @ClaimToken
                  AND claim_expires_at > @UpdatedAt
            ),
            edge_values(outbox_event_id, edge_name, status, attempt_count, last_error, updated_at, delivery_key) AS (
                VALUES {{string.Join(", ", values)}}
            )
            INSERT INTO article_mutation_outbox_edge (
                outbox_event_id,
                edge_name,
                status,
                attempt_count,
                last_error,
                updated_at,
                delivery_key
            )
            SELECT edge_values.*
            FROM edge_values
            CROSS JOIN owned_claim
            ON CONFLICT (outbox_event_id, edge_name) DO UPDATE
            SET status = EXCLUDED.status,
                attempt_count = article_mutation_outbox_edge.attempt_count + EXCLUDED.attempt_count,
                last_error = EXCLUDED.last_error,
                updated_at = EXCLUDED.updated_at,
                delivery_key = EXCLUDED.delivery_key;
            """;
    }

    private static string BuildCompleteSql()
    {
        string requiredEdges = string.Join(", ", ArticleMutationReplayEdges.Required
            .Order(StringComparer.Ordinal)
            .Select(static edge => $"('{edge}')"));
        return $$"""
            UPDATE article_mutation_outbox AS outbox
            SET status = 'processed',
                processed_at = @ProcessedAt,
                last_error = NULL,
                claim_token = NULL,
                claimed_by = NULL,
                claimed_at = NULL,
                heartbeat_at = NULL,
                claim_expires_at = NULL
            WHERE outbox.id = @Id
              AND outbox.status = 'processing'
              AND outbox.claim_token = @ClaimToken
              AND outbox.claim_expires_at > @ProcessedAt
              AND NOT EXISTS (
                  SELECT 1
                  FROM (VALUES {{requiredEdges}}) AS required(edge_name)
                  WHERE NOT EXISTS (
                      SELECT 1
                      FROM article_mutation_outbox_edge AS edge
                      WHERE edge.outbox_event_id = outbox.id
                        AND edge.edge_name = required.edge_name
                        AND edge.status IN ('completed', 'skipped')
                  )
              );
            """;
    }

    private static SugarParameter[] BuildReplayEdgeUpsertParameters(
        IReadOnlyList<ArticleMutationOutboxEdgeWrite> rows,
        string claimToken,
        DateTime updatedAt)
    {
        var parameters = new List<SugarParameter>(rows.Count * 5 + 3)
        {
            new("@UpdatedAt", updatedAt),
            new("@OwnedOutboxEventId", rows[0].OutboxEventId),
            new("@ClaimToken", claimToken)
        };
        for (int i = 0; i < rows.Count; i++)
        {
            ArticleMutationOutboxEdgeWrite row = rows[i];
            parameters.Add(new SugarParameter($"@OutboxEventId{i}", row.OutboxEventId));
            parameters.Add(new SugarParameter($"@EdgeName{i}", row.EdgeName));
            parameters.Add(new SugarParameter($"@Status{i}", row.Status));
            parameters.Add(new SugarParameter($"@LastError{i}", row.LastError is null ? DBNull.Value : NormalizeLastError(row.LastError)));
            parameters.Add(new SugarParameter($"@DeliveryKey{i}", row.DeliveryKey));
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
        string? LastError,
        string DeliveryKey);

    private sealed record ClaimedArticleMutationOutboxEvent(
        ArticleMutationOutboxEvent Event,
        bool WasReclaimed);

    private sealed class ArticleAotCategoryRow
    {
        public int ArticleId
        {
            get; set;
        }

        public int CategoryId
        {
            get; set;
        }
    }

    private sealed class ArticleAotTagRow
    {
        public int ArticleId
        {
            get; set;
        }

        public int TagId
        {
            get; set;
        }
    }

    private sealed class ArticleMutationOutboxClaimLostException(long outboxId)
        : InvalidOperationException($"Article mutation outbox claim {outboxId} is no longer owned.");
}
