using SqlSugar;

namespace FsusBlog.Server.Entities;

[SugarTable("sys_user")]
[SugarIndex("unique_idx_username", nameof(User.Username), OrderByType.Desc, true)]
[SugarIndex("idx_create_time", nameof(User.CreateTime), OrderByType.Desc)]
// 为状态字段增加索引，确保系统启动时能瞬间捞出所有黑名单
[SugarIndex("idx_user_status", nameof(User.Status), OrderByType.Asc)]
public class User
{
    [SugarColumn(IsPrimaryKey = true, IsIdentity = true)]
    public int Id { get; set; }

    [SugarColumn(Length = 50)]
    public string Username { get; set; }

    [SugarColumn(Length = 100)]
    public string Password { get; set; } // 实际生产中请存 Hash

    [SugarColumn(Length = 20)]
    public string Role { get; set; } = "guest"; // "admin" or "guest"

    /// <summary>
    /// 上次修改用户名的时间
    /// </summary>
    [SugarColumn(IsNullable = true)]
    public DateTime? LastUsernameUpdateTime { get; set; }

    /// <summary>
    /// 刷新令牌（长效凭证）
    /// </summary>
    [SugarColumn(IsNullable = true, Length = 200)]
    public string? RefreshToken { get; set; }

    /// <summary>
    /// 刷新令牌过期时间
    /// </summary>
    [SugarColumn(IsNullable = true)]
    public DateTime? RefreshTokenExpiryTime { get; set; }

    // ====== 管理字段 ======

    /// <summary>
    /// 账号状态 (0:正常 1:封禁受限)
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
    /// 最后登录 IP (安全风控用)
    /// </summary>
    [SugarColumn(Length = 50, IsNullable = true)]
    public string? LastLoginIp { get; set; }

    /// <summary>
    /// 最后登录时间 (活跃度分析用)
    /// </summary>
    [SugarColumn(IsNullable = true)]
    public DateTime? LastLoginTime { get; set; }
}

