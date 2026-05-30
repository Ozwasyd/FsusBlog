using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("article_view_seed")]
public sealed class ArticleViewSeed
{
    [SugarColumn(IsPrimaryKey = true, ColumnName = "article_id")]
    public int ArticleId { get; set; }

    [SugarColumn(ColumnName = "legacy_views")]
    public int LegacyViews { get; set; }

    [SugarColumn(ColumnName = "seeded_at_utc")]
    public DateTime SeededAtUtc { get; set; } = DateTime.UtcNow;
}
