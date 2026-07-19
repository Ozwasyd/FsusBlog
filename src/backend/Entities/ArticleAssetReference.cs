using SqlSugar;

namespace FsusBlog.Server.Entities;

public static class ArticleAssetSourceKinds
{
    public const string CurrentArticle = "article";
    public const string Draft = "draft";
    public const string Revision = "revision";
}

[SugarTable("article_asset_reference")]
[SugarIndex("idx_article_asset_reference_source", nameof(SourceKind), OrderByType.Asc, nameof(SourceKey), OrderByType.Asc)]
[SugarIndex("idx_article_asset_reference_article", nameof(ArticleId), OrderByType.Asc)]
public sealed class ArticleAssetReference
{
    [SugarColumn(IsPrimaryKey = true, ColumnName = "normalized_url", Length = 512)]
    public string NormalizedUrl { get; set; } = string.Empty;

    [SugarColumn(IsPrimaryKey = true, ColumnName = "source_kind", Length = 16)]
    public string SourceKind { get; set; } = string.Empty;

    [SugarColumn(IsPrimaryKey = true, ColumnName = "source_key", Length = 160)]
    public string SourceKey { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "article_id", IsNullable = true)]
    public int? ArticleId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "reference_count")]
    public int ReferenceCount
    {
        get; set;
    }

    [SugarColumn(ColumnName = "updated_at_utc")]
    public DateTime UpdatedAtUtc { get; set; } = DateTime.UtcNow;
}

[SugarTable("article_asset_cleanup_queue")]
[SugarIndex("idx_article_asset_cleanup_due", nameof(NotBeforeUtc), OrderByType.Asc)]
public sealed class ArticleAssetCleanupQueueItem
{
    [SugarColumn(IsPrimaryKey = true, ColumnName = "normalized_url", Length = 512)]
    public string NormalizedUrl { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "not_before_utc")]
    public DateTime NotBeforeUtc
    {
        get; set;
    }

    [SugarColumn(ColumnName = "attempt_count")]
    public int AttemptCount
    {
        get; set;
    }

    [SugarColumn(ColumnName = "last_error", Length = 512, IsNullable = true)]
    public string? LastError
    {
        get; set;
    }

    [SugarColumn(ColumnName = "updated_at_utc")]
    public DateTime UpdatedAtUtc { get; set; } = DateTime.UtcNow;
}
