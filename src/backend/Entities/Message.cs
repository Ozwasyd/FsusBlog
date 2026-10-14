using SqlSugar;

namespace FsusBlog.Server.Entities;

public enum ConversationStatus
{
    Open = 0,
    Pending = 1,
    Closed = 2
}

public enum MessageSenderType
{
    Account = 0,
    Admin = 1,
    System = 2
}

[SugarTable("msg_conversation")]
[SugarIndex("idx_msg_conversation_last_activity", nameof(LastMessageAt), OrderByType.Desc)]
[SugarIndex("idx_msg_conversation_status_activity", nameof(Status), OrderByType.Asc, nameof(LastMessageAt), OrderByType.Desc)]
[SugarIndex("idx_msg_conversation_initiator_account", nameof(InitiatorAccountId), OrderByType.Asc, nameof(LastMessageAt), OrderByType.Desc)]
[SugarIndex("ux_msg_conversation_client_mutation", nameof(ClientMutationPrincipalKind), OrderByType.Asc, nameof(ClientMutationPrincipalId), OrderByType.Asc, nameof(ClientMutationId), OrderByType.Asc, true)]
[SugarIndex("ux_msg_conversation_source_message", nameof(SourceMessageId), OrderByType.Asc, true)]
public sealed class MessageConversation
{
    [SugarColumn(IsPrimaryKey = true)]
    public long Id
    {
        get; set;
    }

    [SugarColumn(Length = 160)]
    public string Subject { get; set; } = string.Empty;

    [SugarColumn(IsNullable = true)]
    public int? InitiatorAccountId
    {
        get; set;
    }

    public ConversationStatus Status { get; set; } = ConversationStatus.Open;

    public bool IsSystemSource
    {
        get; set;
    }

    [SugarColumn(IsNullable = true)]
    public long? SourceMessageId
    {
        get; set;
    }

    [SugarColumn(IsNullable = true, Length = 16)]
    public string? ClientMutationPrincipalKind
    {
        get; set;
    }

    [SugarColumn(IsNullable = true)]
    public long? ClientMutationPrincipalId
    {
        get; set;
    }

    [SugarColumn(IsNullable = true, Length = 64)]
    public string? ClientMutationId
    {
        get; set;
    }

    [SugarColumn(IsNullable = true, Length = 64)]
    public string? MutationRequestHash
    {
        get; set;
    }

    public MessageSenderType CreatedByType { get; set; } = MessageSenderType.System;

    [SugarColumn(IsNullable = true)]
    public int? CreatedByAccountId
    {
        get; set;
    }

    [SugarColumn(IsNullable = true)]
    public long? CreatedByAdminPrincipalId
    {
        get; set;
    }

    [SugarColumn(IsNullable = true, Length = 64)]
    public string? CreatedByAdminSessionAuditReference
    {
        get; set;
    }

    [SugarColumn(IsNullable = true)]
    public DateTime? ContentRedactedAt
    {
        get; set;
    }

    [SugarColumn(IsNullable = true, Length = 32)]
    public string? ContentRedactionReason
    {
        get; set;
    }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    public DateTime LastMessageAt { get; set; } = DateTime.UtcNow;

    [SugarColumn(IsIgnore = true)]
    public string? RowVersion
    {
        get; set;
    }
}

[SugarTable("msg_conversation_status_event")]
[SugarIndex("idx_msg_conversation_status_event_conversation_time", nameof(ConversationId), OrderByType.Asc, nameof(CreatedAt), OrderByType.Asc, nameof(Id), OrderByType.Asc)]
public sealed class ConversationStatusEvent
{
    [SugarColumn(IsPrimaryKey = true)]
    public long Id
    {
        get; set;
    }

    public long ConversationId
    {
        get; set;
    }

    public ConversationStatus PreviousStatus
    {
        get; set;
    }

    public ConversationStatus CurrentStatus
    {
        get; set;
    }

    public long AdminPrincipalId
    {
        get; set;
    }

    [SugarColumn(Length = 64)]
    public string AdminSessionAuditReference
    {
        get; set;
    } = string.Empty;

    [SugarColumn(Length = 256)]
    public string Reason
    {
        get; set;
    } = string.Empty;

    public DateTime CreatedAt
    {
        get; set;
    } = DateTime.UtcNow;
}

[SugarTable("msg_message")]
[SugarIndex("idx_msg_message_conversation_id", nameof(ConversationId), OrderByType.Asc, nameof(Id), OrderByType.Asc)]
[SugarIndex("ux_msg_message_client_mutation", nameof(ClientMutationPrincipalKind), OrderByType.Asc, nameof(ClientMutationPrincipalId), OrderByType.Asc, nameof(ClientMutationId), OrderByType.Asc, true)]
public sealed class ConversationMessage
{
    [SugarColumn(IsPrimaryKey = true)]
    public long Id
    {
        get; set;
    }

    public long ConversationId
    {
        get; set;
    }

    public MessageSenderType SenderType { get; set; } = MessageSenderType.System;

    [SugarColumn(IsNullable = true)]
    public int? SenderAccountId
    {
        get; set;
    }

    [SugarColumn(IsNullable = true)]
    public long? SenderAdminPrincipalId
    {
        get; set;
    }

    [SugarColumn(IsNullable = true, Length = 64)]
    public string? SenderAdminSessionAuditReference
    {
        get; set;
    }

    [SugarColumn(ColumnDataType = "text")]
    public string Body { get; set; } = string.Empty;

    public bool IsInternalNote
    {
        get; set;
    }

