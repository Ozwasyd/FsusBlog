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

    [SugarColumn(ColumnName = "updated_at_utc")]
    public DateTime UpdatedAtUtc { get; set; } = DateTime.UtcNow;

    [SugarColumn(ColumnName = "updated_by_admin_id", IsNullable = true)]
    public long? UpdatedByAdminId { get; set; }
}
