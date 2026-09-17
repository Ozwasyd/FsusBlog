using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("comment_revision")]
[SugarIndex("ux_comment_revision_comment_version", nameof(CommentId), OrderByType.Asc, nameof(Version), OrderByType.Asc, true)]
public sealed class CommentRevision
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

    [SugarColumn(ColumnName = "version")]
    public int Version
    {
        get; set;
    }

    [SugarColumn(ColumnName = "content", ColumnDataType = "text")]
    public string Content { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "content_sha256", Length = 64)]
    public string ContentSha256 { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "operation", Length = 24)]
    public string Operation { get; set; } = CommentRevisionOperations.Created;

    [SugarColumn(ColumnName = "created_at_utc")]
    public DateTime CreatedAtUtc
    {
        get; set;
    }

    [SugarColumn(ColumnName = "actor_account_id", IsNullable = true)]
    public int? ActorAccountId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "actor_admin_principal_id", IsNullable = true)]
    public long? ActorAdminPrincipalId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "actor_mode", Length = 32)]
    public string ActorMode { get; set; } = string.Empty;
}

public static class CommentRevisionOperations
{
    public const string Created = "created";
    public const string Edited = "edited";
    public const string Deleted = "deleted";
}

[SugarTable("comment_management_challenge")]
[SugarIndex("idx_comment_management_challenge_expiry", nameof(ExpiresAtUtc), OrderByType.Asc)]
public sealed class CommentManagementChallenge
{
    [SugarColumn(IsPrimaryKey = true, ColumnName = "challenge_hash", Length = 64)]
    public string ChallengeHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "comment_id")]
    public long CommentId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "purpose", Length = 24)]
    public string Purpose { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "expires_at_utc")]
    public DateTime ExpiresAtUtc
    {
        get; set;
    }

    [SugarColumn(ColumnName = "used_at_utc", IsNullable = true)]
    public DateTime? UsedAtUtc
    {
        get; set;
    }
}

[SugarTable("comment_author_appeal")]
[SugarIndex("idx_comment_author_appeal_comment_created", nameof(CommentId), OrderByType.Asc, nameof(CreatedAtUtc), OrderByType.Desc)]
public sealed class CommentAuthorAppeal
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

    [SugarColumn(ColumnName = "reason", Length = 1000)]
    public string Reason { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "created_at_utc")]
    public DateTime CreatedAtUtc
    {
        get; set;
    }

    [SugarColumn(ColumnName = "author_mode", Length = 32)]
    public string AuthorMode { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "account_id", IsNullable = true)]
    public int? AccountId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "status", Length = 24)]
    public string Status { get; set; } = "pending";

    [SugarColumn(ColumnName = "target_moderation_event_id", IsNullable = true)]
    public long? TargetModerationEventId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "reviewer_admin_principal_id", IsNullable = true)]
    public long? ReviewerAdminPrincipalId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "decision", Length = 24, IsNullable = true)]
    public string? Decision
    {
        get; set;
    }

    [SugarColumn(ColumnName = "decision_reason", Length = 1000, IsNullable = true)]
    public string? DecisionReason
    {
        get; set;
    }

    [SugarColumn(ColumnName = "decided_at_utc", IsNullable = true)]
    public DateTime? DecidedAtUtc
    {
        get; set;
    }
}
