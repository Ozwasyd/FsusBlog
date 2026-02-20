using SqlSugar;

namespace FsusBlog.Server.Entities;

/// <summary>
/// 分类
/// </summary>
[SugarTable("Category")]
public class Category
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true)] //主键配置（自增）
    public int Id { get; set; }

    public string Name { get; set; }

    // 数据库表中没有 "Articles" 这一列
    [SugarColumn(IsIgnore = true)]
    public List<Article> Articles { get; set; } = [];
}

/// <summary>
/// 标签
/// </summary>
[SugarTable("Tag")]
public class Tag
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true)] //主键配置（自增）
    public int Id { get; set; }

    public string Name { get; set; }

    //如上
    [SugarColumn(IsIgnore = true)]
    public List<Article> Articles { get; set; } = [];
}