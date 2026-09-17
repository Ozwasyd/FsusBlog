using FsusBlog.Server.Infrastructure.Auth;

using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("sys_user")]
[SugarIndex("idx_create_time", nameof(User.CreateTime), OrderByType.Desc)]
[SugarIndex("idx_user_public_handle_unique", nameof(PublicHandle), OrderByType.Asc, true)]
// 为状态字段增加索引，确保系统启动时能瞬间捞出所有黑名单
[SugarIndex("idx_user_status", nameof(User.Status), OrderByType.Asc)]
[SugarIndex("idx_user_registration_state", nameof(User.RegistrationState), OrderByType.Asc)]
public class User
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true)]
    public int Id
    {
        get; set;
    }

    [SugarColumn(ColumnName = "public_handle", Length = 64, IsNullable = true)]
    public string? PublicHandle
    {
        get; set;
    }

    [SugarColumn(ColumnName = "identity_kind", Length = 32, DefaultValue = "anonymous_account")]
    public string IdentityKind { get; set; } = AnonymousIdentityRuntime.AnonymousAccountKind;

    /// <summary>
    /// Stable, opaque account subject used by tokens, caches, and security audit joins.
    /// The nullable mapping is intentional during the rolling expand window; runtime
    /// boundaries and the startup invariant gate reject accounts that were not backfilled.
    /// </summary>
    [SugarColumn(ColumnName = "account_subject_hash", Length = 64, IsNullable = true)]
    public string? AccountSubjectHash
    {
        get; set;
    }

    /// <summary>
    /// Auditable account-registration lifecycle. This is intentionally independent
    /// from moderation/deletion <see cref="Status"/>.
    /// </summary>
    [SugarColumn(ColumnName = "registration_state", Length = 24, DefaultValue = "active")]
    public string RegistrationState { get; set; } = AccountRegistrationStates.Active;

    [SugarColumn(ColumnName = "passkey_enabled", DefaultValue = "false")]
    public bool PasskeyEnabled
    {
        get; set;
    }

    [SugarColumn(ColumnName = "passkey_user_handle", Length = 128, IsNullable = true)]
    public string? PasskeyUserHandle
    {
        get; set;
    }

    /// <summary>
    /// Monotonic account-scoped revision for authoritative WebAuthn Signal API snapshots.
    /// </summary>
    [SugarColumn(ColumnName = "passkey_signal_version", DefaultValue = "0")]
    public long PasskeySignalVersion
    {
        get; set;
    }

    [SugarColumn(ColumnName = "recovery_enabled", DefaultValue = "false")]
    public bool RecoveryEnabled
    {
        get; set;
    }

    [SugarColumn(ColumnName = "privacy_initialized_at", IsNullable = true)]
    public DateTime? PrivacyInitializedAt
    {
        get; set;
    }

    [SugarColumn(ColumnName = "anonymous_credential_level", Length = 32, DefaultValue = "basic")]
    public string AnonymousCredentialLevel { get; set; } = "basic";

    [SugarColumn(ColumnName = "anonymous_credential_status", Length = 32, DefaultValue = "active")]
    public string AnonymousCredentialStatus { get; set; } = "active";

    // ====== 管理字段 ======

    /// <summary>
    /// 账号状态 (0:正常 1:封禁受限 2:已注销)
    /// </summary>
    [SugarColumn(DefaultValue = "0")]
    public int Status
    {
        get; set;
    }

    /// <summary>
    /// 处罚原因 (告知用户利益用)
    /// </summary>
    [SugarColumn(IsNullable = true, Length = 500)]
    public string? BanReason
    {
        get; set;
    }

    /// <summary>
    /// Monotonic authority revision for the process-local ban-state projection.
    /// Every Normal/Banned/Deleted transition increments this value.
    /// </summary>
    [SugarColumn(ColumnName = "ban_state_generation", DefaultValue = "1")]
    public long BanStateGeneration
    {
        get; set;
    } = 1;

    /// <summary>
    /// 注册时间 (审计用)
    /// </summary>
    [SugarColumn(IsNullable = true)]
    public DateTime CreateTime { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// 是否启用 TOTP MFA
    /// </summary>
    [SugarColumn(DefaultValue = "false")]
    public bool MfaEnabled
    {
        get; set;
    }

    /// <summary>
    /// 风险标记位
    /// </summary>
    [SugarColumn(DefaultValue = "0")]
    public int RiskFlags
    {
        get; set;
    }

    /// <summary>
    /// 注销时间
    /// </summary>
    [SugarColumn(IsNullable = true, ColumnName = "deleted_at")]
    public DateTime? DeletedAt
    {
        get; set;
    }

    /// <summary>
    /// 注销原因
    /// </summary>
    [SugarColumn(IsNullable = true, Length = 256, ColumnName = "deleted_reason")]
    public string? DeletedReason
    {
        get; set;
    }

    [SugarColumn(IsIgnore = true)]
    public string? RowVersion
    {
        get; set;
    }
}

public static class AccountRegistrationStates
{
    public const string Provisional = "provisional";
    public const string Active = "active";
    public const string Suspended = "suspended";
    public const string Closed = "closed";

    public static bool IsActive(string? value)
        => string.Equals(value, Active, StringComparison.Ordinal);
}
