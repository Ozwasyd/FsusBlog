using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Helpers.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace FsusBlog.Server.Modules.Controllers;

/// <summary>
/// 系统设置管理控制器 (Write Side)
/// 修复日期: 2026-02-23 (CQRS 重构，引入零分配日志与响应)
/// </summary>
[Route("api/[controller]")]
[ApiController]
[Authorize(Roles = "admin")] // 将权限提升到类级别
public partial class SystemController( // 声明为 partial 以支持源生成器
    ISystemService _systemService,
    ILogger<SystemController> _logger) : ControllerBase
{
    // ================= 1. SEO 配置 (SEO Config) =================

    [HttpPut("seo")]
    [RequiresPow]
    public async Task<ActionResult<ApiResponse>> UpdateSeoConfig([FromBody] SeoConfigDto dto)
    {
        LogSeoUpdate(User.GetUserName());
        await _systemService.UpdateSeoConfigAsync(dto);
        return ApiResponse.Success("SEO 配置已更新并同步至缓存");
    }

    // ================= 2. 动态页面 (Page Content) =================

    [HttpPut("page")]
    [RequiresPow]
    public async Task<ActionResult<ApiResponse>> UpdatePage([FromBody] PageContentDto dto)
    {
        // 核心安全优化：从源头确保存入数据库的 Slug 必须符合 URL 规范
        var slugSpan = dto.Slug.AsSpan();
        if (slugSpan.IsEmpty || !FastCharValidator.IsAlphaNumericHyphen(slugSpan))
        {
            return BadRequest(ApiResponse.Fail("页面标识 (Slug) 格式非法，仅允许字母、数字和连字符"));
        }

        LogPageUpdate(dto.Slug);
        await _systemService.UpdatePageContentAsync(dto);
        return ApiResponse.Success($"{dto.Slug} 页面内容已发布，全局缓存已刷新");
    }

    // ==========================================
    // 高性能日志源生成器
    // ==========================================

    [LoggerMessage(
        EventId = 1,
        Level = LogLevel.Warning,
        Message = "审计日志：管理员 {AdminName} 正在修改全站 SEO 配置")]
    private partial void LogSeoUpdate(string adminName);

    [LoggerMessage(
        EventId = 2,
        Level = LogLevel.Information,
        Message = "审计日志：管理员正在更新页面内容 | Slug: {Slug}")]
    private partial void LogPageUpdate(string? slug);
}
