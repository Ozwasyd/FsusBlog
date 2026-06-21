using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("passkey_credential")]
[SugarIndex("unique_idx_passkey_cred_id", nameof(PasskeyCredential.CredentialId), OrderByType.Asc, true)]
[SugarIndex("idx_passkey_account_id", nameof(PasskeyCredential.AccountId), OrderByType.Asc)]
public class PasskeyCredential
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true)]
    public int Id { get; set; }

    /// <summary>所属匿名账号 ID</summary>
    [SugarColumn(ColumnName = "account_id", IsNullable = false)]
    public int AccountId { get; set; }

    /// <summary>WebAuthn CredentialId (Base64Url 编码后存储为文本)</summary>
    [SugarColumn(Length = 512, IsNullable = false)]
    public string CredentialId { get; set; } = string.Empty;

    /// <summary>COSE 公钥 (Base64Url 编码)</summary>
    [SugarColumn(IsNullable = false, ColumnDataType = "text")]
    public string PublicKey { get; set; } = string.Empty;

    /// <summary>签名计数，防重放</summary>
    [SugarColumn(DefaultValue = "0")]
    public long SignCount { get; set; }

    /// <summary>用户自定义设备名称</summary>
    [SugarColumn(Length = 64, IsNullable = true)]
    public string? DeviceFriendlyName { get; set; }

    /// <summary>Authenticator AAGUID</summary>
    [SugarColumn(Length = 36, IsNullable = false)]
    public string AaGuid { get; set; } = string.Empty;

    /// <summary>传输协议列表 (逗号分隔，如 "usb,nfc")</summary>
    [SugarColumn(Length = 128, IsNullable = true)]
    public string? Transports { get; set; }

    /// <summary>凭证是否支持备份（可同步到多设备）</summary>
    [SugarColumn(DefaultValue = "false")]
    public bool BackupEligible { get; set; }

    /// <summary>当前凭证是否已备份（跨设备同步）</summary>
    [SugarColumn(DefaultValue = "false")]
    public bool BackupState { get; set; }

    /// <summary>创建时间</summary>
    public DateTime CreatedAt { get; set; } = DateTime.UtcNow;

    /// <summary>上次使用时间</summary>
    [SugarColumn(IsNullable = true)]
    public DateTime? LastUsedAt { get; set; }
}
