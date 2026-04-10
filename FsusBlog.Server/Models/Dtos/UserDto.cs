using FsusBlog.Server.Interfaces;
using System.ComponentModel.DataAnnotations;

namespace FsusBlog.Server.Models.Dtos;

// ==========================================
// 1. 输入 DTO (Request Models)
// ==========================================

public sealed record class UpdateUsernameDto : ICheckableContent
{
    [Required(ErrorMessage = "新用户名不能为空")]
    [RegularExpression(@"^[\u4e00-\u9fa5a-zA-Z]+$", ErrorMessage = "用户名仅允许包含中文或英文")]
    public required string NewUsername { get; init; }

    public string GetTextToCheck() => NewUsername;
}

public sealed record class UpdatePasswordDto
{
    [Required]
    public required string OldPassword { get; init; }

    [Required]
    [MinLength(6, ErrorMessage = "密码长度至少6位")]
    public required string NewPassword { get; init; }

    [Required]
    [Compare(nameof(NewPassword), ErrorMessage = "两次密码输入不一致")]
    public required string ConfirmPassword { get; init; }
}

public sealed record class LoginDto
{
    [Required(ErrorMessage = "用户名不能为空")]
    public required string Username { get; init; }

    [Required(ErrorMessage = "密码不能为空")]
    public required string Password { get; init; }
}

public sealed record class RegisterDto : ICheckableContent
{
    [Required(ErrorMessage = "用户名不能为空")]
    [RegularExpression(@"^[\u4e00-\u9fa5a-zA-Z]+$", ErrorMessage = "用户名仅允许包含中文或英文")]
    public required string Username { get; init; }

    [Required]
    public required string Password { get; init; }

    [Required]
    public required string ConfirmPassword { get; init; }

    public string GetTextToCheck() => Username;
}

public sealed record class AdminChangeStatusDto
{
    public int UserId { get; init; }
    public int Status { get; init; }
    public string? Reason { get; init; }
}

public sealed record class AdminResetPwdDto
{
    public int UserId { get; init; }
    public required string NewPassword { get; init; }
}

public readonly record struct RefreshRequestDto(string RefreshToken);

// ==========================================
// 2. 查询参数
// ==========================================

/// <summary>
/// 用户查询参数必须保持 class，兼容 Controller [FromQuery] 绑定行为。
/// </summary>
public sealed record class UserQueryDto
{
    public int Page { get; init; } = 1;
    public int PageSize { get; init; } = 20;
    public string? Keyword { get; init; }
    public int? Status { get; init; }
}

// ==========================================
// 3. 输出 DTO (Response Models)
// ==========================================
