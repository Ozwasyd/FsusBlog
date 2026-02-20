using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Responses;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace FsusBlog.Server.Controllers;

/// <summary>
/// 管理后台统计控制器
/// </summary>
[ApiController]
[Route("api/[controller]")]
[Authorize(Roles = "admin")] // 全局强制管理员权限
public class StatsController(
    IStatsService _statsService,
    ILogger<StatsController> _logger) : ControllerBase
{
    /// <summary>
    /// 获取全站统计概览数据
    /// </summary>
    [HttpGet]
    public async Task<ActionResult<ApiResponse<object>>> GetStats()
    {
        // 1. 记录审计日志：谁在访问数据大屏
        _logger.LogInformation("管理员 {Admin} 正在调取全站统计概览", User.Identity?.Name ?? "未知");

        // 2. 调用高性能并行统计服务
        // 异常将由 GlobalExceptionMiddleware 捕获，此处无需 try-catch
        var stats = await _statsService.GetAdminStatsAsync();

        // 3. 包装并返回
        return Ok(ApiResponse<object>.Success(stats, "数据统计已刷新"));
    }
}