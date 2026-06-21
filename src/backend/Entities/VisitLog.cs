using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("sys_visit_log")]
[SugarIndex("idx_visit_create_time", nameof(CreateTime), OrderByType.Desc, false)] // 为清理数据加速
[SugarIndex("idx_visit_region", nameof(Region), OrderByType.Asc, false)] // 为地区统计聚合加速
[SugarIndex("idx_visit_event_time", nameof(EventType), OrderByType.Asc, nameof(CreateTime), OrderByType.Desc)]
[SugarIndex("idx_visit_article_time", nameof(ArticleId), OrderByType.Asc, nameof(CreateTime), OrderByType.Desc)]
public class VisitLog
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true)]
    public int Id { get; set; }
    public string IP { get; set; } = string.Empty;

    public string Region { get; set; } = string.Empty;
    public DateTime CreateTime { get; set; }

    [SugarColumn(ColumnName = "event_type", Length = 32, IsNullable = false, DefaultValue = "'site_read'")]
    public string EventType { get; set; } = HumanReadEventTypes.SiteRead;

    [SugarColumn(ColumnName = "route_key", Length = 200, IsNullable = true)]
    public string? RouteKey { get; set; }

    [SugarColumn(ColumnName = "article_id", IsNullable = true)]
    public int? ArticleId { get; set; }

    [SugarColumn(ColumnName = "viewer_key_hash", Length = 64, IsNullable = true)]
    public string? ViewerKeyHash { get; set; }

    [SugarColumn(ColumnName = "proof_id", Length = 64, IsNullable = true)]
    public string? ProofId { get; set; }

    [SugarColumn(ColumnName = "dwell_ms")]
    public int DwellMs { get; set; }
}

public static class HumanReadEventTypes
{
    public const string SiteRead = "site_read";
    public const string ArticleRead = "article_read";
}
