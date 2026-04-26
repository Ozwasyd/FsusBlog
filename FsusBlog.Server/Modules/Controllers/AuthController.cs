using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;

namespace FsusBlog.Server.Modules.Controllers;

/// <summary>
/// 身份认证管理控制器
/// 修复日期: 2026-02-23 (消除响应匿名对象，引入源生成器日志)
/// </summary>
[Route("api/[controller]")]
[ApiController]
public partial class AuthController(
    IUserService _userService,
    ILogger<AuthController> _logger,
    IWebHostEnvironment _env,
    IMfaChallengeService _mfaChallengeService,
    AuthCookieService _authCookieService) : ControllerBase
{
    [Authorize(Roles = "admin")]
    [HttpGet("{id}")]
    public async Task<ActionResult<ApiResponse<CurrentUserSnapshotDto>>> GetUserInfo(int id)
    {
        var user = await _userService.GetByIdAsync(id);
        if (user == null) return ControllerResults.NotFound<CurrentUserSnapshotDto>("未找到该用户", HttpContext.TraceIdentifier);

        return ApiResponse<CurrentUserSnapshotDto>.Success(new CurrentUserSnapshotDto(user.Id, user.Username, user.Role, user.Status, user.BanReason, user.DeletedAt));
    }

    [Authorize(Roles = "admin")]
    [HttpGet("find/{username}")]
    public async Task<ActionResult<ApiResponse<CurrentUserSnapshotDto>>> FindUserByName(string username)
    {
        var user = await _userService.GetByUsernameAsync(username);
        if (user == null) return ControllerResults.NotFound<CurrentUserSnapshotDto>("未找到该用户", HttpContext.TraceIdentifier);

        return ApiResponse<CurrentUserSnapshotDto>.Success(new CurrentUserSnapshotDto(user.Id, user.Username, user.Role, user.Status, user.BanReason, user.DeletedAt));
    }

    [EnableRateLimiting("fixed_ip")]
    [Authorize]
    [HttpPut("update-username")]
    [SensitiveContentFilter]
    public async Task<ActionResult<ApiResponse>> UpdateUsername([FromBody] UpdateUsernameDto dto)
    {
        var userId = User.GetUserId();
        var userForMfaCheck = await _userService.GetByIdAsync(userId);
        if (userForMfaCheck != null && userForMfaCheck.MfaEnabled)
        {
            if (!TryReadMfaProof(out var proofToken) || !await _mfaChallengeService.ValidateAndConsumeProofTokenAsync(userId, "update-username", proofToken))
            {
                return ControllerResults.Status(StatusCodes.Status428PreconditionRequired, "MFA_REQUIRED", HttpContext.TraceIdentifier);
            }
        }

        var (success, message, newToken) = await _userService.UpdateUsernameAsync(userId, dto.NewUsername);

        if (!success || newToken == null) return ControllerResults.BadRequest(message, HttpContext.TraceIdentifier);

        var user = await _userService.GetByIdAsync(userId);
        _authCookieService.SetTokenCookies(HttpContext, _env, newToken.Value.AccessToken, newToken.Value.RefreshToken, user?.RefreshTokenExpiryTime ?? DateTime.UtcNow.AddDays(7));

        return ApiResponse.Success("用户名修改成功");
    }

    [EnableRateLimiting("fixed_ip")]
    [Authorize]
    [HttpPut("update-password")]
    [RequiresPow]
    public async Task<ActionResult<ApiResponse>> UpdatePassword([FromBody] UpdatePasswordDto dto)
    {
        var userId = User.GetUserId();
        string clientIp = HttpContext.GetClientIp();
        var userForMfaCheck = await _userService.GetByIdAsync(userId);
        if (userForMfaCheck != null && userForMfaCheck.MfaEnabled)
        {
            if (!TryReadMfaProof(out var proofToken) || !await _mfaChallengeService.ValidateAndConsumeProofTokenAsync(userId, "update-password", proofToken))
            {
                return ControllerResults.Status(StatusCodes.Status428PreconditionRequired, "MFA_REQUIRED", HttpContext.TraceIdentifier);
            }
        }

        var (success, message) = await _userService.UpdatePasswordAsync(userId, dto);
        if (!success) return ControllerResults.BadRequest(message, HttpContext.TraceIdentifier);

        _authCookieService.ClearTokenCookies(HttpContext);
        using var _ = AuditLogScope.Push(
            AuditSourceCatalog.Auth,
            AuditTypeCatalog.Security,
            new KeyValuePair<string, object?>("AuditAction", "password.update"),
            new KeyValuePair<string, object?>("UserId", userId),
            new KeyValuePair<string, object?>("ClientIp", clientIp));
        LogPasswordReset(userId, clientIp);
        return ApiResponse.Success("密码修改成功，请重新登录");
    }

    private bool TryReadMfaProof(out string proofToken)
    {
        proofToken = string.Empty;
        if (!Request.Headers.TryGetValue("X-Fsus-Mfa-Proof", out var values))
        {
            return false;
        }

        string? token = values.ToString();
        if (string.IsNullOrWhiteSpace(token))
        {
            return false;
        }

        proofToken = token;
        return true;
    }

    [LoggerMessage(
        EventId = 1,
        Level = LogLevel.Warning,
        Message = "安全事件：用户 {UserId} 修改密码，已销毁所有在线会话 | IP: {IpAddress}")]
    private partial void LogPasswordReset(int userId, string ipAddress);
}
