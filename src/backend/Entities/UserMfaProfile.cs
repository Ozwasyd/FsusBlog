using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("user_mfa_profile")]
[SugarIndex("unique_idx_user_mfa_profile_user", nameof(UserId), OrderByType.Asc, true)]
public class UserMfaProfile
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true)]
    public long Id { get; set; }

    [SugarColumn(ColumnName = "user_id")]
    public int UserId { get; set; }

    [SugarColumn(ColumnName = "mfa_secret_encrypted", IsNullable = true, ColumnDataType = "text")]
    public string? MfaSecretEncrypted { get; set; }

    [SugarColumn(ColumnName = "mfa_pending_secret_encrypted", IsNullable = true, ColumnDataType = "text")]
    public string? MfaPendingSecretEncrypted { get; set; }

    [SugarColumn(ColumnName = "mfa_pending_created_at", IsNullable = true)]
    public DateTime? MfaPendingCreatedAt { get; set; }

    [SugarColumn(ColumnName = "mfa_verified_at", IsNullable = true)]
    public DateTime? MfaVerifiedAt { get; set; }

    [SugarColumn(ColumnName = "mfa_recovery_codes_hash", IsNullable = true, ColumnDataType = "text")]
    public string? MfaRecoveryCodesHash { get; set; }

    [SugarColumn(ColumnName = "last_totp_step", IsNullable = true)]
    public long? LastTotpStep { get; set; }

    [SugarColumn(ColumnName = "last_totp_used_at_utc", IsNullable = true)]
    public DateTime? LastTotpUsedAtUtc { get; set; }

    [SugarColumn(ColumnName = "hash_version")]
    public short MfaRecoveryCodesHashVersion { get; set; } = 1;

    [SugarColumn(ColumnName = "updated_at_utc")]
    public DateTime UpdatedAtUtc { get; set; } = DateTime.UtcNow;
}
