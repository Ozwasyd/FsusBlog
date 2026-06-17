using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("admin_passkey_credential")]
[SugarIndex("unique_idx_admin_passkey_cred_id", nameof(CredentialId), OrderByType.Asc, true)]
[SugarIndex("idx_admin_passkey_principal", nameof(AdminPrincipalId), OrderByType.Asc)]
public sealed class AdminPasskeyCredential
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true)]
    public long Id { get; set; }

    public long AdminPrincipalId { get; set; }

    [SugarColumn(Length = 512)]
    public string CredentialId { get; set; } = string.Empty;

    [SugarColumn(Length = 128)]
    public string UserHandle { get; set; } = string.Empty;

    [SugarColumn(ColumnDataType = "text")]
    public string PublicKey { get; set; } = string.Empty;

    [SugarColumn(DefaultValue = "0")]
    public long SignCount { get; set; }

    [SugarColumn(Length = 64, IsNullable = true)]
    public string? DeviceFriendlyName { get; set; }

    [SugarColumn(Length = 36)]
    public string AaGuid { get; set; } = string.Empty;

    [SugarColumn(Length = 128, IsNullable = true)]
    public string? Transports { get; set; }

    [SugarColumn(DefaultValue = "false")]
    public bool BackupEligible { get; set; }

    [SugarColumn(DefaultValue = "false")]
    public bool BackupState { get; set; }

    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;

    [SugarColumn(IsNullable = true)]
    public DateTime? LastUsedAtUtc { get; set; }
}
