using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("account_recovery_key")]
[SugarIndex("idx_account_recovery_key_user", nameof(UserId), OrderByType.Asc)]
[SugarIndex("idx_account_recovery_key_version", nameof(UserId), OrderByType.Asc, nameof(KeyVersion), OrderByType.Desc)]
public class RecoveryKeyCredential
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true)]
    public int Id { get; set; }

    [SugarColumn(ColumnName = "user_id")]
    public int UserId { get; set; }

    [SugarColumn(ColumnName = "key_hash", IsNullable = false, ColumnDataType = "text")]
    public string KeyHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "key_version", DefaultValue = "1")]
    public int KeyVersion { get; set; } = 1;

    [SugarColumn(ColumnName = "created_at")]
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    [SugarColumn(ColumnName = "used_at", IsNullable = true)]
    public DateTime? UsedAt { get; set; }

    [SugarColumn(ColumnName = "revoked_at", IsNullable = true)]
    public DateTime? RevokedAt { get; set; }
}
