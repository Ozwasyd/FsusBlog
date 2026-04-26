using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("article_tag")]
[SugarIndex("idx_article_tag_article_tag", nameof(ArticleId), OrderByType.Asc, nameof(TagId), OrderByType.Asc, true)]
[SugarIndex("idx_article_tag_tag_article", nameof(TagId), OrderByType.Asc, nameof(ArticleId), OrderByType.Asc)]
public class ArticleTag
{
    [SugarColumn(IsPrimaryKey = true)] // 联合主键 part 1
    public int ArticleId { get; set; }

    [SugarColumn(IsPrimaryKey = true)] // 联合主键 part 2
    public int TagId { get; set; }
}

/// <summary>
/// 文章
/// </summary>
[SugarTable("article")]
[SugarIndex("idx_article_deleted_time", nameof(IsDeleted), OrderByType.Asc, nameof(CreateTime), OrderByType.Desc)]
[SugarIndex("idx_article_category_deleted_time", nameof(CategoryId), OrderByType.Asc, nameof(IsDeleted), OrderByType.Asc, nameof(CreateTime), OrderByType.Desc)]
public class Article
{
    // PostgreSQL 自增主键
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnName = "id")]
    public int Id { get; set; }

    [SugarColumn(Length = 256)]
    public string Title { get; set; } = null!;

    // 摘要
    [SugarColumn(Length = 512, IsNullable = true)]
    public string? Summary { get; set; }

    // 1. 分类 (多对一: Article -> Category)
    public int CategoryId { get; set; }

    // 导航属性: 不映射到数据库字段，查询时自动填充
    [SugarColumn(IsIgnore = true)]
    [Navigate(NavigateType.OneToOne, nameof(CategoryId))]
    public Category? Category { get; set; }

    // 2. 标签 (多对多: Article <-> Tag)
    // 导航属性: 通过中间表 ArticleTag 关联
    [SugarColumn(IsIgnore = true)]
    [Navigate(typeof(ArticleTag), nameof(ArticleTag.ArticleId), nameof(ArticleTag.TagId))]
    public List<Tag> Tags { get; set; } = [];

    // 正文从独立表加载；保留该属性只用于聚合读模型和搜索索引编译，不参与 article 元表持久化。
    [SugarColumn(IsIgnore = true)]
    public string Content { get; set; } = string.Empty;

    public int Views { get; set; } = 0;

    public DateTime CreateTime { get; set; } = DateTime.UtcNow;

    // 逻辑删除
    [SugarColumn(IsNullable = false, DefaultValue = "false")]
    public bool IsDeleted { get; set; }
}

[SugarTable("article_body")]
public class ArticleBody
{
    [SugarColumn(IsPrimaryKey = true, ColumnName = "article_id")]
    public int ArticleId { get; set; }

    [SugarColumn(ColumnName = "markdown_content", ColumnDataType = "text")]
    public string MarkdownContent { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "updated_at")]
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}
