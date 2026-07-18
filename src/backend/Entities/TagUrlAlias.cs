using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("tag_url_alias")]
[SugarIndex("idx_tag_url_alias_tag_id", nameof(TagId), OrderByType.Asc)]
public sealed class TagUrlAlias
{
    [SugarColumn(IsPrimaryKey = true, ColumnName = "normalized_name", Length = 256)]
    public string NormalizedName { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "tag_id")]
    public int TagId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "original_name", Length = 128)]
    public string OriginalName { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "created_at_utc")]
    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;
}
