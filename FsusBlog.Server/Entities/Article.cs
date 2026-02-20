using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("article_tag")]
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
public class Article
{
    // PostgreSQL 自增主键
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnName = "id")]
    public int Id { get; set; }

    [SugarColumn(Length = 200)]
    public string Title { get; set; } = null!;

    // 【关键】Markdown 内容
    // PostgreSQL 的 text 类型性能极佳，这里指定 ColumnDataType = "text"
    [SugarColumn(ColumnDataType = "text", IsNullable = true)]
    public string Content { get; set; } = null!;

    // 摘要
    [SugarColumn(Length = 500, IsNullable = true)]
    public string Summary { get; set; } = null!;

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

    public int Views { get; set; } = 0;

    public DateTime CreateTime { get; set; } = DateTime.UtcNow;

    // 逻辑删除
    [SugarColumn(IsNullable = false, DefaultValue = "false")]
    public bool IsDeleted { get; set; }
}

