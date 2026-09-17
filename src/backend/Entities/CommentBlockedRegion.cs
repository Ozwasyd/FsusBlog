using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("comment_blocked_region")]
[SugarIndex("idx_comment_blocked_region_region_comment", nameof(RegionCode), OrderByType.Asc, nameof(CommentId), OrderByType.Asc)]
public sealed class CommentBlockedRegion
{
    [SugarColumn(ColumnName = "comment_id", IsPrimaryKey = true)]
    public long CommentId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "region_code", Length = 64, IsPrimaryKey = true)]
    public string RegionCode { get; set; } = string.Empty;
}
