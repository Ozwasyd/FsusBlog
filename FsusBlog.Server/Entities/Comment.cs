using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("comment")]
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

    [Navigate(NavigateType.OneToOne, nameof(ArticleId))]
    public Article? Article { get; set; }

    [Navigate(NavigateType.OneToOne, nameof(UserId))]
    public User? User { get; set; }
}