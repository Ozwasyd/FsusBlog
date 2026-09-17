using FsusBlog.Server.Contracts.Assets;

using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("content_asset")]
[SugarIndex("ux_content_asset_storage_key", nameof(StorageKey), OrderByType.Asc, true)]
public sealed class ContentAsset
{
    [SugarColumn(IsPrimaryKey = true, ColumnName = "id", ColumnDataType = "uuid")]
    public Guid AssetId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "storage_class", Length = 16)]
    public string StorageClass { get; set; } = "public";

    [SugarColumn(ColumnName = "storage_key", Length = 512)]
    public string StorageKey { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "media_type", Length = 127)]
    public string MimeType { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "extension", Length = 16)]
    public string Extension { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "byte_length")]
    public long SizeBytes
    {
        get; set;
    }

    [SugarColumn(ColumnName = "sha256", Length = 64, IsNullable = true)]
    public string? Sha256
    {
        get; set;
    }

    [SugarColumn(ColumnName = "width", IsNullable = true)]
    public int? WidthPixels
    {
        get; set;
    }

    [SugarColumn(ColumnName = "height", IsNullable = true)]
    public int? HeightPixels
    {
        get; set;
    }

    [SugarColumn(ColumnName = "owner_admin_principal_id", IsNullable = true)]
    public long? OwnerAdminPrincipalId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "state", Length = 16)]
    public string State { get; set; } = ContentAssetStates.Active;

    [SugarColumn(ColumnName = "created_at_utc")]
    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;

    [SugarColumn(ColumnName = "updated_at_utc")]
    public DateTime UpdatedAtUtc { get; set; } = DateTime.UtcNow;
}

[SugarTable("content_asset_reference")]
[SugarIndex("idx_content_asset_reference_source", nameof(SourceKind), OrderByType.Asc, nameof(SourceKey), OrderByType.Asc)]
public sealed class ContentAssetReference
{
    [SugarColumn(IsPrimaryKey = true, ColumnName = "asset_id", ColumnDataType = "uuid")]
    public Guid AssetId
    {
        get; set;
    }

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

    [SugarColumn(ColumnName = "alt_text", Length = 256, IsNullable = true)]
    public string? AltText
    {
        get; set;
    }

    [SugarColumn(ColumnName = "updated_at_utc")]
    public DateTime UpdatedAtUtc { get; set; } = DateTime.UtcNow;
}

[SugarTable("content_asset_cleanup_queue")]
[SugarIndex("idx_content_asset_cleanup_due", nameof(NotBeforeUtc), OrderByType.Asc)]
public sealed class ContentAssetCleanupQueueItem
{
    [SugarColumn(IsPrimaryKey = true, ColumnName = "asset_id", ColumnDataType = "uuid")]
    public Guid AssetId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "not_before_utc")]
    public DateTime NotBeforeUtc { get; set; } = DateTime.UtcNow;

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
