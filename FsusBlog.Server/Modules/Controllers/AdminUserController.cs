using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace FsusBlog.Server.Modules.Controllers;

/// <summary>
/// 管理员用户控制器
/// 修复日期: 2026-02-23 (消除冗余元数据，利用 ActionResult 隐式转换实现热路径零分配响应)
/// </summary>
[ApiController]
[Route("api/admin/users")]
[Authorize(Roles = "admin")]
public class AdminUserController(
    IUserService _userService) : ControllerBase
{
    [HttpGet]
    public async Task<ActionResult<ApiResponse<PageResult<UserListDto>>>> GetList([FromQuery] UserQueryDto query)
    {
        var result = await _userService.GetAdminUserListAsync(query);

        // 核心优化：直接返回对象，触发 ActionResult<T> (struct) 的隐式转换。
        // 避开了 return Ok(...) 带来的 OkObjectResult 堆内存分配，实现热路径零分配。
        return ApiResponse<PageResult<UserListDto>>.Success(result);
    }

    /// <summary>
    /// 封禁/解封用户状态 (权限元数据实时同步入口)
    /// </summary>
    /// <param name="dto">包含 UserId, Status 以及 BanReason</param>
    /// <returns>执行结果回执</returns>
    [HttpPut("status")]
    [RequiresPow]
    public async Task<ActionResult<ApiResponse>> ChangeStatus([FromBody] AdminChangeStatusDto dto)
    {

        var (success, message) = await _userService.AdminChangeStatusAsync(dto);

        if (success)
        {
            // 成功路径：直接返回，零分配
            return ApiResponse.Success(message);
        }

        // 业务逻辑失败（如：用户不存在、尝试封禁管理员等）
        // 失败路径属于冷路径，保留 BadRequest 以明确返回 400 状态码
        return BadRequest(ApiResponse.Fail(message));
    }

    /// <summary>
    /// 重置密码 (需 PoW)
    /// </summary>
    [HttpPost("reset-pwd")]
    [RequiresPow]
    public async Task<ActionResult<ApiResponse>> ResetPassword([FromBody] AdminResetPwdDto dto)
    {
        var (success, message) = await _userService.AdminResetPasswordAsync(dto);

        // 成功路径零分配，失败路径按规范返回 400
        return success
            ? ApiResponse.Success(message)
            : BadRequest(ApiResponse.Fail(message));
    }
}
