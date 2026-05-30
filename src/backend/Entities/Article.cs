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

    // 头图
    [SugarColumn(Length = 512, IsNullable = true)]
    public string? CoverImageUrl { get; set; }

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

    [SugarColumn(ColumnName = "status")]
    public ArticleStatus Status { get; set; } = ArticleStatus.Published;

    [SugarColumn(ColumnName = "scheduled_publish_at", IsNullable = true)]
    public DateTime? ScheduledPublishAt { get; set; }

    [SugarColumn(ColumnName = "published_at", IsNullable = true)]
    public DateTime? PublishedAt { get; set; } = DateTime.UtcNow;

    [SugarColumn(ColumnName = "archived_at", IsNullable = true)]
    public DateTime? ArchivedAt { get; set; }

    [SugarColumn(ColumnName = "deleted_at", IsNullable = true)]
    public DateTime? DeletedAt { get; set; }

    // 逻辑删除
    [SugarColumn(IsNullable = false, DefaultValue = "false")]
    public bool IsDeleted { get; set; }
}

public enum ArticleStatus
{
    Draft = 0,
    Scheduled = 1,
    Published = 2,
    Archived = 3,
    Deleted = 4
}

public static class ArticlePublication
{
    public static bool IsPubliclyVisible(Article article, DateTime utcNow)
    {
        return !article.IsDeleted
            && article.Status == ArticleStatus.Published
            && (!article.PublishedAt.HasValue || article.PublishedAt.Value <= utcNow)
            && (!article.ScheduledPublishAt.HasValue || article.ScheduledPublishAt.Value <= utcNow);
    }
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

[SugarTable("article_draft")]
[SugarIndex("idx_article_draft_owner_key", nameof(OwnerUserId), OrderByType.Asc, nameof(DraftKey), OrderByType.Asc, true)]
public class ArticleDraft
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnName = "id")]
    public long Id { get; set; }

    [SugarColumn(ColumnName = "owner_user_id")]
    public int OwnerUserId { get; set; }

    [SugarColumn(ColumnName = "article_id", IsNullable = true)]
    public int? ArticleId { get; set; }

    [SugarColumn(ColumnName = "draft_key", Length = 96)]
    public string DraftKey { get; set; } = string.Empty;

    [SugarColumn(Length = 256)]
    public string Title { get; set; } = string.Empty;

    [SugarColumn(Length = 512, IsNullable = true)]
    public string? Summary { get; set; }

    [SugarColumn(ColumnName = "cover_image_url", Length = 512, IsNullable = true)]
    public string? CoverImageUrl { get; set; }

    public int CategoryId { get; set; }

    [SugarColumn(ColumnName = "tag_ids", ColumnDataType = "text")]
    public string TagIds { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "markdown_content", ColumnDataType = "text")]
    public string MarkdownContent { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "status")]
    public ArticleStatus Status { get; set; } = ArticleStatus.Published;

    [SugarColumn(ColumnName = "scheduled_publish_at", IsNullable = true)]
    public DateTime? ScheduledPublishAt { get; set; }

    [SugarColumn(ColumnName = "client_revision", Length = 64, IsNullable = true)]
    public string? ClientRevision { get; set; }

    [SugarColumn(ColumnName = "updated_at")]
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;

    [SugarColumn(ColumnName = "created_at")]
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

[SugarTable("article_revision")]
[SugarIndex("idx_article_revision_article_time", nameof(ArticleId), OrderByType.Asc, nameof(CreatedAt), OrderByType.Desc)]
public class ArticleRevision
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnName = "id")]
    public long Id { get; set; }

    [SugarColumn(ColumnName = "article_id")]
    public int ArticleId { get; set; }

    [SugarColumn(ColumnName = "revision_no")]
    public int RevisionNo { get; set; }

    [SugarColumn(Length = 256)]
    public string Title { get; set; } = string.Empty;

    [SugarColumn(Length = 512, IsNullable = true)]
    public string? Summary { get; set; }

    [SugarColumn(ColumnName = "cover_image_url", Length = 512, IsNullable = true)]
    public string? CoverImageUrl { get; set; }

    public int CategoryId { get; set; }

    [SugarColumn(ColumnName = "tag_ids", ColumnDataType = "text")]
    public string TagIds { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "markdown_content", ColumnDataType = "text")]
    public string MarkdownContent { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "diff_summary", Length = 512)]
    public string DiffSummary { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "created_by_user_id")]
    public int CreatedByUserId { get; set; }

    [SugarColumn(ColumnName = "created_at")]
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;
}

[SugarTable("asset_library_item")]
[SugarIndex("idx_asset_library_hash", nameof(Sha256), OrderByType.Asc)]
public class AssetLibraryItem
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnName = "id")]
    public long Id { get; set; }

    [SugarColumn(ColumnName = "url", Length = 512)]
    public string Url { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "alt_text", Length = 256, IsNullable = true)]
    public string? AltText { get; set; }

    [SugarColumn(ColumnName = "source_article_id", IsNullable = true)]
    public int? SourceArticleId { get; set; }

    [SugarColumn(ColumnName = "width", IsNullable = true)]
    public int? Width { get; set; }

    [SugarColumn(ColumnName = "height", IsNullable = true)]
    public int? Height { get; set; }

    [SugarColumn(ColumnName = "sha256", Length = 64, IsNullable = true)]
    public string? Sha256 { get; set; }

    [SugarColumn(ColumnName = "reference_count")]
    public int ReferenceCount { get; set; }

    [SugarColumn(ColumnName = "created_at")]
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    [SugarColumn(ColumnName = "updated_at")]
    public DateTime UpdatedAt { get; set; } = DateTime.UtcNow;
}

[SugarTable("site_subscription")]
[SugarIndex("idx_site_subscription_email", nameof(EmailHash), OrderByType.Asc, true)]
public class SiteSubscription
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true, ColumnName = "id")]
    public long Id { get; set; }

    [SugarColumn(ColumnName = "email_hash", Length = 64)]
    public string EmailHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "channel", Length = 32)]
    public string Channel { get; set; } = "rss";

    [SugarColumn(ColumnName = "is_enabled")]
    public bool IsEnabled { get; set; } = true;

    [SugarColumn(ColumnName = "created_at")]
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    [SugarColumn(ColumnName = "unsubscribed_at", IsNullable = true)]
    public DateTime? UnsubscribedAt { get; set; }
}
