using System.Data.Common;
using System.Diagnostics.Metrics;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Common;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Data;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Services.Moderation;

using SqlSugar;

namespace FsusBlog.Server.Services.Background;

public sealed record CommentMutationOutboxRuntimeSnapshot(
    int BacklogCount,
    int FailedCount,
    int PoisonCount,
    long OldestAgeSeconds,
    long ProcessedCount,
    DateTime? LastCompletedAtUtc,
    string? LastError,
    int OwnedCount = 0,
    long RenewedCount = 0,
    long LostCount = 0,
    long ReclaimedCount = 0,
    long OldestLeaseAgeSeconds = 0);

public sealed class CommentMutationOutboxRuntimeState
{
    private readonly object _gate = new();
    private CommentMutationOutboxRuntimeSnapshot _snapshot = new(0, 0, 0, 0, 0, null, null);

    public CommentMutationOutboxRuntimeSnapshot CreateSnapshot()
    {
        lock (_gate)
        {
            return _snapshot;
        }
    }

    internal void Update(int backlog, int failed, int poison, long oldestAgeSeconds, int processedDelta, DateTime now, string? error,
        int owned = 0, int renewed = 0, int lost = 0, int reclaimed = 0, long oldestLeaseAgeSeconds = 0)
    {
        lock (_gate)
        {
            _snapshot = new(
                backlog,
                failed,
                poison,
                Math.Max(0, oldestAgeSeconds),
                _snapshot.ProcessedCount + processedDelta,
                processedDelta > 0 ? now : _snapshot.LastCompletedAtUtc,
                error,
                owned,
                _snapshot.RenewedCount + renewed,
                _snapshot.LostCount + lost,
                _snapshot.ReclaimedCount + reclaimed,
                Math.Max(0, oldestLeaseAgeSeconds));
        }
    }

    internal void UpdateLeaseLifecycle(int owned, int renewed = 0, int lost = 0, int reclaimed = 0, long oldestLeaseAgeSeconds = 0)
    {
        lock (_gate)
        {
            _snapshot = _snapshot with
            {
                OwnedCount = owned,
                RenewedCount = _snapshot.RenewedCount + renewed,
                LostCount = _snapshot.LostCount + lost,
                ReclaimedCount = _snapshot.ReclaimedCount + reclaimed,
                OldestLeaseAgeSeconds = Math.Max(0, oldestLeaseAgeSeconds)
            };
        }
    }
}

internal enum CommentOutboxRealtimeAction
{
    None = 0,
    Add = 1,
    Remove = 2
}

