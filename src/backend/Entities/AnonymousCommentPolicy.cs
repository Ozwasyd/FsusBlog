using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("anonymous_comment_policy")]
public sealed class AnonymousCommentPolicy
{
    [SugarColumn(IsPrimaryKey = true, ColumnName = "id")]
    public int Id { get; set; } = 1;

    [SugarColumn(ColumnName = "anonymous_comments_enabled")]
    public bool AnonymousCommentsEnabled { get; set; } = true;

    [SugarColumn(ColumnName = "public_comments_enabled")]
    public bool PublicCommentsEnabled { get; set; } = true;

    [SugarColumn(ColumnName = "zk_anonymous_enabled")]
    public bool ZkAnonymousEnabled { get; set; }

    [SugarColumn(ColumnName = "default_author_mode", Length = 32)]
    public string DefaultAuthorMode { get; set; } = "anonymous";

    [SugarColumn(ColumnName = "supported_display_languages", Length = 128)]
    public string SupportedDisplayLanguages { get; set; } = "zh-CN,en";

    [SugarColumn(ColumnName = "comment_max_chars")]
    public int CommentMaxChars { get; set; } = 1000;

    [SugarColumn(ColumnName = "comment_max_utf8_bytes")]
    public int CommentMaxUtf8Bytes { get; set; } = 4096;

    [SugarColumn(ColumnName = "snapshot_hash", Length = 64)]
    public string SnapshotHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "updated_reason", Length = 256, IsNullable = true)]
    public string? UpdatedReason { get; set; }

    [SugarColumn(ColumnName = "changed_by", Length = 64)]
    public string ChangedBy { get; set; } = "system";

    [SugarColumn(ColumnName = "updated_at_utc")]
    public DateTime UpdatedAtUtc { get; set; } = DateTime.UtcNow;

    [SugarColumn(ColumnName = "updated_by_admin_id", IsNullable = true)]
    public long? UpdatedByAdminId { get; set; }
}
