using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("admin_principal")]
[SugarIndex("unique_idx_admin_principal_handle", nameof(Handle), OrderByType.Asc, true)]
[SugarIndex("idx_admin_principal_status", nameof(Status), OrderByType.Asc)]
public sealed class AdminPrincipal
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true)]
    public long Id
    {
        get; set;
    }

    [SugarColumn(Length = 64)]
    public string Handle { get; set; } = string.Empty;

    [SugarColumn(Length = 96, IsNullable = true)]
    public string? DisplayName
    {
        get; set;
    }

    [SugarColumn(Length = 32)]
    public string Status { get; set; } = AdminPrincipalStatus.Active;

    [SugarColumn(DefaultValue = "false")]
    public bool IsRoot
    {
        get; set;
    }

    [SugarColumn(ColumnDataType = "text")]
    public string Permissions { get; set; } = string.Empty;

    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;

    [SugarColumn(IsNullable = true)]
    public DateTime? LastLoginAtUtc
    {
        get; set;
    }

    [SugarColumn(DefaultValue = "false")]
    public bool TotpEnabled
    {
        get; set;
    }

    [SugarColumn(IsNullable = true, ColumnDataType = "text")]
    public string? TotpSecretEncrypted
    {
        get; set;
    }

    [SugarColumn(IsNullable = true)]
    public DateTime? TotpVerifiedAtUtc
    {
        get; set;
    }
}

public static class AdminPrincipalStatus
{
    public const string Active = "active";
    public const string Disabled = "disabled";
}
