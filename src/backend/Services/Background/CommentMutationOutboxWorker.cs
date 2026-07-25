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
    string? LastError);

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

    internal void Update(int backlog, int failed, int poison, long oldestAgeSeconds, int processedDelta, DateTime now, string? error)
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
                error);
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
    ILogger<CommentMutationOutboxWorker> logger) : BackgroundService
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
        List<CommentMutationOutboxEvent> events = await ClaimAsync(db, now, cancellationToken).ConfigureAwait(false);
        int processed = 0;
        string? lastError = null;
        foreach (CommentMutationOutboxEvent item in events)
        {
            try
            {
                await ProcessOneAsync(scope.ServiceProvider, db, item, cancellationToken).ConfigureAwait(false);
                await MarkProcessedAsync(db, item, timeProvider.GetUtcNow().UtcDateTime).ConfigureAwait(false);
                processed++;
                s_processed.Add(1);
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception ex)
            {
                lastError = ex.GetType().Name;
                s_failed.Add(1);
                await MarkFailedAsync(db, item, ex, timeProvider.GetUtcNow().UtcDateTime).ConfigureAwait(false);
                logger.LogError(ex, "评论 Outbox 消费失败 | EventId: {EventId} | EventType: {EventType} | Attempt: {Attempt}",
                    item.EventId,
                    item.EventType,
                    item.AttemptCount + 1);
            }
        }

        OutboxCounts counts = await LoadCountsAsync(db, now, cancellationToken).ConfigureAwait(false);
        runtimeState.Update(counts.Backlog, counts.Failed, counts.Poison, counts.OldestAgeSeconds, processed, now, lastError);
        s_backlog.Record(counts.Backlog);
        s_latency.Record(counts.OldestAgeSeconds);
        s_poison.Record(counts.Poison);
        return processed;
    }

    private async Task ProcessOneAsync(
        IServiceProvider services,
        ISqlSugarClient db,
        CommentMutationOutboxEvent item,
        CancellationToken cancellationToken)
    {
        if (item.EventType == CommentMutationEventTypes.Created)
        {
            await RunConsumerAsync(db, item, "model-moderation", ct => ApplyModerationAsync(services, db, item, ct), cancellationToken);
        }

        if (item.EventType is CommentMutationEventTypes.Created
            or CommentMutationEventTypes.ModerationChanged
            or CommentMutationEventTypes.Deleted
            or CommentMutationEventTypes.Edited
            or CommentMutationEventTypes.VisibilityChanged)
        {
            await RunConsumerAsync(db, item, "cache-version", ct => InvalidateCacheAsync(services, db, item, ct), cancellationToken);
            await RunConsumerAsync(db, item, "realtime-stream", ct => PublishRealtimeAsync(services, db, item, ct), cancellationToken);
            await RunConsumerAsync(db, item, "audit-projection", ct => VerifyAuditProjectionAsync(db, item, ct), cancellationToken);
        }

        if (item.EventType is CommentMutationEventTypes.ReplyNotificationRequested
            or CommentMutationEventTypes.Deleted
            or CommentMutationEventTypes.ModerationChanged)
        {
            await RunConsumerAsync(db, item, "site-notification", ct => DeliverNotificationAsync(services, db, item, ct), cancellationToken);
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

    private static async Task RunConsumerAsync(
        ISqlSugarClient db,
        CommentMutationOutboxEvent item,
        string consumer,
        Func<CancellationToken, Task> action,
        CancellationToken cancellationToken)
    {
        bool completed = await db.Queryable<CommentMutationOutboxDelivery>()
            .Where(row => row.OutboxEventId == item.Id
                && row.ConsumerName == consumer
                && row.Status == CommentMutationOutboxDeliveryStatus.Completed)
            .AnyAsync(cancellationToken)
            .ConfigureAwait(false);
        if (completed)
        {
            return;
        }

        try
        {
            await action(cancellationToken).ConfigureAwait(false);
            await UpsertDeliveryAsync(db, item.Id, consumer, CommentMutationOutboxDeliveryStatus.Completed, null).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            await UpsertDeliveryAsync(db, item.Id, consumer, CommentMutationOutboxDeliveryStatus.Failed, SanitizeError(ex)).ConfigureAwait(false);
            throw;
        }
    }

    private static Task UpsertDeliveryAsync(ISqlSugarClient db, long outboxId, string consumer, string status, string? error)
        => db.Ado.ExecuteCommandAsync(
            """
            INSERT INTO comment_mutation_outbox_delivery(outbox_event_id, consumer_name, status, attempt_count, last_error, updated_at_utc)
            VALUES (@OutboxId, @Consumer, @Status, 1, @Error, (now() AT TIME ZONE 'utc'))
            ON CONFLICT (outbox_event_id, consumer_name) DO UPDATE
            SET status = EXCLUDED.status,
                attempt_count = comment_mutation_outbox_delivery.attempt_count + 1,
                last_error = EXCLUDED.last_error,
                updated_at_utc = EXCLUDED.updated_at_utc;
            """,
            new SugarParameter("@OutboxId", outboxId),
            new SugarParameter("@Consumer", consumer),
            new SugarParameter("@Status", status),
            new SugarParameter("@Error", (object?)error ?? DBNull.Value));

    private static async Task<List<CommentMutationOutboxEvent>> ClaimAsync(
        ISqlSugarClient db,
        DateTime now,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        string token = Guid.NewGuid().ToString("N");
        DateTime leaseExpires = now.AddSeconds(60);
        var events = new List<CommentMutationOutboxEvent>(BatchSize);
        await using DbDataReader reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            WITH candidates AS (
                SELECT id
                FROM comment_mutation_outbox
                WHERE ((status IN (@Pending, @Failed) AND next_attempt_at <= @Now)
                    OR (status = @Processing AND lease_expires_at <= @Now))
                ORDER BY occurred_at_utc, id
                FOR UPDATE SKIP LOCKED
                LIMIT @BatchSize
            )
            UPDATE comment_mutation_outbox o
            SET status = @Processing,
                claim_token = @ClaimToken,
                claimed_at = @Now,
                lease_expires_at = @LeaseExpires
            FROM candidates c
            WHERE o.id = c.id
            RETURNING o.id, o.event_id, o.event_type, o.comment_id, o.article_id, o.root_id,
                      o.parent_id, o.account_id, o.reply_to_account_id, o.actor_admin_principal_id,
                      o.previous_status, o.next_status, o.payload_json, o.status, o.attempt_count,
                      o.next_attempt_at, o.claim_token, o.claimed_at, o.lease_expires_at,
                      o.last_error, o.occurred_at_utc, o.processed_at_utc;
            """,
            new SugarParameter("@Pending", CommentMutationOutboxStatus.Pending),
            new SugarParameter("@Failed", CommentMutationOutboxStatus.Failed),
            new SugarParameter("@Processing", CommentMutationOutboxStatus.Processing),
            new SugarParameter("@Now", now),
            new SugarParameter("@LeaseExpires", leaseExpires),
            new SugarParameter("@ClaimToken", token),
            new SugarParameter("@BatchSize", BatchSize));
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            events.Add(ReadEvent(reader));
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
            ClaimedAt = reader.IsNull("claimed_at") ? null : reader.ReadDateTime("claimed_at"),
            LeaseExpiresAt = reader.IsNull("lease_expires_at") ? null : reader.ReadDateTime("lease_expires_at"),
            LastError = reader.IsNull("last_error") ? null : reader.ReadString("last_error"),
            OccurredAtUtc = reader.ReadDateTime("occurred_at_utc"),
            ProcessedAtUtc = reader.IsNull("processed_at_utc") ? null : reader.ReadDateTime("processed_at_utc")
        };

    private static Task MarkProcessedAsync(ISqlSugarClient db, CommentMutationOutboxEvent item, DateTime now)
        => db.Ado.ExecuteCommandAsync(
            """
            UPDATE comment_mutation_outbox
            SET status = @Processed, processed_at_utc = @Now, claim_token = NULL,
                claimed_at = NULL, lease_expires_at = NULL, last_error = NULL
            WHERE id = @Id AND status = @Processing AND claim_token = @ClaimToken;
            """,
            new SugarParameter("@Processed", CommentMutationOutboxStatus.Processed),
            new SugarParameter("@Processing", CommentMutationOutboxStatus.Processing),
            new SugarParameter("@Now", now),
            new SugarParameter("@Id", item.Id),
            new SugarParameter("@ClaimToken", item.ClaimToken));

    private static Task MarkFailedAsync(ISqlSugarClient db, CommentMutationOutboxEvent item, Exception exception, DateTime now)
    {
        int attempt = item.AttemptCount + 1;
        string status = attempt >= PoisonThreshold ? CommentMutationOutboxStatus.Poison : CommentMutationOutboxStatus.Failed;
        DateTime next = now.AddSeconds(Math.Min(300, Math.Pow(2, Math.Min(attempt, 8))));
        return db.Ado.ExecuteCommandAsync(
            """
            UPDATE comment_mutation_outbox
            SET status = @Status, attempt_count = @Attempt, next_attempt_at = @Next,
                claim_token = NULL, claimed_at = NULL, lease_expires_at = NULL, last_error = @Error
            WHERE id = @Id AND status = @Processing AND claim_token = @ClaimToken;
            """,
            new SugarParameter("@Status", status),
            new SugarParameter("@Attempt", attempt),
            new SugarParameter("@Next", next),
            new SugarParameter("@Error", SanitizeError(exception)),
            new SugarParameter("@Id", item.Id),
            new SugarParameter("@Processing", CommentMutationOutboxStatus.Processing),
            new SugarParameter("@ClaimToken", item.ClaimToken));
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
}
