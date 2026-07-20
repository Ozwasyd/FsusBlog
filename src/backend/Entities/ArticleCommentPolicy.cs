using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("article_comment_policy")]
public sealed class ArticleCommentPolicy
{
    [SugarColumn(IsPrimaryKey = true, ColumnName = "article_id")]
    public int ArticleId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "enabled", IsNullable = true)]
    public bool? Enabled
    {
        get; set;
    }

    [SugarColumn(ColumnName = "public_comments_enabled", IsNullable = true)]
    public bool? PublicCommentsEnabled
    {
        get; set;
    }

    [SugarColumn(ColumnName = "anonymous_comments_enabled", IsNullable = true)]
    public bool? AnonymousCommentsEnabled
    {
        get; set;
    }

    [SugarColumn(ColumnName = "moderation_mode", Length = 24, IsNullable = true)]
    public string? ModerationMode
    {
        get; set;
    }

    [SugarColumn(ColumnName = "slow_mode_seconds", IsNullable = true)]
    public int? SlowModeSeconds
    {
        get; set;
    }

    [SugarColumn(ColumnName = "closed_at_utc", IsNullable = true)]
    public DateTime? ClosedAtUtc
    {
        get; set;
    }

    [SugarColumn(ColumnName = "updated_by_admin_principal_id")]
    public long UpdatedByAdminPrincipalId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "policy_version")]
    public long PolicyVersion { get; set; } = 1;

    [SugarColumn(ColumnName = "updated_at_utc")]
    public DateTime UpdatedAtUtc { get; set; } = DateTime.UtcNow;
}

[SugarTable("comment_thread_policy")]
public sealed class CommentThreadPolicy
{
    [SugarColumn(IsPrimaryKey = true, ColumnName = "root_comment_id")]
    public long RootCommentId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "article_id")]
    public int ArticleId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "locked_at_utc", IsNullable = true)]
    public DateTime? LockedAtUtc
    {
        get; set;
    }

    [SugarColumn(ColumnName = "locked_by_admin_principal_id", IsNullable = true)]
    public long? LockedByAdminPrincipalId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "lock_reason", Length = 256, IsNullable = true)]
    public string? LockReason
    {
        get; set;
    }

    [SugarColumn(ColumnName = "policy_version")]
    public long PolicyVersion { get; set; } = 1;
}

[SugarTable("comment_policy_audit_event")]
public sealed class CommentPolicyAuditEvent
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnName = "id")]
    public long Id
    {
        get; set;
    }

    [SugarColumn(ColumnName = "article_id")]
    public int ArticleId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "root_comment_id", IsNullable = true)]
    public long? RootCommentId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "policy_version")]
    public long PolicyVersion
    {
        get; set;
    }

    [SugarColumn(ColumnName = "action", Length = 32)]
    public string Action { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "reason", Length = 256, IsNullable = true)]
    public string? Reason
    {
        get; set;
    }

    [SugarColumn(ColumnName = "admin_principal_id")]
    public long AdminPrincipalId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "occurred_at_utc")]
    public DateTime OccurredAtUtc
    {
        get; set;
    }
}
