using SqlSugar;

namespace FsusBlog.Server.Entities;

/// <summary>
/// 分类
/// </summary>
[SugarTable("Category")]
[SugarIndex("uq_category_name", nameof(Name), OrderByType.Asc, true)]
public class Category
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true)] //主键配置（自增）
    public int Id { get; set; }

    [SugarColumn(Length = 128)]
    public string Name { get; set; } = string.Empty;

    // 数据库表中没有 "Articles" 这一列
    [SugarColumn(IsIgnore = true)]
    public List<Article> Articles { get; set; } = null!;
}

/// <summary>
/// 标签
/// </summary>
[SugarTable("Tag")]
[SugarIndex("uq_tag_name", nameof(Name), OrderByType.Asc, true)]
public class Tag
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true)] //主键配置（自增）
    public int Id { get; set; }

    [SugarColumn(Length = 128)]
    public string Name { get; set; } = string.Empty;

    //如上
    [SugarColumn(IsIgnore = true)]
    public List<Article> Articles { get; set; } = null!;
}
