using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("comment")]
[SugarIndex("idx_comment_article_parent_id", nameof(ArticleId), OrderByType.Asc, nameof(ParentId), OrderByType.Asc, nameof(Id), OrderByType.Desc)]
[SugarIndex("idx_comment_article_root_id", nameof(ArticleId), OrderByType.Asc, nameof(RootId), OrderByType.Asc, nameof(Id), OrderByType.Asc)]
[SugarIndex("idx_comment_user_id_desc", nameof(UserId), OrderByType.Asc, nameof(Id), OrderByType.Desc)]
public class Comment
{
    [SugarColumn(IsPrimaryKey = true, ColumnName = "id")]
    public long Id { get; set; }

    [SugarColumn(ColumnName = "article_id")] // 🌟 必须显式映射
    public int ArticleId { get; set; }

    [SugarColumn(ColumnName = "content", ColumnDataType = "text")]
    public string Content { get; set; } = null!;

    [SugarColumn(ColumnName = "create_time")]
    public DateTime CreateTime { get; set; }

    [SugarColumn(ColumnName = "user_id")] // 🌟 必须显式映射
    public int UserId { get; set; }

    [SugarColumn(ColumnName = "parent_id", IsNullable = true)]
    public long? ParentId { get; set; }

    [SugarColumn(ColumnName = "root_id", IsNullable = true)]
    public long? RootId { get; set; }

    [SugarColumn(ColumnName = "reply_to_user_id", IsNullable = true)]
    public int? ReplyToUserId { get; set; }

    [SugarColumn(ColumnName = "reply_to_comment_id", IsNullable = true)]
    public long? ReplyToCommentId { get; set; }

    [SugarColumn(ColumnName = "depth")]
    public int Depth { get; set; }

    [SugarColumn(ColumnName = "is_deleted")]
    public bool IsDeleted { get; set; }

    [SugarColumn(ColumnName = "delete_reason", ColumnDataType = "text", IsNullable = true)]
    public string? DeleteReason { get; set; }

    [SugarColumn(ColumnName = "delete_time", IsNullable = true)]
    public DateTime? DeleteTime { get; set; }

    [Navigate(NavigateType.OneToOne, nameof(ArticleId))]
    public Article? Article { get; set; }

    [Navigate(NavigateType.OneToOne, nameof(UserId))]
    public User? User { get; set; }
}
