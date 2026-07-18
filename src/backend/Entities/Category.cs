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
    public int Id
    {
        get; set;
    }

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
    public int Id
    {
        get; set;
    }

    [SugarColumn(Length = 128)]
    public string Name { get; set; } = string.Empty;

    //如上
    [SugarColumn(IsIgnore = true)]
    public List<Article> Articles { get; set; } = null!;
}

[SugarTable("category_public_article_count")]
public sealed class CategoryPublicArticleCount
{
    [SugarColumn(IsPrimaryKey = true, ColumnName = "category_id")]
    public int CategoryId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "article_count")]
    public long ArticleCount
    {
        get; set;
    }

    [SugarColumn(ColumnName = "updated_at_utc")]
    public DateTime UpdatedAtUtc { get; set; } = DateTime.UtcNow;
}

[SugarTable("tag_public_article_count")]
public sealed class TagPublicArticleCount
{
    [SugarColumn(IsPrimaryKey = true, ColumnName = "tag_id")]
    public int TagId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "article_count")]
    public long ArticleCount
    {
        get; set;
    }

    [SugarColumn(ColumnName = "updated_at_utc")]
    public DateTime UpdatedAtUtc { get; set; } = DateTime.UtcNow;
}

[SugarTable("article_public_taxonomy_projection")]
public sealed class ArticlePublicTaxonomyProjection
{
    [SugarColumn(IsPrimaryKey = true, ColumnName = "article_id")]
    public int ArticleId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "category_id", IsNullable = true)]
    public int? CategoryId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "tag_ids", ColumnDataType = "text")]
    public string TagIds { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "updated_at_utc")]
    public DateTime UpdatedAtUtc { get; set; } = DateTime.UtcNow;
}
