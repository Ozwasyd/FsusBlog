using SqlSugar;

namespace FsusBlog.Server.Entities;

// backfill-only legacy view seed. Runtime article view/read counters must not read this table as live state.
[SugarTable("article_view_seed")]
public sealed class ArticleViewSeed
{
    [SugarColumn(IsPrimaryKey = true, ColumnName = "article_id")]
    public int ArticleId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "legacy_views")]
    public int LegacyViews
    {
        get; set;
    }

    [SugarColumn(ColumnName = "seeded_at_utc")]
    public DateTime SeededAtUtc { get; set; } = DateTime.UtcNow;
}
