using SqlSugar;

namespace FsusBlog.Server.Entities;

public enum MessageCategory
{
    /// <summary>全站公告 (拉模式)</summary>
    Broadcast = 1,
    /// <summary>系统通知 (删评、封禁等 - 推模式)</summary>
    SystemTask = 2,
    /// <summary>事务性通知 (点对点消息)</summary>
    Transactional = 3
}

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
public sealed class MessageConversation
{
    [SugarColumn(IsPrimaryKey = true)]
    public long Id { get; set; }

    [SugarColumn(Length = 160)]
    public string Subject { get; set; } = string.Empty;

    [SugarColumn(IsNullable = true)]
    public int? InitiatorAccountId { get; set; }

    public ConversationStatus Status { get; set; } = ConversationStatus.Open;

    public bool IsSystemSource { get; set; }

    [SugarColumn(IsNullable = true)]
    public long? SourceMessageId { get; set; }

    public MessageSenderType CreatedByType { get; set; } = MessageSenderType.System;

    [SugarColumn(IsNullable = true)]
    public int? CreatedByAccountId { get; set; }

    [SugarColumn(IsNullable = true)]
    public long? CreatedByAdminPrincipalId { get; set; }

    [SugarColumn(IsNullable = true, Length = 64)]
    public string? CreatedByAdminSessionId { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    public DateTime LastMessageAt { get; set; } = DateTime.UtcNow;

    [SugarColumn(IsIgnore = true)]
    public string? RowVersion { get; set; }
}

[SugarTable("msg_message")]
[SugarIndex("idx_msg_message_conversation_id", nameof(ConversationId), OrderByType.Asc, nameof(Id), OrderByType.Asc)]
public sealed class ConversationMessage
{
    [SugarColumn(IsPrimaryKey = true)]
    public long Id { get; set; }

    public long ConversationId { get; set; }

    public MessageSenderType SenderType { get; set; } = MessageSenderType.System;

    [SugarColumn(IsNullable = true)]
    public int? SenderAccountId { get; set; }

    [SugarColumn(IsNullable = true)]
    public long? SenderAdminPrincipalId { get; set; }

    [SugarColumn(IsNullable = true, Length = 64)]
    public string? SenderAdminSessionId { get; set; }

    [SugarColumn(ColumnDataType = "text")]
    public string Body { get; set; } = string.Empty;

    [SugarColumn(IsNullable = true, ColumnDataType = "text")]
    public string? AttachmentsMeta { get; set; }

    public bool IsInternalNote { get; set; }

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

[SugarTable("msg_participant_state")]
[SugarIndex("idx_msg_participant_account_updated", nameof(AccountId), OrderByType.Asc, nameof(UpdatedAt), OrderByType.Desc)]
[SugarIndex("idx_msg_participant_account_unread", nameof(AccountId), OrderByType.Asc, nameof(UnreadCount), OrderByType.Desc)]
public sealed class ConversationParticipantState
{
    [SugarColumn(IsPrimaryKey = true)]
    public long ConversationId { get; set; }

    [SugarColumn(IsPrimaryKey = true)]
    public int AccountId { get; set; }

    [SugarColumn(IsNullable = true)]
    public long? LastReadMessageId { get; set; }

    public int UnreadCount { get; set; }

    public bool Muted { get; set; }

    [SugarColumn(IsNullable = true)]
    public DateTime? LastReadAt { get; set; }

    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
