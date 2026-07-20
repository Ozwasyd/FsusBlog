using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("sys_user_session")]
[SugarIndex("idx_user_session_user", nameof(UserId), OrderByType.Asc)]
[SugarIndex("idx_user_session_idle_expires", nameof(IdleExpiresAt), OrderByType.Desc)]
[SugarIndex("idx_user_session_refresh_hash", nameof(RefreshTokenHash), OrderByType.Desc, true)]
[SugarIndex("idx_user_session_refresh_family", nameof(RefreshFamilyId), OrderByType.Asc, true)]
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

    [SugarColumn(ColumnName = "refresh_family_id", Length = 64)]
    public string RefreshFamilyId { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "refresh_generation", DefaultValue = "0")]
    public long RefreshGeneration
    {
        get; set;
    }

    [SugarColumn(ColumnName = "refresh_rotated_at_utc", IsNullable = true)]
    public DateTime? RefreshRotatedAtUtc
    {
        get; set;
    }

    [SugarColumn(ColumnName = "refresh_compromised_at_utc", IsNullable = true)]
    public DateTime? RefreshCompromisedAtUtc
    {
        get; set;
    }

    [SugarColumn(ColumnName = "refresh_compromise_reason", IsNullable = true, Length = 64)]
    public string? RefreshCompromiseReason
    {
        get; set;
    }

    [SugarColumn(ColumnName = "device_signal_hash", IsNullable = true, Length = 64)]
    public string? DeviceSignalHash
    {
        get; set;
    }

    [SugarColumn(ColumnName = "device_signal_epoch", IsNullable = true)]
    public int? DeviceSignalEpoch
    {
        get; set;
    }

    [SugarColumn(ColumnName = "network_signal_hash", IsNullable = true, Length = 64)]
    public string? NetworkSignalHash
    {
        get; set;
    }

    [SugarColumn(ColumnName = "network_signal_epoch", IsNullable = true)]
    public int? NetworkSignalEpoch
    {
        get; set;
    }

    [SugarColumn(ColumnName = "browser_family", Length = 24, DefaultValue = "Unknown")]
    public string BrowserFamily { get; set; } = "Unknown";

    [SugarColumn(ColumnName = "os_family", Length = 24, DefaultValue = "Unknown")]
    public string OperatingSystemFamily { get; set; } = "Unknown";

    [SugarColumn(ColumnName = "form_factor", Length = 16, DefaultValue = "Unknown")]
    public string FormFactor
    {
        get; set;
    } = "Unknown";

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

    [SugarColumn(ColumnName = "session_mode", DefaultValue = "0")]
    public UserSessionMode SessionMode { get; set; } = UserSessionMode.Normal;

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

[SugarTable("user_refresh_token_tombstone")]
[SugarIndex("ux_user_refresh_tombstone_hash", nameof(TokenHash), OrderByType.Asc, true)]
[SugarIndex("idx_user_refresh_tombstone_expiry", nameof(ExpiresAtUtc), OrderByType.Asc)]
[SugarIndex("idx_user_refresh_tombstone_family", nameof(RefreshFamilyId), OrderByType.Asc)]
public sealed class UserRefreshTokenTombstone
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true)]
    public long Id
    {
        get; set;
    }

    [SugarColumn(ColumnName = "token_hash", Length = 64)]
    public string TokenHash { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "refresh_family_id", Length = 64)]
    public string RefreshFamilyId { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "session_id", Length = 64)]
    public string SessionId { get; set; } = string.Empty;

    [SugarColumn(ColumnName = "generation")]
    public long Generation
    {
        get; set;
    }

    [SugarColumn(ColumnName = "used_at_utc")]
    public DateTime UsedAtUtc
    {
        get; set;
    }

    [SugarColumn(ColumnName = "expires_at_utc")]
    public DateTime ExpiresAtUtc
    {
        get; set;
    }
}
