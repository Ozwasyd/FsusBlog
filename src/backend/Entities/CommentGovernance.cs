using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("comment_report")]
[SugarIndex("ux_comment_report_account", nameof(CommentId), OrderByType.Asc, nameof(ReporterAccountId), OrderByType.Asc, true)]
[SugarIndex("ux_comment_report_anonymous_scope", nameof(CommentId), OrderByType.Asc, nameof(ReporterScopeHash), OrderByType.Asc, true)]
[SugarIndex("idx_comment_report_queue", nameof(Status), OrderByType.Asc, nameof(RiskScore), OrderByType.Desc, nameof(CreatedAtUtc), OrderByType.Asc)]
public sealed class CommentReport
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnName = "id")]
    public long Id
    {
        get; set;
    }

    [SugarColumn(ColumnName = "comment_id")]
    public long CommentId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "reason_code", Length = 32)]
    public string ReasonCode { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "detail", Length = 1000, IsNullable = true)]
    public string? Detail
    {
        get; set;
    }

    [SugarColumn(ColumnName = "reporter_kind", Length = 24)]
    public string ReporterKind { get; set; } = CommentReporterKinds.Account;

    [SugarColumn(ColumnName = "reporter_account_id", IsNullable = true)]
    public int? ReporterAccountId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "reporter_scope_hash", Length = 64, IsNullable = true)]
    public string? ReporterScopeHash
    {
        get; set;
    }

    [SugarColumn(ColumnName = "risk_score")]
    public int RiskScore
    {
        get; set;
    }

    [SugarColumn(ColumnName = "status", Length = 24)]
    public string Status { get; set; } = CommentReportStatuses.Open;

    [SugarColumn(ColumnName = "created_at_utc")]
    public DateTime CreatedAtUtc
    {
        get; set;
    }
}

public static class CommentReportReasons
{
    private static readonly HashSet<string> s_allowed = new(StringComparer.Ordinal)
    {
        "spam", "harassment", "hate", "privacy", "illegal", "misinformation", "other"
    };

    public static bool IsAllowed(string? value) => value is not null && s_allowed.Contains(value);
}

public static class CommentReporterKinds
{
    public const string Account = "account";
    public const string ScopedAnonymous = "scoped_anonymous";
}

public static class CommentReportStatuses
{
    public const string Open = "open";
    public const string Reviewing = "reviewing";
    public const string Resolved = "resolved";
    public const string Dismissed = "dismissed";
}

[SugarTable("comment_moderation_event")]
public sealed class CommentModerationEvent
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnName = "id")]
    public long Id
    {
        get; set;
    }

    [SugarColumn(ColumnName = "comment_id")]
    public long CommentId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "event_type", Length = 24)]
    public string EventType { get; set; } = CommentModerationEventTypes.Pending;

    [SugarColumn(ColumnName = "previous_status", IsNullable = true)]
    public CommentModerationStatus? PreviousStatus
    {
        get; set;
    }

    [SugarColumn(ColumnName = "next_status")]
    public CommentModerationStatus NextStatus
    {
        get; set;
    }

    [SugarColumn(ColumnName = "actor_type", Length = 24)]
    public string ActorType { get; set; } = "system";

    [SugarColumn(ColumnName = "reason_code", Length = 256, IsNullable = true)]
    public string? ReasonCode
    {
        get; set;
    }

    [SugarColumn(ColumnName = "policy_version", Length = 96, IsNullable = true)]
    public string? PolicyVersion
    {
        get; set;
    }

    [SugarColumn(ColumnName = "model_version", Length = 96, IsNullable = true)]
    public string? ModelVersion
    {
        get; set;
    }

    [SugarColumn(ColumnName = "transition_source", Length = 32)]
    public string TransitionSource { get; set; } = "system";

    [SugarColumn(ColumnName = "admin_principal_id", IsNullable = true)]
    public long? AdminPrincipalId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "appeal_id", IsNullable = true)]
    public long? AppealId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "occurred_at_utc")]
    public DateTime OccurredAtUtc
    {
        get; set;
    }
}

public static class CommentModerationEventTypes
{
    public const string Create = "create";
    public const string Pending = "pending";
    public const string Approve = "approve";
    public const string Hide = "hide";
    public const string Reject = "reject";
    public const string Delete = "delete";
    public const string Restore = "restore";
    public const string Appeal = "appeal";
    public const string AppealDecision = "appeal_decision";
}
