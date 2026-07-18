using FsusBlog.Server.Models.CommentIdentity;

using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("comment")]
[SugarIndex("idx_comment_article_parent_id", nameof(ArticleId), OrderByType.Asc, nameof(ParentId), OrderByType.Asc, nameof(Id), OrderByType.Desc)]
[SugarIndex("idx_comment_article_root_id", nameof(ArticleId), OrderByType.Asc, nameof(RootId), OrderByType.Asc, nameof(Id), OrderByType.Asc)]
public class Comment
{
    [SugarColumn(IsPrimaryKey = true, ColumnName = "id")]
    public long Id
    {
        get; set;
    }

    [SugarColumn(ColumnName = "article_id")] // 🌟 必须显式映射
    public int ArticleId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "content", ColumnDataType = "text")]
    public string Content { get; set; } = null!;

    [SugarColumn(ColumnName = "create_time")]
    public DateTime CreateTime
    {
        get; set;
    }

    [SugarColumn(ColumnName = "user_id", IsNullable = true)] // 🌟 必须显式映射
    public int? UserId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "author_mode", Length = 48)]
    public string AuthorMode { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "public_handle", Length = 64, IsNullable = true)]
    public string? PublicHandle
    {
        get; set;
    }

    [SugarColumn(ColumnName = "anonymous_handle", Length = 64, IsNullable = true)]
    public string? AnonymousHandle
    {
        get; set;
    }

    [SugarColumn(ColumnName = "anonymous_display_name", Length = 96, IsNullable = true)]
    public string? AnonymousDisplayName
    {
        get; set;
    }

    [SugarColumn(ColumnName = "anonymous_display_language", Length = 16, IsNullable = true)]
    public string? AnonymousDisplayLanguage
    {
        get; set;
    }

    [SugarColumn(ColumnName = "anonymous_nullifier_hash", Length = 128, IsNullable = true)]
    public string? AnonymousNullifierHash
    {
        get; set;
    }

    [SugarColumn(ColumnName = "anonymous_scope", Length = 128, IsNullable = true)]
    public string? AnonymousScope
    {
        get; set;
    }

    [SugarColumn(ColumnName = "moderation_subject_hash", Length = 128, IsNullable = true)]
    public string? ModerationSubjectHash
    {
        get; set;
    }

    [SugarColumn(ColumnName = "credential_level", Length = 32, IsNullable = true)]
    public string? CredentialLevel
    {
        get; set;
    }

    [SugarColumn(ColumnName = "reputation_bucket", Length = 32, IsNullable = true)]
    public string? ReputationBucket
    {
        get; set;
    }

    [SugarColumn(ColumnName = "account_age_bucket", Length = 32, IsNullable = true)]
    public string? AccountAgeBucket
    {
        get; set;
    }

    [SugarColumn(ColumnName = "anonymous_rate_class", Length = 16, IsNullable = true)]
    public string? AnonymousRateClass
    {
        get; set;
    }

    [SugarColumn(ColumnName = "anonymous_requires_moderation", IsNullable = true)]
    public bool? AnonymousRequiresModeration
    {
        get; set;
    }

    [SugarColumn(ColumnName = "parent_id", IsNullable = true)]
    public long? ParentId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "root_id", IsNullable = true)]
    public long? RootId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "reply_to_user_id", IsNullable = true)]
    public int? ReplyToUserId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "reply_to_comment_id", IsNullable = true)]
    public long? ReplyToCommentId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "depth")]
    public int Depth
    {
        get; set;
    }

    [SugarColumn(ColumnName = "is_deleted")]
    public bool IsDeleted
    {
        get; set;
    }

    [SugarColumn(ColumnName = "delete_reason", ColumnDataType = "text", IsNullable = true)]
    public string? DeleteReason
    {
        get; set;
    }

    [SugarColumn(ColumnName = "delete_time", IsNullable = true)]
    public DateTime? DeleteTime
    {
        get; set;
    }

    [SugarColumn(ColumnName = "moderation_status")]
    public CommentModerationStatus ModerationStatus { get; set; } = CommentModerationStatus.Approved;

    [SugarColumn(ColumnName = "moderation_reason", Length = 256, IsNullable = true)]
    public string? ModerationReason
    {
        get; set;
    }

    [SugarColumn(ColumnName = "moderated_by_admin_principal_id", IsNullable = true)]
    public long? ModeratedByAdminPrincipalId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "moderated_at", IsNullable = true)]
    public DateTime? ModeratedAt
    {
        get; set;
    }

    [SugarColumn(IsIgnore = true)]
    public string? RowVersion
    {
        get; set;
    }

    [Navigate(NavigateType.OneToOne, nameof(ArticleId))]
    public Article? Article
    {
        get; set;
    }

    [Navigate(NavigateType.OneToOne, nameof(UserId))]
    public User? User
    {
        get; set;
    }
}

public enum CommentModerationStatus
{
    Pending = 0,
    Approved = 1,
    Rejected = 2,
    Hidden = 3
}
