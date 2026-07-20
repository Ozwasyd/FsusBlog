using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("sys_user_session")]
[SugarIndex("idx_user_session_user", nameof(UserId), OrderByType.Asc)]
[SugarIndex("idx_user_session_idle_expires", nameof(IdleExpiresAt), OrderByType.Desc)]
[SugarIndex("idx_user_session_refresh_hash", nameof(RefreshTokenHash), OrderByType.Desc, true)]
public class UserSession
{
    [SugarColumn(IsPrimaryKey = true, Length = 64)]
    public string SessionId { get; set; } = string.Empty;

    public int UserId
    {
        get; set;
    }

    [SugarColumn(Length = 128)]
    public string RefreshTokenHash { get; set; } = string.Empty;

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

    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    [SugarColumn(IsNullable = true)]
    public DateTime? LastSeenAt
    {
        get; set;
    }

    [SugarColumn(ColumnName = "idleexpiresat")]
    public DateTime IdleExpiresAt
    {
        get; set;
    }

    [SugarColumn(ColumnName = "absoluteexpiresat")]
    public DateTime AbsoluteExpiresAt
    {
        get; set;
    }

    [SugarColumn(IsNullable = true)]
    public DateTime? RevokedAt
    {
        get; set;
    }

    [SugarColumn(IsNullable = true, Length = 128)]
    public string? RevokeReason
    {
        get; set;
    }

    [SugarColumn(DefaultValue = "false")]
    public bool MfaVerified
    {
        get; set;
    }

    [SugarColumn(ColumnName = "rememberme", DefaultValue = "false")]
    public bool RememberMe
    {
        get; set;
    }

    [SugarColumn(ColumnName = "authentication_method", Length = 24, DefaultValue = UserSessionAuthenticationMethods.Other)]
    public string AuthenticationMethod { get; set; } = UserSessionAuthenticationMethods.Other;

    [SugarColumn(ColumnName = "authentication_strength", Length = 24, DefaultValue = UserSessionAuthenticationStrengths.LegacyUnverified)]
    public string AuthenticationStrength { get; set; } = UserSessionAuthenticationStrengths.LegacyUnverified;

    [SugarColumn(ColumnName = "authenticated_at_utc")]
    public DateTime AuthenticatedAtUtc { get; set; } = DateTime.UtcNow;

    [SugarColumn(ColumnName = "authenticated_credential_row_id", IsNullable = true)]
    public int? AuthenticatedCredentialRowId
    {
        get; set;
    }

    [SugarColumn(ColumnName = "last_step_up_at_utc", IsNullable = true)]
    public DateTime? LastStepUpAtUtc
    {
        get; set;
    }

    [SugarColumn(ColumnName = "last_step_up_method", IsNullable = true, Length = 24)]
    public string? LastStepUpMethod
    {
        get; set;
    }

    [SugarColumn(ColumnName = "duration_policy", Length = 24, DefaultValue = UserSessionDurationPolicies.BrowserSession)]
    public string DurationPolicy { get; set; } = UserSessionDurationPolicies.BrowserSession;

    [SugarColumn(IsIgnore = true)]
    public string? RowVersion
    {
        get; set;
    }
}