public sealed class CommentMutationOutboxWorker(
    IServiceScopeFactory scopeFactory,
    IBackgroundWorkerLease workerLease,
    CommentMutationOutboxRuntimeState runtimeState,
    TimeProvider timeProvider,
    IConfiguration configuration,
    ILogger<CommentMutationOutboxWorker> logger,
    Func<Exception?>? heartbeatFaultInjector = null,
    Func<CommentMutationOutboxEvent, Task>? beforeMarkFailed = null,
    Func<CommentMutationOutboxEvent, Task>? beforeReleaseClaim = null,
    Func<CommentMutationOutboxEvent, Task>? beforeMarkProcessed = null) : BackgroundService
{
    private const int BatchSize = 32;
    private const int PoisonThreshold = 10;
    private const string WorkerLeaseName = "comment-mutation-outbox";
    private static readonly Meter s_meter = new("FsusBlog.Server.CommentOutbox", "1.0.0");
    private static readonly Counter<long> s_processed = s_meter.CreateCounter<long>("fsus.comment_outbox.processed.count");
    private static readonly Counter<long> s_failed = s_meter.CreateCounter<long>("fsus.comment_outbox.failed.count");
    private static readonly Histogram<long> s_backlog = s_meter.CreateHistogram<long>("fsus.comment_outbox.backlog");
    private static readonly Histogram<long> s_latency = s_meter.CreateHistogram<long>("fsus.comment_outbox.oldest_age_seconds");
    private static readonly Histogram<long> s_poison = s_meter.CreateHistogram<long>("fsus.comment_outbox.poison");
    private static readonly Counter<long> s_claimLost = s_meter.CreateCounter<long>("fsus.comment_outbox.claim_lost.count");
    private static readonly Counter<long> s_heartbeat = s_meter.CreateCounter<long>("fsus.comment_outbox.heartbeat.count");
    private static readonly string s_workerId = BuildWorkerId();

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            await workerLease.TryRunAsLeaderAsync(WorkerLeaseName, ProcessPendingAsync, stoppingToken).ConfigureAwait(false);
            try
            {
                await Task.Delay(GetPollInterval(), timeProvider, stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
        }
    }

    internal async Task<int> ProcessPendingAsync(CancellationToken cancellationToken)
    {
        if (configuration.GetValue<bool?>("CommentMutationOutbox:Enabled") == false)
        {
            return 0;
        }

        using IServiceScope scope = scopeFactory.CreateScope();
        ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        List<ClaimedCommentMutationOutboxEvent> claims = await ClaimAsync(db, now, cancellationToken).ConfigureAwait(false);
        List<CommentMutationOutboxEvent> events = claims.Select(static claim => claim.Event).ToList();
        var claimStates = claims.ToDictionary(static claim => claim.Event.Id, static claim => new ClaimState(claim.Event));
        UpdateLeaseRuntimeState(claimStates.Values, reclaimed: claims.Count(static claim => claim.WasReclaimed));
        int processed = 0;
        string? lastError = null;
        using var heartbeatCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        Task heartbeat = MaintainClaimHeartbeatsAsync(claimStates, heartbeatCts.Token);
        try
        {
            foreach (CommentMutationOutboxEvent item in events)
            {
                ClaimState claim = claimStates[item.Id];
                try
                {
                    await ProcessOneAsync(scope.ServiceProvider, db, item, claim, cancellationToken).ConfigureAwait(false);
                    await EnsureClaimOwnedAsync(db, claim, cancellationToken).ConfigureAwait(false);
                    if (beforeMarkProcessed is not null)
                        await beforeMarkProcessed(item).ConfigureAwait(false);
                    await MarkProcessedAsync(db, item, claim, timeProvider.GetUtcNow().UtcDateTime).ConfigureAwait(false);
                    UpdateLeaseRuntimeState(claimStates.Values);
                    processed++;
                    s_processed.Add(1);
                }
                catch (CommentMutationOutboxClaimLostException)
                {
                    bool newlyLost = claim.TryRecordLost();
                    if (newlyLost)
                        s_claimLost.Add(1);
                    UpdateLeaseRuntimeState(claimStates.Values, lost: newlyLost ? 1 : 0);
                }
                catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
                {
                    throw;
                }
                catch (Exception ex)
                {
                    lastError = ex.GetType().Name;
                    try
                    {
                        if (beforeMarkFailed is not null)
                            await beforeMarkFailed(item).ConfigureAwait(false);
                        await MarkFailedAsync(db, item, claim, ex, timeProvider.GetUtcNow().UtcDateTime).ConfigureAwait(false);
                    }
                    catch (CommentMutationOutboxClaimLostException)
                    {
                        bool newlyLost = claim.TryRecordLost();
                        if (newlyLost)
                            s_claimLost.Add(1);
                        UpdateLeaseRuntimeState(claimStates.Values, lost: newlyLost ? 1 : 0);
                        continue;
                    }
                    s_failed.Add(1);
                    logger.LogError(ex, "评论 Outbox 消费失败 | EventId: {EventId} | EventType: {EventType} | Attempt: {Attempt}", item.EventId, item.EventType, item.AttemptCount + 1);
                }
            }
        }
        finally
        {
            await heartbeatCts.CancelAsync().ConfigureAwait(false);
            await heartbeat.ConfigureAwait(false);
            if (cancellationToken.IsCancellationRequested)
            {
                using IServiceScope releaseScope = scopeFactory.CreateScope();
                ISqlSugarClient releaseDb = releaseScope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
                int releasedLost = await ReleaseOwnedClaimsAsync(releaseDb, claimStates.Values, beforeReleaseClaim, CancellationToken.None).ConfigureAwait(false);
                if (releasedLost > 0)
                    s_claimLost.Add(releasedLost);
                UpdateLeaseRuntimeState(claimStates.Values, lost: releasedLost);
            }
        }

        if (cancellationToken.IsCancellationRequested)
        {
            return processed;
        }

        OutboxCounts counts = await LoadCountsAsync(db, now, cancellationToken).ConfigureAwait(false);
        DateTime completedAt = timeProvider.GetUtcNow().UtcDateTime;
        long oldestLeaseAge = GetOldestOwnedLeaseAge(claimStates.Values, completedAt);
        runtimeState.Update(counts.Backlog, counts.Failed, counts.Poison, counts.OldestAgeSeconds, processed, now, lastError,
            claimStates.Values.Count(static claim => claim.OwnerState == ClaimOwnerState.Owned), 0, 0, 0, oldestLeaseAge);
        s_backlog.Record(counts.Backlog);
        s_latency.Record(counts.OldestAgeSeconds);
        s_poison.Record(counts.Poison);
        return processed;
    }

    private async Task ProcessOneAsync(
        IServiceProvider services,
        ISqlSugarClient db,
        CommentMutationOutboxEvent item,
        ClaimState claim,
        CancellationToken cancellationToken)
    {
        foreach (string consumer in CommentMutationOutboxConsumers.RequiredFor(item.EventType))
        {
            Func<CancellationToken, Task> action = consumer switch
            {
                CommentMutationOutboxConsumers.ModelModeration => ct => ApplyModerationAsync(services, db, item, ct),
                CommentMutationOutboxConsumers.CacheVersion => ct => InvalidateCacheAsync(services, db, item, ct),
                CommentMutationOutboxConsumers.RealtimeStream => ct => PublishRealtimeAsync(services, db, item, ct),
                CommentMutationOutboxConsumers.AuditProjection => ct => VerifyAuditProjectionAsync(db, item, ct),
                CommentMutationOutboxConsumers.SiteNotification => ct => DeliverNotificationAsync(services, db, item, ct),
                _ => throw new CommentMutationOutboxTerminalDeliveryException($"comment_outbox_consumer_unknown:{consumer}")
            };
            await RunConsumerAsync(db, item, claim, consumer, action, cancellationToken).ConfigureAwait(false);
        }
    }

    private static async Task ApplyModerationAsync(
        IServiceProvider services,
        ISqlSugarClient db,
        CommentMutationOutboxEvent item,
        CancellationToken cancellationToken)
    {
        Comment? comment = await db.Queryable<Comment>().InSingleAsync(item.CommentId).ConfigureAwait(false);
        if (comment is null || comment.IsDeleted)
        {
            return;
        }

        CommentRegionCompliance? region = await db.Queryable<CommentRegionCompliance>()
            .Where(row => row.CommentId == item.CommentId)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);
        if (region is null)
        {
            throw new InvalidOperationException("comment_region_compliance_missing");
        }

        var decision = new RegionModerationDecision(
            region.CanPublish,
            region.SubmitRegion,
            region.SubmitRegionConfidence,
            region.RegionProvider,
            region.SubmitIpHash,
            RegionLegalModerationService.DeserializeRegions(region.BlockedRegions),
            ParseCsv(region.RiskLabels),
            [],
            region.PolicyVersion,
            region.DecisionReason ?? string.Empty,
            string.Empty,
            region.RequiresManualReview,
            region.HideUntilReviewed);
        var actor = new CommentModerationActorContext(
            comment.UserId,
            comment.AuthorMode,
            comment.AnonymousDisplayLanguage ?? "zh-CN",
            comment.ModerationSubjectHash,
            comment.AnonymousNullifierHash,
            comment.AnonymousScope,
            comment.AnonymousRateClass ?? "default",
            comment.AnonymousRequiresModeration == true);
        await services.GetRequiredService<ICommentModerationService>()
            .ApplyPostInsertAsync(comment, actor, decision, cancellationToken)
            .ConfigureAwait(false);
    }

    private static async Task InvalidateCacheAsync(
        IServiceProvider services,
        ISqlSugarClient db,
        CommentMutationOutboxEvent item,
        CancellationToken cancellationToken)
    {
        Comment? comment = await db.Queryable<Comment>().InSingleAsync(item.CommentId).ConfigureAwait(false);
        await services.GetRequiredService<ICacheInvalidationDispatcher>()
            .InvalidateCommentMutationAsync(
                new CommentCacheInvalidationScope(
                    item.ArticleId,
                    item.RootId,
                    comment?.UserId ?? item.AccountId,
                    PublicArticleChanged: true,
                    UserCommentsChanged: (comment?.UserId ?? item.AccountId) is > 0),
                cancellationToken)
            .ConfigureAwait(false);
    }

    private static async Task PublishRealtimeAsync(
        IServiceProvider services,
        ISqlSugarClient db,
        CommentMutationOutboxEvent item,
        CancellationToken cancellationToken)
    {
        Comment? comment = await db.Queryable<Comment>().InSingleAsync(item.CommentId).ConfigureAwait(false);
        ICommentNotificationService notifications = services.GetRequiredService<ICommentNotificationService>();
        string deliveryKey = $"comment-outbox:{item.EventId}:realtime";
        if (comment is null)
        {
            return;
        }

        CommentOutboxRealtimeAction action = ResolveRealtimeAction(item, comment);
        if (action == CommentOutboxRealtimeAction.Remove)
        {
            await notifications.PublishRemovedAsync(item.ArticleId, item.CommentId, item.RootId, item.ParentId, deliveryKey).ConfigureAwait(false);
            return;
        }

        if (action == CommentOutboxRealtimeAction.Add)
        {
            await notifications.PublishAddedAsync(comment, item.OccurredAtUtc, deliveryKey).ConfigureAwait(false);
        }
    }

    internal static CommentOutboxRealtimeAction ResolveRealtimeAction(
        CommentMutationOutboxEvent item,
        Comment current)
    {
        if (item.EventType == CommentMutationEventTypes.Deleted && current.IsDeleted)
        {
            return CommentOutboxRealtimeAction.Remove;
        }

        if (item.EventType == CommentMutationEventTypes.ModerationChanged)
        {
            if (item.NextStatus == CommentModerationStatus.Approved
                && !current.IsDeleted
                && current.ModerationStatus == CommentModerationStatus.Approved)
            {
                return CommentOutboxRealtimeAction.Add;
            }

            return item.PreviousStatus == CommentModerationStatus.Approved
                && current.ModerationStatus is CommentModerationStatus.Hidden or CommentModerationStatus.Rejected
                    ? CommentOutboxRealtimeAction.Remove
                    : CommentOutboxRealtimeAction.None;
        }

        return item.EventType is CommentMutationEventTypes.Created or CommentMutationEventTypes.Edited
            && !current.IsDeleted
            && current.ModerationStatus == CommentModerationStatus.Approved
                ? CommentOutboxRealtimeAction.Add
                : CommentOutboxRealtimeAction.None;
    }

    private static async Task DeliverNotificationAsync(
        IServiceProvider services,
        ISqlSugarClient db,
        CommentMutationOutboxEvent item,
        CancellationToken cancellationToken)
    {
        Comment? comment = await db.Queryable<Comment>().InSingleAsync(item.CommentId).ConfigureAwait(false);
        if (comment is null)
        {
            return;
        }

        if (item.EventType == CommentMutationEventTypes.ReplyNotificationRequested)
        {
            if (comment.IsDeleted || comment.ModerationStatus != CommentModerationStatus.Approved || item.ReplyToAccountId is not > 0)
            {
                return;
            }

            string actor = comment.AuthorMode == Models.CommentIdentity.CommentAuthorModes.Public
                ? comment.PublicHandle ?? "未署名用户"
                : comment.AnonymousDisplayName ?? "匿名用户";
            string snippet = comment.Content.Length > 40 ? comment.Content[..40] : comment.Content;
            await SendOutboxNoticeAsync(
                services.GetRequiredService<IMessageCommandService>(),
                item,
                item.ReplyToAccountId.Value,
                "收到新的评论回复",
                $"{actor} 回复了您的评论：{snippet}。定位：/article/{item.ArticleId}#comment-{item.CommentId}",
                "reply").ConfigureAwait(false);
            return;
        }

        if (item.EventType == CommentMutationEventTypes.Deleted
            && item.ActorAdminPrincipalId is > 0
            && item.AccountId is > 0)
        {
            Article? article = await db.Queryable<Article>().InSingleAsync(item.ArticleId).ConfigureAwait(false);
            string snippet = comment.Content.Length > 20 ? comment.Content[..20] : comment.Content;
            await SendOutboxNoticeAsync(
                services.GetRequiredService<IMessageCommandService>(),
                item,
                item.AccountId.Value,
                "评论处理通知",
                $"您在《{article?.Title ?? "未知文章"}》下的评论「{snippet}...」已被管理员移除。原因：{comment.DeleteReason ?? "违反社区管理条例"}",
                "deletion").ConfigureAwait(false);
            return;
        }

        if (item.EventType == CommentMutationEventTypes.ModerationChanged
            && item.NextStatus == CommentModerationStatus.Hidden
            && comment.ModerationReason?.StartsWith("model_policy:", StringComparison.Ordinal) == true)
        {
            if (comment.UserId is > 0)
            {
                string snippet = comment.Content.ReplaceLineEndings(" ").Trim();
                snippet = snippet.Length <= 60 ? snippet : string.Concat(snippet[..60], "...");
                await SendOutboxNoticeAsync(
                    services.GetRequiredService<IMessageCommandService>(),
                    item,
                    comment.UserId.Value,
                    "评论审核提醒",
                    $"您的评论已由自动审核隐藏，原因是模型命中了内容风险信号。评论片段：「{snippet}」。本提醒不构成账号处罚，不会触发封禁、限流、信誉扣分或匿名凭证处理。",
                    "model-hidden").ConfigureAwait(false);
            }
        }
    }

    private static async Task SendOutboxNoticeAsync(
        IMessageCommandService messages,
        CommentMutationOutboxEvent item,
        int accountId,
        string subject,
        string body,
        string deliveryKind)
    {
        Result<FsusBlog.Shared.Contracts.Outputs.ConversationDetailResponse> result = await messages.SendSystemMessageAsync(
            subject,
            body,
            accountId,
            AdminMessageActor.System,
            BuildSourceEventId(item.EventId, deliveryKind)).ConfigureAwait(false);
        if (!result.IsSuccess)
        {
            throw new InvalidOperationException($"comment_outbox_notice_failed:{result.Error.Code}");
        }
    }

    internal static long BuildSourceEventId(string eventId, string deliveryKind)
    {
        byte[] digest = SHA256.HashData(Encoding.UTF8.GetBytes($"comment-outbox:{eventId}:{deliveryKind}"));
        long value = BitConverter.ToInt64(digest, 0) & long.MaxValue;
        return value == 0 ? 1 : value;
    }

    private static async Task VerifyAuditProjectionAsync(
        ISqlSugarClient db,
        CommentMutationOutboxEvent item,
        CancellationToken cancellationToken)
    {
        if (item.EventType is not (CommentMutationEventTypes.Created or CommentMutationEventTypes.ModerationChanged or CommentMutationEventTypes.Deleted))
        {
            return;
        }

        cancellationToken.ThrowIfCancellationRequested();
        int count = await db.Ado.GetIntAsync(
            "SELECT COUNT(*) FROM comment_moderation_event WHERE comment_id = @CommentId;",
            new SugarParameter("@CommentId", item.CommentId));
        if (count <= 0)
        {
            throw new InvalidOperationException("comment_moderation_audit_projection_missing");
        }
    }

    private async Task RunConsumerAsync(
        ISqlSugarClient db,
        CommentMutationOutboxEvent item,
        ClaimState claim,
        string consumer,
        Func<CancellationToken, Task> action,
        CancellationToken cancellationToken)
    {
        if (!s_consumerRegistry.Contains(consumer))
            throw new CommentMutationOutboxTerminalDeliveryException($"comment_outbox_consumer_unknown:{consumer}");

        string resultDigest = BuildDeliveryResultDigest(item, consumer);
        await EnsureClaimOwnedAsync(db, claim, cancellationToken).ConfigureAwait(false);
        ConsumerReservation reservation = await ReserveDeliveryAsync(db, item, claim, consumer, cancellationToken).ConfigureAwait(false);
        if (reservation == ConsumerReservation.Completed)
        {
            CommentMutationOutboxDelivery completed = await db.Queryable<CommentMutationOutboxDelivery>()
                .Where(row => row.OutboxEventId == item.Id && row.ConsumerName == consumer)
                .SingleAsync()
                .ConfigureAwait(false);
            if (!string.Equals(completed.ResultDigest, resultDigest, StringComparison.Ordinal))
            {
                await MarkCompletedDeliveryIntegrityFailureAsync(db, item.Id, claim, consumer).ConfigureAwait(false);
                throw new CommentMutationOutboxTerminalDeliveryException($"comment_outbox_delivery_result_digest_invalid:{consumer}");
            }
            return;
        }
        if (reservation == ConsumerReservation.TerminalFailed)
            throw new CommentMutationOutboxTerminalDeliveryException($"comment_outbox_delivery_terminal_failed:{consumer}");
        if (reservation != ConsumerReservation.Reserved)
        {
            claim.MarkLost();
            throw new CommentMutationOutboxClaimLostException(item.Id);
        }

        try
        {
            await EnsureClaimOwnedAsync(db, claim, cancellationToken).ConfigureAwait(false);
            await action(cancellationToken).ConfigureAwait(false);
            await EnsureClaimOwnedAsync(db, claim, cancellationToken).ConfigureAwait(false);
            await CompleteDeliveryAsync(db, item.Id, claim, consumer, resultDigest).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            if (claim.OwnerState == ClaimOwnerState.Owned)
            {
                await FailDeliveryAsync(db, item.Id, claim, consumer, ex).ConfigureAwait(false);
            }
            throw;
        }
    }

    private static readonly IReadOnlySet<string> s_consumerRegistry = CommentMutationOutboxConsumers.All;

    internal static string BuildDeliveryResultDigest(CommentMutationOutboxEvent item, string consumer)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(
            $"comment-outbox-delivery:v1|{consumer}|{item.EventId}|{item.EventType}|{item.CommentId}|{item.ArticleId}"))).ToLowerInvariant();

    private static async Task<ConsumerReservation> ReserveDeliveryAsync(
        ISqlSugarClient db,
        CommentMutationOutboxEvent item,
        ClaimState claim,
        string consumer,
        CancellationToken cancellationToken)
    {
        await using (DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            WITH owned_claim AS (
                SELECT id, lease_expires_at FROM comment_mutation_outbox
                WHERE id = @OutboxId AND status = 'processing' AND claim_token = @ClaimToken AND claimed_by = @ClaimedBy
                  AND lease_generation = @LeaseGeneration AND lease_expires_at > (now() AT TIME ZONE 'utc')
            ), reservation AS (
                INSERT INTO comment_mutation_outbox_delivery(
                    outbox_event_id, consumer_name, status, attempt_count, owner_claim_token, owner_worker_id,
                    lease_generation, started_at, lease_expires_at, last_error, last_failure_kind, updated_at_utc)
                SELECT @OutboxId, @Consumer, 'processing', 1, @ClaimToken, @ClaimedBy,
                    @LeaseGeneration, (now() AT TIME ZONE 'utc'), owned_claim.lease_expires_at, NULL, NULL, (now() AT TIME ZONE 'utc')
                FROM owned_claim
                ON CONFLICT (outbox_event_id, consumer_name) DO UPDATE
                SET status = 'processing',
                    attempt_count = comment_mutation_outbox_delivery.attempt_count + 1,
                    owner_claim_token = EXCLUDED.owner_claim_token,
                    owner_worker_id = EXCLUDED.owner_worker_id,
                    lease_generation = EXCLUDED.lease_generation,
                    started_at = EXCLUDED.started_at,
                    lease_expires_at = EXCLUDED.lease_expires_at,
                    completed_at = NULL,
                    result_digest = NULL,
                    last_error = NULL,
                    last_failure_kind = NULL,
                    updated_at_utc = EXCLUDED.updated_at_utc
                WHERE comment_mutation_outbox_delivery.status IN ('pending', 'retryable-failed')
                    OR (comment_mutation_outbox_delivery.status = 'processing'
                       AND (comment_mutation_outbox_delivery.lease_expires_at <= (now() AT TIME ZONE 'utc')
                            OR comment_mutation_outbox_delivery.lease_generation < EXCLUDED.lease_generation))
                RETURNING status
            )
            SELECT status FROM reservation;
            """,
            new SugarParameter("@OutboxId", item.Id),
            new SugarParameter("@ClaimToken", claim.Event.ClaimToken),
            new SugarParameter("@ClaimedBy", claim.Event.ClaimedBy),
            new SugarParameter("@LeaseGeneration", claim.Event.LeaseGeneration),
            new SugarParameter("@Consumer", consumer)))
        {
            if (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                return ConsumerReservation.Reserved;
        }

        CommentMutationOutboxDelivery? existing = await db.Queryable<CommentMutationOutboxDelivery>()
            .Where(row => row.OutboxEventId == item.Id && row.ConsumerName == consumer)
            .FirstAsync(cancellationToken)
            .ConfigureAwait(false);
        return existing?.Status switch
        {
            CommentMutationOutboxDeliveryStatus.Completed => ConsumerReservation.Completed,
            CommentMutationOutboxDeliveryStatus.TerminalFailed => ConsumerReservation.TerminalFailed,
            _ => ConsumerReservation.NotReserved
        };
    }

    private static async Task CompleteDeliveryAsync(ISqlSugarClient db, long outboxId, ClaimState claim, string consumer, string resultDigest)
    {
        int updated = await db.Ado.ExecuteCommandAsync(
            """
            UPDATE comment_mutation_outbox_delivery delivery
            SET status = 'completed', completed_at = (now() AT TIME ZONE 'utc'), result_digest = @ResultDigest,
                lease_expires_at = NULL, last_error = NULL, last_failure_kind = NULL, updated_at_utc = (now() AT TIME ZONE 'utc')
            FROM comment_mutation_outbox outbox
            WHERE delivery.outbox_event_id = @OutboxId AND delivery.consumer_name = @Consumer
              AND delivery.status = 'processing' AND delivery.owner_claim_token = @ClaimToken
              AND delivery.owner_worker_id = @ClaimedBy AND delivery.lease_generation = @LeaseGeneration
              AND delivery.lease_expires_at > (now() AT TIME ZONE 'utc')
              AND outbox.id = delivery.outbox_event_id AND outbox.status = 'processing'
              AND outbox.claim_token = @ClaimToken AND outbox.claimed_by = @ClaimedBy
              AND outbox.lease_generation = @LeaseGeneration AND outbox.lease_expires_at > (now() AT TIME ZONE 'utc');
            """,
            new SugarParameter("@OutboxId", outboxId), new SugarParameter("@Consumer", consumer),
            new SugarParameter("@ClaimToken", claim.Event.ClaimToken), new SugarParameter("@ClaimedBy", claim.Event.ClaimedBy),
            new SugarParameter("@LeaseGeneration", claim.Event.LeaseGeneration), new SugarParameter("@ResultDigest", resultDigest));
        if (updated != 1)
        {
            claim.MarkLost();
            throw new CommentMutationOutboxClaimLostException(outboxId);
        }
    }

    private static async Task MarkCompletedDeliveryIntegrityFailureAsync(ISqlSugarClient db, long outboxId, ClaimState claim, string consumer)
    {
        int updated = await db.Ado.ExecuteCommandAsync(
            """
            UPDATE comment_mutation_outbox_delivery
            SET status = 'terminal-failed', last_failure_kind = 'ResultDigestMismatch', last_error = 'comment_outbox_delivery_result_digest_invalid', updated_at_utc = (now() AT TIME ZONE 'utc')
            FROM comment_mutation_outbox outbox
            WHERE comment_mutation_outbox_delivery.outbox_event_id = @OutboxId
              AND comment_mutation_outbox_delivery.consumer_name = @Consumer
              AND comment_mutation_outbox_delivery.status = 'completed'
              AND outbox.id = comment_mutation_outbox_delivery.outbox_event_id
              AND outbox.status = @Processing AND outbox.claim_token = @ClaimToken AND outbox.claimed_by = @ClaimedBy
              AND outbox.lease_generation = @LeaseGeneration AND outbox.lease_expires_at > @Now;
            """,
            new SugarParameter("@OutboxId", outboxId), new SugarParameter("@Consumer", consumer),
            new SugarParameter("@Processing", CommentMutationOutboxStatus.Processing),
            new SugarParameter("@ClaimToken", claim.Event.ClaimToken), new SugarParameter("@ClaimedBy", claim.Event.ClaimedBy),
            new SugarParameter("@LeaseGeneration", claim.Event.LeaseGeneration), new SugarParameter("@Now", DateTime.UtcNow));
        if (updated != 1)
        {
            claim.MarkLost();
            throw new CommentMutationOutboxClaimLostException(outboxId);
        }
    }

    private static async Task FailDeliveryAsync(ISqlSugarClient db, long outboxId, ClaimState claim, string consumer, Exception exception)
    {
        string status = exception is CommentMutationOutboxTerminalDeliveryException
            ? CommentMutationOutboxDeliveryStatus.TerminalFailed
            : CommentMutationOutboxDeliveryStatus.RetryableFailed;
        int updated = await db.Ado.ExecuteCommandAsync(
            """
            UPDATE comment_mutation_outbox_delivery delivery
            SET status = @Status, lease_expires_at = NULL, last_error = @Error, last_failure_kind = @FailureKind,
                updated_at_utc = (now() AT TIME ZONE 'utc')
            FROM comment_mutation_outbox outbox
            WHERE delivery.outbox_event_id = @OutboxId AND delivery.consumer_name = @Consumer
              AND delivery.status = 'processing' AND delivery.owner_claim_token = @ClaimToken
              AND delivery.owner_worker_id = @ClaimedBy AND delivery.lease_generation = @LeaseGeneration
              AND outbox.id = delivery.outbox_event_id AND outbox.status = 'processing'
              AND outbox.claim_token = @ClaimToken AND outbox.claimed_by = @ClaimedBy
              AND outbox.lease_generation = @LeaseGeneration AND outbox.lease_expires_at > (now() AT TIME ZONE 'utc');
            """,
            new SugarParameter("@Status", status), new SugarParameter("@Error", SanitizeError(exception)),
            new SugarParameter("@FailureKind", exception.GetType().Name), new SugarParameter("@OutboxId", outboxId),
            new SugarParameter("@Consumer", consumer), new SugarParameter("@ClaimToken", claim.Event.ClaimToken),
            new SugarParameter("@ClaimedBy", claim.Event.ClaimedBy), new SugarParameter("@LeaseGeneration", claim.Event.LeaseGeneration));
        if (updated != 1)
        {
            claim.MarkLost();
            throw new CommentMutationOutboxClaimLostException(outboxId);
        }
    }

    private async Task<List<ClaimedCommentMutationOutboxEvent>> ClaimAsync(
        ISqlSugarClient db,
        DateTime now,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        DateTime leaseExpires = now.Add(GetClaimLeaseDuration());
        var events = new List<ClaimedCommentMutationOutboxEvent>(BatchSize);
        await using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            WITH candidates AS (
                SELECT id, status AS previous_status
                FROM comment_mutation_outbox
                WHERE ((status IN (@Pending, @Failed) AND next_attempt_at <= @Now)
                    OR (status = @Processing AND lease_expires_at <= @Now))
                ORDER BY occurred_at_utc, id
                FOR UPDATE SKIP LOCKED
                LIMIT @BatchSize
            )
            UPDATE comment_mutation_outbox o
            SET status = @Processing,
                claim_token = md5(random()::text || clock_timestamp()::text || o.id::text),
                claimed_by = @ClaimedBy,
                claimed_at = @Now,
                lease_expires_at = @LeaseExpires,
                last_heartbeat_at = @Now,
                lease_generation = o.lease_generation + 1
            FROM candidates c
            WHERE o.id = c.id
            RETURNING o.id, o.event_id, o.event_type, o.comment_id, o.article_id, o.root_id,
                      o.parent_id, o.account_id, o.reply_to_account_id, o.actor_admin_principal_id,
                      o.previous_status, o.next_status, o.payload_json, o.status, o.attempt_count,
                      o.next_attempt_at, o.claim_token, o.claimed_by, o.claimed_at, o.lease_expires_at, o.last_heartbeat_at, o.lease_generation,
                      o.last_error, o.occurred_at_utc, o.processed_at_utc, c.previous_status AS claim_previous_status;
            """,
            new SugarParameter("@Pending", CommentMutationOutboxStatus.Pending),
            new SugarParameter("@Failed", CommentMutationOutboxStatus.Failed),
            new SugarParameter("@Processing", CommentMutationOutboxStatus.Processing),
            new SugarParameter("@Now", now),
            new SugarParameter("@LeaseExpires", leaseExpires),
            new SugarParameter("@ClaimedBy", s_workerId),
            new SugarParameter("@BatchSize", BatchSize));
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            events.Add(new ClaimedCommentMutationOutboxEvent(ReadEvent(reader), reader.ReadString("claim_previous_status") == CommentMutationOutboxStatus.Processing));
        }
        return events;
    }

    private static CommentMutationOutboxEvent ReadEvent(DbDataReader reader)
        => new()
        {
            Id = reader.ReadInt64("id"),
            EventId = reader.ReadString("event_id"),
            EventType = reader.ReadString("event_type"),
            CommentId = reader.ReadInt64("comment_id"),
            ArticleId = reader.ReadInt32("article_id"),
            RootId = reader.ReadInt64("root_id"),
            ParentId = reader.IsNull("parent_id") ? null : reader.ReadInt64("parent_id"),
            AccountId = reader.IsNull("account_id") ? null : reader.ReadInt32("account_id"),
            ReplyToAccountId = reader.IsNull("reply_to_account_id") ? null : reader.ReadInt32("reply_to_account_id"),
            ActorAdminPrincipalId = reader.IsNull("actor_admin_principal_id") ? null : reader.ReadInt64("actor_admin_principal_id"),
            PreviousStatus = reader.IsNull("previous_status") ? null : (CommentModerationStatus)reader.ReadInt32("previous_status"),
            NextStatus = reader.IsNull("next_status") ? null : (CommentModerationStatus)reader.ReadInt32("next_status"),
            PayloadJson = reader.ReadString("payload_json"),
            Status = reader.ReadString("status"),
            AttemptCount = reader.ReadInt32("attempt_count"),
            NextAttemptAt = reader.ReadDateTime("next_attempt_at"),
            ClaimToken = reader.IsNull("claim_token") ? null : reader.ReadString("claim_token"),
            ClaimedBy = reader.IsNull("claimed_by") ? null : reader.ReadString("claimed_by"),
            ClaimedAt = reader.IsNull("claimed_at") ? null : reader.ReadDateTime("claimed_at"),
            LeaseExpiresAt = reader.IsNull("lease_expires_at") ? null : reader.ReadDateTime("lease_expires_at"),
            LastHeartbeatAt = reader.IsNull("last_heartbeat_at") ? null : reader.ReadDateTime("last_heartbeat_at"),
            LeaseGeneration = reader.ReadInt64("lease_generation"),
            LastError = reader.IsNull("last_error") ? null : reader.ReadString("last_error"),
            OccurredAtUtc = reader.ReadDateTime("occurred_at_utc"),
            ProcessedAtUtc = reader.IsNull("processed_at_utc") ? null : reader.ReadDateTime("processed_at_utc")
        };

    private static async Task MarkProcessedAsync(ISqlSugarClient db, CommentMutationOutboxEvent item, ClaimState claim, DateTime now)
    {
        await claim.OperationGate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (claim.OwnerState != ClaimOwnerState.Owned)
                throw new CommentMutationOutboxClaimLostException(item.Id);
            IReadOnlyList<string> requiredConsumers = GetRequiredConsumers(item);
            string requiredConsumerSql = string.Join(", ", requiredConsumers.Select(static (_, index) => $"@RequiredConsumer{index}"));
            string requiredDigestSql = string.Join(
                "\n",
                requiredConsumers.Select(static (_, index) => $"""
                  AND EXISTS (SELECT 1 FROM comment_mutation_outbox_delivery delivery
                              WHERE delivery.outbox_event_id = comment_mutation_outbox.id
                                AND delivery.consumer_name = @RequiredConsumer{index}
                                AND delivery.status = 'completed'
                                AND delivery.result_digest = @RequiredDigest{index})
                  """));
            string deliveryConstraint = requiredConsumers.Count == 0
                ? string.Empty
                : $"""
                  AND (SELECT COUNT(*) FROM comment_mutation_outbox_delivery delivery
                       WHERE delivery.outbox_event_id = comment_mutation_outbox.id
                         AND delivery.consumer_name IN ({requiredConsumerSql})
                         AND delivery.status = 'completed' AND delivery.result_digest IS NOT NULL) = {requiredConsumers.Count}
                  AND NOT EXISTS (SELECT 1 FROM comment_mutation_outbox_delivery delivery
                                  WHERE delivery.outbox_event_id = comment_mutation_outbox.id
                                    AND delivery.consumer_name IN ({requiredConsumerSql})
                                    AND (delivery.status <> 'completed' OR delivery.result_digest IS NULL))
                  {requiredDigestSql}
                  """;
            var parameters = new List<SugarParameter>
            {
                new("@Processed", CommentMutationOutboxStatus.Processed),
                new("@Processing", CommentMutationOutboxStatus.Processing),
                new("@Now", now),
                new("@Id", item.Id),
                new("@ClaimToken", item.ClaimToken),
                new("@ClaimedBy", item.ClaimedBy),
                new("@LeaseGeneration", item.LeaseGeneration)
            };
            for (int index = 0; index < requiredConsumers.Count; index++)
            {
                string consumer = requiredConsumers[index];
                parameters.Add(new SugarParameter($"@RequiredConsumer{index}", consumer));
                parameters.Add(new SugarParameter($"@RequiredDigest{index}", BuildDeliveryResultDigest(item, consumer)));
            }
            int updated = await db.Ado.ExecuteCommandAsync(
                $"""
            UPDATE comment_mutation_outbox
            SET status = @Processed, processed_at_utc = @Now, claim_token = NULL,
                claimed_at = NULL, lease_expires_at = NULL, last_error = NULL
            WHERE id = @Id AND status = @Processing AND claim_token = @ClaimToken AND claimed_by = @ClaimedBy
              AND lease_generation = @LeaseGeneration AND lease_expires_at > @Now
              {deliveryConstraint};
            """,
                parameters.ToArray());
            if (updated != 1)
            {
                claim.MarkLost();
                throw new CommentMutationOutboxClaimLostException(item.Id);
            }
            claim.OwnerState = ClaimOwnerState.Released;
        }
        finally { claim.OperationGate.Release(); }
    }

    private static async Task MarkFailedAsync(ISqlSugarClient db, CommentMutationOutboxEvent item, ClaimState claim, Exception exception, DateTime now)
    {
        await claim.OperationGate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (claim.OwnerState != ClaimOwnerState.Owned)
                throw new CommentMutationOutboxClaimLostException(item.Id);
            int attempt = item.AttemptCount + 1;
            string status = attempt >= PoisonThreshold ? CommentMutationOutboxStatus.Poison : CommentMutationOutboxStatus.Failed;
            DateTime next = now.AddSeconds(Math.Min(300, Math.Pow(2, Math.Min(attempt, 8))));
            int updated = await db.Ado.ExecuteCommandAsync(
                """
            UPDATE comment_mutation_outbox
            SET status = @Status, attempt_count = @Attempt, next_attempt_at = @Next,
                claim_token = NULL, claimed_at = NULL, lease_expires_at = NULL, last_error = @Error
            WHERE id = @Id AND status = @Processing AND claim_token = @ClaimToken AND claimed_by = @ClaimedBy
              AND lease_generation = @LeaseGeneration AND lease_expires_at > @Now
              AND EXISTS (SELECT 1 FROM comment_mutation_outbox_delivery delivery
                          WHERE delivery.outbox_event_id = comment_mutation_outbox.id
                            AND delivery.status IN ('retryable-failed', 'terminal-failed'));
            """,
                new SugarParameter("@Status", status),
                new SugarParameter("@Attempt", attempt),
                new SugarParameter("@Next", next),
                new SugarParameter("@Error", SanitizeError(exception)),
                new SugarParameter("@Id", item.Id),
                new SugarParameter("@Processing", CommentMutationOutboxStatus.Processing),
                new SugarParameter("@ClaimToken", item.ClaimToken),
                new SugarParameter("@ClaimedBy", item.ClaimedBy),
                new SugarParameter("@LeaseGeneration", item.LeaseGeneration),
                new SugarParameter("@Now", now));
            if (updated != 1)
            {
                claim.MarkLost();
                throw new CommentMutationOutboxClaimLostException(item.Id);
            }
            claim.OwnerState = ClaimOwnerState.Released;
        }
        finally { claim.OperationGate.Release(); }
    }

    private static IReadOnlyList<string> GetRequiredConsumers(CommentMutationOutboxEvent item)
        => CommentMutationOutboxConsumers.RequiredFor(item.EventType);

    private async Task EnsureClaimOwnedAsync(ISqlSugarClient db, ClaimState claim, CancellationToken cancellationToken, bool heartbeat = false)
    {
        await claim.OperationGate.WaitAsync().ConfigureAwait(false);
        try
        {
            if (claim.OwnerState != ClaimOwnerState.Owned)
                throw new CommentMutationOutboxClaimLostException(claim.Event.Id);
            DateTime now = timeProvider.GetUtcNow().UtcDateTime;
            int updated;
            try
            {
                if (heartbeat && heartbeatFaultInjector?.Invoke() is Exception fault)
                    throw fault;
                updated = await db.Ado.ExecuteCommandAsync(
                    heartbeat
                        ? """
                          UPDATE comment_mutation_outbox SET last_heartbeat_at = @Now, lease_expires_at = @Expires
                          WHERE id = @Id AND status = 'processing' AND claim_token = @ClaimToken AND claimed_by = @ClaimedBy
                            AND lease_generation = @LeaseGeneration AND lease_expires_at > @Now;
                          """
                        : """
                          UPDATE comment_mutation_outbox SET status = status
                          WHERE id = @Id AND status = 'processing' AND claim_token = @ClaimToken AND claimed_by = @ClaimedBy
                            AND lease_generation = @LeaseGeneration AND lease_expires_at > @Now;
                          """,
                    new SugarParameter("@Now", now), new SugarParameter("@Expires", now.Add(GetClaimLeaseDuration())),
                    new SugarParameter("@Id", claim.Event.Id), new SugarParameter("@ClaimToken", claim.Event.ClaimToken),
                    new SugarParameter("@ClaimedBy", claim.Event.ClaimedBy), new SugarParameter("@LeaseGeneration", claim.Event.LeaseGeneration));
            }
            catch (Exception)
            {
                claim.MarkLost();
                throw new CommentMutationOutboxClaimLostException(claim.Event.Id);
            }
            if (updated != 1)
            {
                claim.MarkLost();
                throw new CommentMutationOutboxClaimLostException(claim.Event.Id);
            }
            if (heartbeat)
            {
                await db.Ado.ExecuteCommandAsync(
                    """
                    UPDATE comment_mutation_outbox_delivery delivery
                    SET lease_expires_at = @Expires, updated_at_utc = (now() AT TIME ZONE 'utc')
                    FROM comment_mutation_outbox outbox
                    WHERE delivery.outbox_event_id = @Id AND delivery.status = 'processing'
                      AND delivery.owner_claim_token = @ClaimToken AND delivery.owner_worker_id = @ClaimedBy
                      AND delivery.lease_generation = @LeaseGeneration
                      AND outbox.id = delivery.outbox_event_id AND outbox.status = 'processing'
                      AND outbox.claim_token = @ClaimToken AND outbox.claimed_by = @ClaimedBy
                      AND outbox.lease_generation = @LeaseGeneration AND outbox.lease_expires_at > @Now;
                    """,
                    new SugarParameter("@Expires", now.Add(GetClaimLeaseDuration())),
                    new SugarParameter("@Id", claim.Event.Id), new SugarParameter("@ClaimToken", claim.Event.ClaimToken),
                    new SugarParameter("@ClaimedBy", claim.Event.ClaimedBy), new SugarParameter("@LeaseGeneration", claim.Event.LeaseGeneration),
                    new SugarParameter("@Now", now)).ConfigureAwait(false);
                claim.Event.LastHeartbeatAt = now;
                claim.Event.LeaseExpiresAt = now.Add(GetClaimLeaseDuration());
                claim.IncrementRenewed();
                s_heartbeat.Add(1);
            }
        }
        finally { claim.OperationGate.Release(); }
    }

    private async Task MaintainClaimHeartbeatsAsync(IReadOnlyDictionary<long, ClaimState> claims, CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                await Task.Delay(GetHeartbeatInterval(), timeProvider, cancellationToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested) { return; }
            using IServiceScope scope = scopeFactory.CreateScope();
            ISqlSugarClient db = scope.ServiceProvider.GetRequiredService<ISqlSugarClient>();
            foreach (ClaimState claim in claims.Values.Where(static value => value.OwnerState == ClaimOwnerState.Owned))
            {
                try
                {
                    await EnsureClaimOwnedAsync(db, claim, cancellationToken, heartbeat: true).ConfigureAwait(false);
                    UpdateLeaseRuntimeState(claims.Values, renewed: 1);
                }
                catch (CommentMutationOutboxClaimLostException)
                {
                    bool newlyLost = claim.TryRecordLost();
                    if (newlyLost)
                        s_claimLost.Add(1);
                    UpdateLeaseRuntimeState(claims.Values, lost: newlyLost ? 1 : 0);
                }
                catch (Exception ex)
                {
                    claim.MarkLost();
                    bool newlyLost = claim.TryRecordLost();
                    if (newlyLost)
                        s_claimLost.Add(1);
                    UpdateLeaseRuntimeState(claims.Values, lost: newlyLost ? 1 : 0);
                    logger.LogWarning(ex, "评论 Outbox heartbeat 失败 | EventId: {EventId}", claim.Event.EventId);
                }
            }
        }
    }

    private static async Task<int> ReleaseOwnedClaimsAsync(ISqlSugarClient db, IEnumerable<ClaimState> claims, Func<CommentMutationOutboxEvent, Task>? beforeReleaseClaim, CancellationToken cancellationToken)
    {
        int lost = 0;
        foreach (ClaimState claim in claims.Where(static value => value.OwnerState == ClaimOwnerState.Owned))
        {
            await claim.OperationGate.WaitAsync(cancellationToken).ConfigureAwait(false);
            try
            {
                if (claim.OwnerState != ClaimOwnerState.Owned)
                    continue;
                if (beforeReleaseClaim is not null)
                    await beforeReleaseClaim(claim.Event).ConfigureAwait(false);
                int updated = await db.Ado.ExecuteCommandAsync(
                    "UPDATE comment_mutation_outbox SET status = 'pending', claim_token = NULL, claimed_by = NULL, claimed_at = NULL, lease_expires_at = NULL, last_heartbeat_at = NULL WHERE id = @Id AND status = 'processing' AND claim_token = @ClaimToken AND claimed_by = @ClaimedBy AND lease_generation = @LeaseGeneration;",
                    new SugarParameter("@Id", claim.Event.Id), new SugarParameter("@ClaimToken", claim.Event.ClaimToken), new SugarParameter("@ClaimedBy", claim.Event.ClaimedBy), new SugarParameter("@LeaseGeneration", claim.Event.LeaseGeneration));
                if (updated == 1)
                    claim.OwnerState = ClaimOwnerState.Released;
                else
                {
                    claim.MarkLost();
                    if (claim.TryRecordLost())
                        lost++;
                }
            }
            finally { claim.OperationGate.Release(); }
        }
        return lost;
    }

    private static async Task<OutboxCounts> LoadCountsAsync(ISqlSugarClient db, DateTime now, CancellationToken cancellationToken)
    {
        await using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT
                COUNT(*) FILTER (WHERE status IN ('pending','processing','failed'))::integer AS pending_count,
                COUNT(*) FILTER (WHERE status = 'failed')::integer AS failed_count,
                COUNT(*) FILTER (WHERE status = 'poison')::integer AS poison_count,
                COALESCE(EXTRACT(EPOCH FROM (@Now - MIN(occurred_at_utc) FILTER (WHERE status IN ('pending','processing','failed'))))::bigint, 0) AS oldest_pending_seconds
            FROM comment_mutation_outbox;
            """,
            new SugarParameter("@Now", now));
        await reader.ReadAsync(cancellationToken).ConfigureAwait(false);
        return new(
            reader.ReadInt32("pending_count"),
            reader.ReadInt32("failed_count"),
            reader.ReadInt32("poison_count"),
            reader.ReadInt64("oldest_pending_seconds"));
    }

    private TimeSpan GetPollInterval()
        => TimeSpan.FromMilliseconds(Math.Clamp(configuration.GetValue<int?>("CommentMutationOutbox:PollIntervalMs") ?? 1000, 100, 30000));

    private TimeSpan GetClaimLeaseDuration()
        => GetClaimLeaseDuration(configuration);

    internal static TimeSpan GetClaimLeaseDuration(IConfiguration? configuration)
        => TimeSpan.FromSeconds(Math.Clamp(configuration?.GetValue<int?>("CommentMutationOutbox:ClaimLeaseSeconds") ?? 60, 30, 300));

    private TimeSpan GetHeartbeatInterval()
        => GetHeartbeatInterval(configuration);

    internal static TimeSpan GetHeartbeatInterval(IConfiguration? configuration)
    {
        int leaseSeconds = (int)GetClaimLeaseDuration(configuration).TotalSeconds;
        int configured = configuration?.GetValue<int?>("CommentMutationOutbox:HeartbeatSeconds")
            ?? Math.Max(1, (leaseSeconds - 1) / 3);
        return TimeSpan.FromSeconds(Math.Clamp(configured, 1, Math.Max(1, (leaseSeconds - 1) / 3)));
    }

    private static string BuildWorkerId()
    {
        string value = $"{Environment.MachineName}:{Environment.ProcessId}";
        return value.Length <= 128 ? value : value[..128];
    }

    private void UpdateLeaseRuntimeState(IEnumerable<ClaimState> claims, int renewed = 0, int lost = 0, int reclaimed = 0)
    {
        ClaimState[] values = claims.ToArray();
        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        runtimeState.UpdateLeaseLifecycle(values.Count(static claim => claim.OwnerState == ClaimOwnerState.Owned), renewed, lost, reclaimed,
            GetOldestOwnedLeaseAge(values, now));
    }

    private static long GetOldestOwnedLeaseAge(IEnumerable<ClaimState> claims, DateTime now)
        => claims.Where(static claim => claim.OwnerState == ClaimOwnerState.Owned && claim.Event.ClaimedAt is not null)
            .Select(claim => (long)Math.Max(0, (now - claim.Event.ClaimedAt!.Value).TotalSeconds))
            .DefaultIfEmpty()
            .Max();

    private static IReadOnlyList<string> ParseCsv(string? value)
        => string.IsNullOrWhiteSpace(value)
            ? []
            : value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    private static string SanitizeError(Exception exception)
    {
        string value = $"{exception.GetType().Name}: {exception.Message}".ReplaceLineEndings(" ");
        return value.Length <= 1024 ? value : value[..1024];
    }

    private sealed record OutboxCounts(int Backlog, int Failed, int Poison, long OldestAgeSeconds);

    private sealed record ClaimedCommentMutationOutboxEvent(CommentMutationOutboxEvent Event, bool WasReclaimed);

    private sealed class ClaimState(CommentMutationOutboxEvent @event)
    {
        private readonly object _gate = new();
        public SemaphoreSlim OperationGate { get; } = new(1, 1);
        private ClaimOwnerState _ownerState = ClaimOwnerState.Owned;
        private int _renewed;
        private bool _lossRecorded;
        public CommentMutationOutboxEvent Event { get; } = @event;
        public ClaimOwnerState OwnerState
        {
            get
            {
                lock (_gate)
                    return _ownerState;
            }
            set
            {
                lock (_gate)
                    _ownerState = value;
            }
        }
        public int Renewed
        {
            get
            {
                lock (_gate)
                    return _renewed;
            }
        }
        public bool LossRecorded
        {
            get
            {
                lock (_gate)
                    return _lossRecorded;
            }
        }
        public void MarkLost()
        {
            lock (_gate)
                _ownerState = ClaimOwnerState.Lost;
        }
        public bool TryRecordLost()
        {
            lock (_gate)
            {
                if (_ownerState != ClaimOwnerState.Lost)
                    return false;
                if (_lossRecorded)
                    return false;
                _lossRecorded = true;
                return true;
            }
        }
        public void IncrementRenewed()
        {
            lock (_gate)
                _renewed++;
        }
    }

    private enum ClaimOwnerState
    {
        Owned, Lost, Released
    }

    private enum ConsumerReservation
    {
        Reserved,
        Completed,
        TerminalFailed,
        NotReserved
    }

    private sealed class CommentMutationOutboxClaimLostException(long outboxId) : Exception($"comment_mutation_outbox_claim_lost:{outboxId}");

    private sealed class CommentMutationOutboxTerminalDeliveryException(string message) : Exception(message);
}
