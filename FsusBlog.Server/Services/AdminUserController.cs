using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace FsusBlog.Server.Services;

[ApiController]
[Route("api/admin/users")]
[Authorize(Roles = "admin")]
public class AdminUserController(
    IUserService _userService,
    IPowService _powService) : ControllerBase
{

    [HttpGet]
    public async Task<ActionResult<ApiResponse<PageResult<UserListDto>>>> GetList([FromQuery] UserQueryDto query)
    {
        var result = await _userService.GetAdminUserListAsync(query);
        return Ok(ApiResponse<PageResult<UserListDto>>.Success(result));
    }

    /// <summary>
    /// 封禁/解封用户状态 (权限元数据实时同步入口)
    /// </summary>
    /// <param name="dto">包含 UserId, Status 以及 BanReason</param>
    /// <returns>执行结果回执</returns>
    [HttpPut("status")]
    [Authorize(Roles = "admin")]
    public async Task<ActionResult<ApiResponse>> ChangeStatus([FromBody] AdminChangeStatusDto dto)
    {
        // 1. 安全防御：PoW (Proof of Work) 校验
        // 目的：防止攻击者获取管理权限后，利用脚本进行“毁灭性”的大规模暴力封号
        string clientIp = HttpContext.GetClientIp();
        if (!await _powService.VerifyAsync(dto, clientIp))
        {
            return StatusCode(401, ApiResponse.Fail("安全校验失败，请刷新页面重试"));
        }

        var (success, message) = await _userService.AdminChangeStatusAsync(dto);

        if (success)
        {
            return Ok(ApiResponse.Success(message));
        }

        // 业务逻辑失败（如：用户不存在、尝试封禁管理员等）
        return BadRequest(ApiResponse.Fail(message));
    }

    /// <summary>
    /// 重置密码 (需 PoW)
    /// </summary>
    [HttpPost("reset-pwd")]
    public async Task<ActionResult<ApiResponse>> ResetPassword([FromBody] AdminResetPwdDto dto)
    {
        // 1. 安全防御
        string clientIp = HttpContext.GetClientIp();
        if (!await _powService.VerifyAsync(dto, clientIp))
        {
            return StatusCode(401, ApiResponse.Fail("安全校验失败"));
        }

        var (success, message) = await _userService.AdminResetPasswordAsync(dto);
        return success ? Ok(ApiResponse.Success(message)) : BadRequest(ApiResponse.Fail(message));
    }
}
