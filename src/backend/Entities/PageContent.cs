using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("page_content")]
[SugarIndex("uq_page_content_slug", nameof(Slug), OrderByType.Asc, true)]
public class PageContent
{
    [SugarColumn(IsPrimaryKey = true, Length = 64, ColumnName = "slug")]
    public string Slug { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "content", ColumnDataType = "text")]
    public string Content { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "updated_at")]
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
