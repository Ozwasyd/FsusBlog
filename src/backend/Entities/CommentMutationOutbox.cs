using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("comment_mutation_outbox")]
[SugarIndex("ux_comment_mutation_outbox_event_id", nameof(EventId), OrderByType.Asc, true)]
[SugarIndex("idx_comment_mutation_outbox_pending", nameof(Status), OrderByType.Asc, nameof(NextAttemptAt), OrderByType.Asc, nameof(Id), OrderByType.Asc)]
public sealed class CommentMutationOutboxEvent
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnName = "id")]
    public long Id
    {
        get; set;
    }

    [SugarColumn(ColumnName = "event_id", Length = 36)]
    public string EventId { get; set; } = Guid.NewGuid().ToString("D");

    [SugarColumn(ColumnName = "event_type", Length = 64)]
    public string EventType { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "comment_id")]
    public long CommentId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "article_id")]
    public int ArticleId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "root_id")]
    public long RootId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "parent_id", IsNullable = true)]
    public long? ParentId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "account_id", IsNullable = true)]
    public int? AccountId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "reply_to_account_id", IsNullable = true)]
    public int? ReplyToAccountId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "actor_admin_principal_id", IsNullable = true)]
    public long? ActorAdminPrincipalId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "previous_status", IsNullable = true)]
    public CommentModerationStatus? PreviousStatus
    {
        get; set;
    }

    [SugarColumn(ColumnName = "next_status", IsNullable = true)]
    public CommentModerationStatus? NextStatus
    {
        get; set;
    }

    [SugarColumn(ColumnName = "payload_json", ColumnDataType = "text")]
    public string PayloadJson { get; set; } = "{}";

    [SugarColumn(ColumnName = "status", Length = 24)]
    public string Status { get; set; } = CommentMutationOutboxStatus.Pending;

    [SugarColumn(ColumnName = "attempt_count")]
    public int AttemptCount
    {
        get; set;
    }

    [SugarColumn(ColumnName = "next_attempt_at")]
    public DateTime NextAttemptAt { get; set; } = DateTime.UtcNow;

    [SugarColumn(ColumnName = "claim_token", Length = 64, IsNullable = true)]
    public string? ClaimToken
    {
        get; set;
    }

    [SugarColumn(ColumnName = "claimed_by", Length = 128, IsNullable = true)]
    public string? ClaimedBy
    {
        get; set;
    }

    [SugarColumn(ColumnName = "lease_generation")]
    public long LeaseGeneration
    {
        get; set;
    }

    [SugarColumn(ColumnName = "claimed_at", IsNullable = true)]
    public DateTime? ClaimedAt
    {
        get; set;
    }

    [SugarColumn(ColumnName = "lease_expires_at", IsNullable = true)]
    public DateTime? LeaseExpiresAt
    {
        get; set;
    }

    [SugarColumn(ColumnName = "last_heartbeat_at", IsNullable = true)]
    public DateTime? LastHeartbeatAt
    {
        get; set;
    }

    [SugarColumn(ColumnName = "last_error", Length = 1024, IsNullable = true)]
    public string? LastError
    {
        get; set;
    }

    [SugarColumn(ColumnName = "occurred_at_utc")]
    public DateTime OccurredAtUtc { get; set; } = DateTime.UtcNow;

    [SugarColumn(ColumnName = "processed_at_utc", IsNullable = true)]
    public DateTime? ProcessedAtUtc
    {
        get; set;
    }
}

[SugarTable("comment_mutation_outbox_delivery")]
[SugarIndex("ux_comment_outbox_delivery_consumer", nameof(OutboxEventId), OrderByType.Asc, nameof(ConsumerName), OrderByType.Asc, true)]
public sealed class CommentMutationOutboxDelivery
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnName = "id")]
    public long Id
    {
        get; set;
    }

    [SugarColumn(ColumnName = "outbox_event_id")]
    public long OutboxEventId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "consumer_name", Length = 64)]
    public string ConsumerName { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "status", Length = 24)]
    public string Status { get; set; } = CommentMutationOutboxDeliveryStatus.Pending;

    [SugarColumn(ColumnName = "attempt_count")]
    public int AttemptCount
    {
        get; set;
    }

    [SugarColumn(ColumnName = "owner_claim_token", Length = 64, IsNullable = true)]
    public string? OwnerClaimToken
    {
        get; set;
    }

    [SugarColumn(ColumnName = "owner_worker_id", Length = 128, IsNullable = true)]
    public string? OwnerWorkerId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "lease_generation")]
    public long LeaseGeneration
    {
        get; set;
    }

    [SugarColumn(ColumnName = "started_at", IsNullable = true)]
    public DateTime? StartedAt
    {
        get; set;
    }

    [SugarColumn(ColumnName = "lease_expires_at", IsNullable = true)]
    public DateTime? LeaseExpiresAt
    {
        get; set;
    }

    [SugarColumn(ColumnName = "completed_at", IsNullable = true)]
    public DateTime? CompletedAt
    {
        get; set;
    }

    [SugarColumn(ColumnName = "result_digest", Length = 64, IsNullable = true)]
    public string? ResultDigest
    {
        get; set;
    }

    [SugarColumn(ColumnName = "last_failure_kind", Length = 64, IsNullable = true)]
    public string? LastFailureKind
    {
        get; set;
    }

    [SugarColumn(ColumnName = "last_error", Length = 1024, IsNullable = true)]
    public string? LastError
    {
        get; set;
    }

    [SugarColumn(ColumnName = "updated_at_utc")]
    public DateTime UpdatedAtUtc { get; set; } = DateTime.UtcNow;
}

public static class CommentMutationEventTypes
{
    public const string Created = "CommentCreated";
    public const string ModerationChanged = "CommentModerationChanged";
    public const string Deleted = "CommentDeleted";
    public const string Edited = "CommentEdited";
    public const string ReplyNotificationRequested = "CommentReplyNotificationRequested";
    public const string VisibilityChanged = "CommentVisibilityChanged";
}

public static class CommentMutationOutboxStatus
{
    public const string Pending = "pending";
    public const string Processing = "processing";
    public const string Processed = "processed";
    public const string Failed = "failed";
    public const string Poison = "poison";
}

public static class CommentMutationOutboxDeliveryStatus
{
    public const string Pending = "pending";
    public const string Processing = "processing";
    public const string Completed = "completed";
    public const string RetryableFailed = "retryable-failed";
    public const string TerminalFailed = "terminal-failed";
}
