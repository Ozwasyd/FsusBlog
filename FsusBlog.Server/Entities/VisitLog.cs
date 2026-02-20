using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("sys_visit_log")]
[SugarIndex("idx_visit_create_time", nameof(CreateTime), OrderByType.Desc, false)] // 为清理数据加速
public class VisitLog
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true)]
    public int Id { get; set; }
    public string IP { get; set; } = string.Empty;

    /// <summary>
    /// 用户ID (null 表示匿名用户)
    /// </summary>
    [SugarColumn(IsNullable = true)]
    public int? UserId { get; set; }
    public string Region { get; set; } = string.Empty;
    public DateTime CreateTime { get; set; }
}
