using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("admin_session")]
[SugarIndex("idx_admin_session_principal", nameof(AdminPrincipalId), OrderByType.Asc)]
[SugarIndex("idx_admin_session_idle_expires", nameof(IdleExpiresAtUtc), OrderByType.Desc)]
public sealed class AdminSession
{
    [SugarColumn(IsPrimaryKey = true, Length = 64)]
    public string SessionId { get; set; } = string.Empty;

    public long AdminPrincipalId
    {
        get; set;
    }

    [SugarColumn(Length = 128)]
    public string AccessTokenHash { get; set; } = string.Empty;

    [SugarColumn(DefaultValue = "1")]
    public long ValidationVersion { get; set; } = 1;

    [SugarColumn(IsNullable = true, Length = 128)]
    public string? DeviceFingerprint
    {
        get; set;
    }

    [SugarColumn(IsNullable = true, Length = 64)]
    public string? LastIp
    {
        get; set;
    }

    [SugarColumn(IsNullable = true, Length = 512)]
    public string? UserAgent
    {
        get; set;
    }

    public DateTime CreatedAtUtc { get; set; } = DateTime.UtcNow;

    [SugarColumn(IsNullable = true)]
    public DateTime? LastSeenAtUtc
    {
        get; set;
    }

    public DateTime IdleExpiresAtUtc
    {
        get; set;
    }

    public DateTime AbsoluteExpiresAtUtc
    {
        get; set;
    }

    [SugarColumn(IsNullable = true)]
    public DateTime? RevokedAtUtc
    {
        get; set;
    }

    [SugarColumn(IsNullable = true, Length = 128)]
    public string? RevokeReason
    {
        get; set;
    }

    [SugarColumn(DefaultValue = "false")]
    public bool StepUpVerified
    {
        get; set;
    }

    [SugarColumn(IsIgnore = true)]
    public string? RowVersion
    {
        get; set;
    }
}
