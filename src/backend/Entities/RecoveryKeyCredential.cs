using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("account_recovery_key")]
[SugarIndex("idx_account_recovery_key_account", nameof(AccountId), OrderByType.Asc)]
[SugarIndex("idx_account_recovery_key_version", nameof(AccountId), OrderByType.Asc, nameof(KeyVersion), OrderByType.Desc)]
[SugarIndex("idx_account_recovery_key_lookup", nameof(LookupIdHash), OrderByType.Asc)]
public class RecoveryKeyCredential
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true)]
    public int Id
    {
        get; set;
    }

    [SugarColumn(ColumnName = "account_id")]
    public int AccountId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "lookup_id_hash", IsNullable = true, ColumnDataType = "text")]
    public string? LookupIdHash
    {
        get; set;
    }

    [SugarColumn(ColumnName = "key_hash", IsNullable = false, ColumnDataType = "text")]
    public string KeyHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "key_version", DefaultValue = "1")]
    public int KeyVersion { get; set; } = 1;

    [SugarColumn(ColumnName = "created_at")]
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    [SugarColumn(ColumnName = "used_at", IsNullable = true)]
    public DateTime? UsedAt
    {
        get; set;
    }

    [SugarColumn(ColumnName = "revoked_at", IsNullable = true)]
    public DateTime? RevokedAt
    {
        get; set;
    }
}