    [SugarColumn(IsNullable = true)]
    public DateTime? ContentRedactedAt
    {
        get; set;
    }

    [SugarColumn(IsNullable = true, Length = 32)]
    public string? ContentRedactionReason
    {
        get; set;
    }

    [SugarColumn(IsNullable = true, Length = 16)]
    public string? ClientMutationPrincipalKind
    {
        get; set;
    }

    [SugarColumn(IsNullable = true)]
    public long? ClientMutationPrincipalId
    {
        get; set;
    }

    [SugarColumn(IsNullable = true, Length = 64)]
    public string? ClientMutationId
    {
        get; set;
    }

    [SugarColumn(IsNullable = true, Length = 64)]
    public string? MutationRequestHash
    {
        get; set;
    }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

public static class MessageMutationPrincipalKinds
{
    public const string Account = "account";
    public const string Admin = "admin";
}

[SugarTable("msg_participant_state")]
[SugarIndex("idx_msg_participant_account_updated", nameof(AccountId), OrderByType.Asc, nameof(UpdatedAt), OrderByType.Desc)]
[SugarIndex("idx_msg_participant_account_unread", nameof(AccountId), OrderByType.Asc, nameof(UnreadCount), OrderByType.Desc)]
public sealed class ConversationParticipantState
{
    [SugarColumn(IsPrimaryKey = true)]
    public long ConversationId
    {
        get; set;
    }

    [SugarColumn(IsPrimaryKey = true)]
    public int AccountId
    {
        get; set;
    }

    [SugarColumn(IsNullable = true)]
    public long? LastReadMessageId
    {
        get; set;
    }

    public int UnreadCount
    {
        get; set;
    }

    [SugarColumn(IsNullable = true)]
    public DateTime? LastReadAt
    {
        get; set;
    }

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

[SugarTable("msg_admin_queue_state")]
[SugarIndex("idx_msg_admin_queue_unread_updated", nameof(UnreadCount), OrderByType.Desc, nameof(UpdatedAt), OrderByType.Desc)]
public sealed class AdminConversationQueueState
{
    [SugarColumn(IsPrimaryKey = true)]
    public long ConversationId
    {
        get; set;
    }

    [SugarColumn(IsNullable = true)]
    public long? LastReadMessageId
    {
        get; set;
    }

    public int UnreadCount
    {
        get; set;
    }

    [SugarColumn(IsNullable = true)]
    public DateTime? LastReadAt
    {
        get; set;
    }

    public long Version
    {
        get; set;
    } = 1;

    public DateTime UpdatedAt
    {
        get; set;
    } = DateTime.UtcNow;
}

[SugarTable("message_mutation_outbox")]
[SugarIndex("ux_message_mutation_outbox_delivery_key", nameof(DeliveryKey), OrderByType.Asc, true)]
[SugarIndex("idx_message_mutation_outbox_pending", nameof(Status), OrderByType.Asc, nameof(NextAttemptAt), OrderByType.Asc, nameof(Id), OrderByType.Asc)]
[SugarIndex("idx_message_mutation_outbox_claim", nameof(Status), OrderByType.Asc, nameof(LeaseExpiresAt), OrderByType.Asc, nameof(Id), OrderByType.Asc)]
public sealed class MessageMutationOutbox
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true)]
    public long Id
    {
        get; set;
    }

    [SugarColumn(Length = 160)]
    public string DeliveryKey { get; set; } = string.Empty;

    [SugarColumn(Length = 48)]
    public string EventKind { get; set; } = string.Empty;

    [SugarColumn(Length = 16)]
    public string AudienceKind { get; set; } = string.Empty;

    [SugarColumn(IsNullable = true)]
    public int? TargetAccountId
    {
        get; set;
    }

    public long ConversationId
    {
        get; set;
    }

    [SugarColumn(IsNullable = true)]
    public long? MessageId
    {
        get; set;
    }

    [SugarColumn(IsNullable = true)]
    public long? ReadThroughMessageId
    {
        get; set;
    }

    [SugarColumn(IsNullable = true)]
    public ConversationStatus? ConversationStatus
    {
        get; set;
    }

    [SugarColumn(Length = 24)]
    public string Status { get; set; } = MessageMutationOutboxStatus.Pending;

    public int AttemptCount
    {
        get; set;
    }

    public DateTime NextAttemptAt { get; set; } = DateTime.UtcNow;

    [SugarColumn(Length = 64, IsNullable = true)]
    public string? ClaimToken
    {
        get; set;
    }

    [SugarColumn(Length = 128, IsNullable = true)]
    public string? ClaimedBy
    {
        get; set;
    }

    [SugarColumn(IsNullable = true)]
    public DateTime? ClaimedAt
    {
        get; set;
    }

    [SugarColumn(IsNullable = true)]
    public DateTime? LeaseExpiresAt
    {
        get; set;
    }

    [SugarColumn(Length = 1024, IsNullable = true)]
    public string? LastError
    {
        get; set;
    }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    [SugarColumn(IsNullable = true)]
    public DateTime? ProcessedAt
    {
        get; set;
    }
}

public static class MessageMutationOutboxStatus
{
    public const string Pending = "pending";
    public const string Processing = "processing";
    public const string Processed = "processed";
    public const string Poison = "poison";
}

public static class MessageMutationOutboxEventKinds
{
    public const string ConversationUpsert = "conversation-upsert";
    public const string MessageAppend = "message-append";
    public const string ReadUpdated = "read-updated";
    public const string ConversationStatus = "conversation-status";
}

public static class MessageMutationOutboxAudiences
{
    public const string Account = "account";
    public const string Admins = "admins";
}
