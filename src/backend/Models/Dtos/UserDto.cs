using System.ComponentModel.DataAnnotations;

namespace FsusBlog.Server.Models.Dtos;

public sealed record class AdminChangeStatusDto
{
    public int AccountId
    {
        get; init;
    }
    public int Status
    {
        get; init;
    }
    public string? Reason
    {
        get; init;
    }
}

public readonly record struct RefreshRequestDto(string RefreshToken);

public sealed record class MfaSetupVerifyRequestDto
{
    [Required]
    public required string Code
    {
        get; init;
    }
}

public sealed record class MfaChallengeRequestDto
{
    public string? ChallengeToken
    {
        get; init;
    }
    public string? Action
    {
        get; init;
    }
    public string? Code
    {
        get; init;
    }
    public string? RecoveryCode
    {
        get; init;
    }
}

public sealed record class MfaDisableRequestDto
{
    [Required]
    public required string Password
    {
        get; init;
    }
    public string? Code
    {
        get; init;
    }
    public string? RecoveryCode
    {
        get; init;
    }
}

public sealed record class DeleteAccountRequestDto
{
    [Required]
    public required string ConfirmText
    {
        get; init;
    }
}

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
    public string? Keyword
    {
        get; init;
    }
    public int? Status
    {
        get; init;
    }
}

// ==========================================
// 3. 输出 DTO (Response Models)
// ==========================================
