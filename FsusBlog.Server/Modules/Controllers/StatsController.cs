using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Helpers; // 引入扩展方法
using FsusBlog.Server.Interfaces;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Server.Models.Responses;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace FsusBlog.Server.Modules.Controllers;

/// <summary>
/// 管理后台统计控制器
/// 修复日期: 2026-02-23 (引入源生成器日志与零分配响应)
/// </summary>
[ApiController]
[Route("api/[controller]")]
[Authorize(Roles = "admin")] // 全局强制管理员权限
public partial class StatsController( // 声明为 partial 以支持源生成器
    IStatsService _statsService,
    ILogger<StatsController> _logger) : ControllerBase
{
    /// <summary>
    /// 获取全站统计概览数据
    /// </summary>
    [HttpGet]
    public async Task<ActionResult<ApiResponse<AdminStatsOverviewDto>>> GetStats()
    {
        using var _ = AuditLogScope.Push(
            AuditSourceCatalog.Admin,
            AuditTypeCatalog.Audit,
            new KeyValuePair<string, object?>("AuditAction", "stats.read"));
        LogAdminAccess(User.GetUserName());

        // 2. 调用高性能并行统计服务
        // 异常由 GlobalExceptionMiddleware 捕获，此处不做本地异常分支
        var stats = await _statsService.GetAdminStatsOverviewAsync();

        // 3. 包装并返回 (直接返回，触发隐式转换，零分配)
        return ApiResponse<AdminStatsOverviewDto>.Success(stats, "数据统计已刷新");
    }

    [HttpGet("recent-comments")]
    public async Task<ActionResult<ApiResponse<List<RecentCommentStatItemDto>>>> GetRecentComments()
    {
        var items = await _statsService.GetAdminRecentCommentsAsync();
        return ApiResponse<List<RecentCommentStatItemDto>>.Success(items);
    }

    [HttpGet("regions")]
    public async Task<ActionResult<ApiResponse<List<RegionStatItemDto>>>> GetRegions()
    {
        var items = await _statsService.GetAdminRegionStatsAsync();
        return ApiResponse<List<RegionStatItemDto>>.Success(items);
    }

    // ==========================================
    // 高性能日志源生成器
    // ==========================================

    [LoggerMessage(
        EventId = 1,
        Level = LogLevel.Information,
        Message = "管理员 {AdminName} 正在调取全站统计概览")]
    private partial void LogAdminAccess(string adminName);
}
