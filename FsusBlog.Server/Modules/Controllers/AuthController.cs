using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
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
    IWebHostEnvironment _env) : ControllerBase
{
    [Authorize(Roles = "admin")]
    [HttpGet("{id}")]
    public async Task<ActionResult<ApiResponse<LoginResponseDto>>> GetUserInfo(int id)
    {
        var user = await _userService.GetByIdAsync(id);
        if (user == null) return NotFound(ApiResponse.Fail("未找到该用户", 404));

        // 核心优化：返回强类型 DTO，避免匿名对象
        return ApiResponse<LoginResponseDto>.Success(new LoginResponseDto(user.Id, user.Username, user.Role));
    }

    [EnableRateLimiting("fixed_ip")]
    [Authorize]
    [HttpPut("update-username")]
    [SensitiveContentFilter]
    public async Task<ActionResult<ApiResponse>> UpdateUsername([FromBody] UpdateUsernameDto dto)
    {
        var userId = User.GetUserId();
        var (success, message, newToken) = await _userService.UpdateUsernameAsync(userId, dto.NewUsername);

        if (!success || newToken == null) return BadRequest(ApiResponse.Fail(message));

        SetTokenCookies(newToken.Value.AccessToken, newToken.Value.RefreshToken);

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

        var (success, message) = await _userService.UpdatePasswordAsync(userId, dto);
        if (!success) return BadRequest(ApiResponse.Fail(message));

        ClearTokenCookies();
        LogPasswordReset(userId, clientIp);
        return ApiResponse.Success("密码修改成功，请重新登录");
    }

    private void SetTokenCookies(string access, string refresh)
    {
        var isProd = !_env.IsDevelopment();
        var baseOptions = new CookieOptions
        {
            HttpOnly = true,
            Secure = isProd,
            SameSite = SameSiteMode.Strict,
            Path = "/"
        };

        Response.Cookies.Append("AccessToken", access, new CookieOptions(baseOptions)
        {
            Expires = DateTime.UtcNow.AddMinutes(15)
        });

        Response.Cookies.Append("RefreshToken", refresh, new CookieOptions(baseOptions)
        {
            Expires = DateTime.UtcNow.AddDays(7)
        });
    }

    private void ClearTokenCookies()
    {
        Response.Cookies.Delete("AccessToken");
        Response.Cookies.Delete("RefreshToken");
    }

    [LoggerMessage(
        EventId = 1,
        Level = LogLevel.Warning,
        Message = "安全事件：用户 {UserId} 修改密码，已销毁所有在线会话 | IP: {IpAddress}")]
    private partial void LogPasswordReset(int userId, string ipAddress);
}