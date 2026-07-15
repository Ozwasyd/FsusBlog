using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("article_read_hourly_aggregate")]
[SugarIndex("idx_article_read_hourly_hour", nameof(HourUtc), OrderByType.Desc, false)]
public sealed class ArticleReadHourlyAggregate
{
    [SugarColumn(ColumnName = "article_id", IsPrimaryKey = true)]
    public int ArticleId { get; set; }

    [SugarColumn(ColumnName = "hour_utc", IsPrimaryKey = true)]
    public DateTime HourUtc { get; set; }

    [SugarColumn(ColumnName = "read_count", IsNullable = false, DefaultValue = "0")]
    public long ReadCount { get; set; }

    [SugarColumn(ColumnName = "updated_at_utc", IsNullable = false)]
    public DateTime UpdatedAtUtc { get; set; }
}

[SugarTable("read_dwell_daily_aggregate")]
public sealed class ReadDwellDailyAggregate
{
    [SugarColumn(ColumnName = "stat_date", IsPrimaryKey = true)]
    public DateTime StatDate { get; set; }

    [SugarColumn(ColumnName = "dwell_bucket", IsPrimaryKey = true, Length = 16)]
    public string DwellBucket { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "read_count", IsNullable = false, DefaultValue = "0")]
    public long ReadCount { get; set; }

    [SugarColumn(ColumnName = "updated_at_utc", IsNullable = false)]
    public DateTime UpdatedAtUtc { get; set; }
}
