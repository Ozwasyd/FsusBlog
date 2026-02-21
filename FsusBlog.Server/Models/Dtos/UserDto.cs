using FsusBlog.Server.Interfaces;
using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;

namespace FsusBlog.Server.Models.Dtos;

public class UpdateUsernameDto
{
    // 修改点：增加正则限制
    [Required(ErrorMessage = "新用户名不能为空")]
    [RegularExpression(@"^[\u4e00-\u9fa5a-zA-Z]+$", ErrorMessage = "用户名仅允许包含中文或英文")]
    public required string NewUsername { get; set; }
}

public class UpdatePasswordDto : IPowRequest
{
    [Required]
    public required string OldPassword { get; set; }

    [Required]
    [MinLength(6, ErrorMessage = "密码长度至少6位")]
    public required string NewPassword { get; set; }

    [Required]
    [Compare(nameof(NewPassword), ErrorMessage = "两次密码输入不一致")]
    public required string ConfirmPassword { get; set; }

    // ==========================================
    // PoW 验证字段 (实现 IPowRequest)
    // ==========================================

    [JsonPropertyName("powSalt")]
    public string PowSalt { get; set; } = string.Empty;

    [JsonPropertyName("powNonce")]
    public string PowNonce { get; set; } = string.Empty;

    [JsonPropertyName("powSignature")]
    public string PowSignature { get; set; } = string.Empty;

    [JsonPropertyName("powTimestamp")]
    public long PowTimestamp { get; set; }

    [JsonPropertyName("difficulty")]
    public int Difficulty { get; set; }

    [JsonPropertyName("browserFp")]
    public string BrowserFp { get; set; } = string.Empty;
}
public class LoginDto : IPowRequest
{
    [Required(ErrorMessage = "用户名不能为空")]
    public required string Username { get; set; }

    [Required(ErrorMessage = "密码不能为空")]
    public required string Password { get; set; }

    // PoW 
    public required string PowSalt { get; set; }
    public required string PowSignature { get; set; }
    public long PowTimestamp { get; set; }
    public int Difficulty { get; set; }
    public required string PowNonce { get; set; }
    public required string BrowserFp { get; set; }
}

public class RegisterDto : IPowRequest
{
    // --- 基础账户信息 ---
    [Required(ErrorMessage = "用户名不能为空")]
    [RegularExpression(@"^[\u4e00-\u9fa5a-zA-Z]+$", ErrorMessage = "用户名仅允许包含中文或英文")]
    public required string Username { get; set; }
    public required string Password { get; set; }
    public required string ConfirmPassword { get; set; }

    // --- PoW 验证凭证 (由后端下发，前端原样传回) ---
    public required string PowSalt { get; set; }
    public required string PowSignature { get; set; }
    public long PowTimestamp { get; set; }
    public int Difficulty { get; set; }

    // --- PoW 算力成果 (由 Wasm 引擎计算生成) ---
    public required string PowNonce { get; set; }
    public required string BrowserFp { get; set; }
}

// 登录成功后返回给前端的“双票”包
public class TokenResponseDto
{
    public string AccessToken { get; set; } = null!;
    public string RefreshToken { get; set; } = null!;
}

// 前端用来换取新 Access Token 的请求
public class RefreshRequestDto
{
    public string RefreshToken { get; set; } = null!;
}

/// <summary>
/// 登录成功后回传给前端的“非敏感”用户信息
/// </summary>
public class LoginResponseDto
{
    public int Id { get; set; }
    public string Username { get; set; } = string.Empty;
    public string Role { get; set; } = string.Empty;
}

// --- 查询与列表 ---
public class UserQueryDto
{
    public int Page { get; set; } = 1;
    public int PageSize { get; set; } = 20;
    public string? Keyword { get; set; }
    public int? Status { get; set; }
}

public class UserListDto
{
    public int Id { get; set; }
    public required string Username { get; set; }
    public required string Role { get; set; }
    public int Status { get; set; }
    public DateTime CreateTime { get; set; }
    public string? LastLoginIp { get; set; }
    public DateTime? LastLoginTime { get; set; }
}

// --- 高危操作 (集成 IPowRequest) ---

// 封禁/解封
public class AdminChangeStatusDto : IPowRequest
{
    public int UserId { get; set; }
    public int Status { get; set; } // 1: 禁用, 0: 启用

    /// <summary>
    /// 封禁理由 (当 Status 为 1 时必填或选填)
    /// </summary>
    public string? Reason { get; set; }

    // PoW 字段
    public required string PowSalt { get; set; }
    public required string PowSignature { get; set; }
    public long PowTimestamp { get; set; }
    public int Difficulty { get; set; }
    public required string PowNonce { get; set; }
    public required string BrowserFp { get; set; }
}

// 强制重置密码
public class AdminResetPwdDto : IPowRequest
{
    public int UserId { get; set; }
    public required string NewPassword { get; set; }

    // PoW 字段
    public required string PowSalt { get; set; }
    public required string PowSignature { get; set; }
    public long PowTimestamp { get; set; }
    public int Difficulty { get; set; }
    public required string PowNonce { get; set; }
    public required string BrowserFp { get; set; }
}