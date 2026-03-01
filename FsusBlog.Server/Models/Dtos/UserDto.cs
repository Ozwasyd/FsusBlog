using FsusBlog.Server.Interfaces;
using System.ComponentModel.DataAnnotations;
using System.Text.Json.Serialization;

namespace FsusBlog.Server.Models.Dtos;

// ==========================================
// 1. 输入 DTO (Request Models) - 升级为 Record Class
// ==========================================

public record class UpdateUsernameDto : ICheckableContent
{
    [Required(ErrorMessage = "新用户名不能为空")]
    [RegularExpression(@"^[\u4e00-\u9fa5a-zA-Z]+$", ErrorMessage = "用户名仅允许包含中文或英文")]
    public required string NewUsername { get; set; }

    public string GetTextToCheck() => NewUsername;
}

public record class UpdatePasswordDto
{
    [Required]
    public required string OldPassword { get; set; }

    [Required]
    [MinLength(6, ErrorMessage = "密码长度至少6位")]
    public required string NewPassword { get; set; }

    [Required]
    [Compare(nameof(NewPassword), ErrorMessage = "两次密码输入不一致")]
    public required string ConfirmPassword { get; set; }
}

public record class LoginDto
{
    [Required(ErrorMessage = "用户名不能为空")]
    public required string Username { get; set; }

    [Required(ErrorMessage = "密码不能为空")]
    public required string Password { get; set; }
}
    public record class RegisterDto : ICheckableContent
    {
        [Required(ErrorMessage = "用户名不能为空")]
        [RegularExpression(@"^[\u4e00-\u9fa5a-zA-Z]+$", ErrorMessage = "用户名仅允许包含中文或英文")]
        public required string Username { get; set; }
        public required string Password { get; set; }
        public required string ConfirmPassword { get; set; }

        public string GetTextToCheck() => Username;
    }

    public record class AdminChangeStatusDto
    {
        public int UserId { get; set; }
        public int Status { get; set; } // 1: 禁用, 0: 启用
        public string? Reason { get; set; }
    }

    public record class AdminResetPwdDto
    {
        public int UserId { get; set; }
        public required string NewPassword { get; set; }
    }

    public record class RefreshRequestDto(string RefreshToken);

    // ==========================================
    // 2. 查询参数 
    // ==========================================

    /// <summary>
    /// 用户查询参数
    /// 核心修复 (2026-02-23)：必须为 record class。
    /// Controller 的 [FromQuery] 无法绑定到 struct 类型。
    /// </summary>
    public record class UserQueryDto
    {
        public int Page { get; set; } = 1;
        public int PageSize { get; set; } = 20;
        public string? Keyword { get; set; }
        public int? Status { get; set; }
    }

    // ==========================================
    // 3. 输出 DTO (Response Models) - 重构为 Struct
    // ==========================================

    /// <summary>
    /// 登录/刷新成功后返回的“双票”包
    /// </summary>
    public readonly record struct TokenResponseDto(string AccessToken, string RefreshToken);

    /// <summary>
    /// 登录成功后回传给前端的“非敏感”用户信息
    /// </summary>
    public readonly record struct LoginResponseDto(int Id, string Username, string Role);

    /// <summary>
    /// 用户列表项
    /// </summary>
    public readonly record struct UserListDto(
        int Id,
        string Username,
        string Role,
        int Status,
        DateTime CreateTime,
        string? LastLoginIp,
        DateTime? LastLoginTime
    );