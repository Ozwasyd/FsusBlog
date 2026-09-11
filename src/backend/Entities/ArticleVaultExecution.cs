using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("article_vault_execution_bundle")]
public sealed class ArticleVaultExecutionBundleEntity
{
    [SugarColumn(IsPrimaryKey = true, ColumnName = "plan_reference", Length = 256)]
    public string PlanReference { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "plan_sha256", Length = 64)]
    public string PlanSha256 { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "site_identity", Length = 128)]
    public string SiteIdentity { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "vault_identity", Length = 128)]
    public string VaultIdentity { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "idempotency_key", Length = 64)]
    public string IdempotencyKey { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "bundle_json", ColumnDataType = "text")]
    public string BundleJson { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "content_sha256", Length = 64)]
    public string ContentSha256 { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "expires_at_utc")]
    public DateTime ExpiresAtUtc
    {
        get; set;
    }

    [SugarColumn(ColumnName = "created_at_utc")]
    public DateTime CreatedAtUtc
    {
        get; set;
    }
}

[SugarTable("article_vault_group_result")]
public sealed class ArticleVaultGroupResultEntity
{
    [SugarColumn(IsPrimaryKey = true, ColumnName = "idempotency_sha256", Length = 64)]
    public string IdempotencySha256 { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "site_identity", Length = 128)]
    public string SiteIdentity { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "vault_identity", Length = 128)]
    public string VaultIdentity { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "plan_sha256", Length = 64)]
    public string PlanSha256 { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "group_identity", Length = 128)]
    public string GroupIdentity { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "receipt_json", ColumnDataType = "text")]
    public string ReceiptJson { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "content_sha256", Length = 64)]
    public string ContentSha256 { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "created_at_utc")]
    public DateTime CreatedAtUtc
    {
        get; set;
    }
}

[SugarTable("article_vault_execution_result")]
public sealed class ArticleVaultExecutionResultEntity
{
    [SugarColumn(IsPrimaryKey = true, ColumnName = "result_reference", Length = 256)]
    public string ResultReference { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "site_identity", Length = 128)]
    public string SiteIdentity { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "vault_identity", Length = 128)]
    public string VaultIdentity { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "plan_sha256", Length = 64)]
    public string PlanSha256 { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "result_json", ColumnDataType = "text")]
    public string ResultJson { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "content_sha256", Length = 64)]
    public string ContentSha256 { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "created_at_utc")]
    public DateTime CreatedAtUtc
    {
        get; set;
    }
}
