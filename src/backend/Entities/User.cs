using FsusBlog.Server.Infrastructure.Auth;
using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("sys_user")]
[SugarIndex("idx_create_time", nameof(User.CreateTime), OrderByType.Desc)]
[SugarIndex("idx_user_public_handle_unique", nameof(PublicHandle), OrderByType.Asc, true)]
// 为状态字段增加索引，确保系统启动时能瞬间捞出所有黑名单
[SugarIndex("idx_user_status", nameof(User.Status), OrderByType.Asc)]
public class User
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true)]
    public int Id { get; set; }

    [SugarColumn(ColumnName = "public_handle", Length = 64, IsNullable = true)]
    public string? PublicHandle { get; set; }

    [SugarColumn(ColumnName = "identity_kind", Length = 32, DefaultValue = "'anonymous_account'")]
    public string IdentityKind { get; set; } = AnonymousIdentityRuntime.AnonymousAccountKind;

    [SugarColumn(ColumnName = "passkey_enabled", DefaultValue = "false")]
    public bool PasskeyEnabled { get; set; }

    [SugarColumn(ColumnName = "passkey_user_handle", Length = 128, IsNullable = true)]
    public string? PasskeyUserHandle { get; set; }

    [SugarColumn(ColumnName = "recovery_enabled", DefaultValue = "false")]
    public bool RecoveryEnabled { get; set; }

    [SugarColumn(ColumnName = "privacy_initialized_at", IsNullable = true)]
    public DateTime? PrivacyInitializedAt { get; set; }

    [SugarColumn(ColumnName = "anonymous_credential_level", Length = 32, DefaultValue = "'basic'")]
    public string AnonymousCredentialLevel { get; set; } = "basic";

    [SugarColumn(ColumnName = "anonymous_credential_status", Length = 32, DefaultValue = "'active'")]
    public string AnonymousCredentialStatus { get; set; } = "active";

    // ====== 管理字段 ======

    /// <summary>
    /// 账号状态 (0:正常 1:封禁受限 2:已注销)
    /// </summary>
    [SugarColumn(DefaultValue = "0")]
    public int Status { get; set; }

    /// <summary>
    /// 处罚原因 (告知用户利益用)
    /// </summary>
    [SugarColumn(IsNullable = true, Length = 500)]
    public string? BanReason { get; set; }

    /// <summary>
    /// 注册时间 (审计用)
    /// </summary>
    [SugarColumn(IsNullable = true)]
    public DateTime CreateTime { get; set; } = DateTime.UtcNow;

    /// <summary>
    /// 是否启用 TOTP MFA
    /// </summary>
    [SugarColumn(DefaultValue = "false")]
    public bool MfaEnabled { get; set; }

    /// <summary>
    /// 风险标记位
    /// </summary>
    [SugarColumn(DefaultValue = "0")]
    public int RiskFlags { get; set; }

    /// <summary>
    /// 注销时间
    /// </summary>
    [SugarColumn(IsNullable = true, ColumnName = "deleted_at")]
    public DateTime? DeletedAt { get; set; }

    /// <summary>
    /// 注销原因
    /// </summary>
    [SugarColumn(IsNullable = true, Length = 256, ColumnName = "deleted_reason")]
    public string? DeletedReason { get; set; }

    [SugarColumn(IsIgnore = true)]
    public string? RowVersion { get; set; }
}
