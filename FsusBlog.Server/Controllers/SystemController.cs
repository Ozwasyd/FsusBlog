using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace FsusBlog.Server.Controllers;

/// <summary>
/// 系统设置控制器：管理 SEO 与动态页面内容
/// </summary>
[Route("api/[controller]")]
[ApiController]
public class SystemController(
    ISystemService _systemService,
    ILogger<SystemController> _logger) : ControllerBase
{
    // ================= 1. SEO 配置 (SEO Config) =================

    /// <summary>
    /// 获取全站 SEO 配置 (公共接口)
    /// </summary>
    [AllowAnonymous]
    [HttpGet("seo")]
    public async Task<ActionResult<ApiResponse<SeoConfigDto>>> GetSeoConfig()
    {
        var data = await _systemService.GetSeoConfigAsync();
        return Ok(ApiResponse<SeoConfigDto>.Success(data));
    }

    /// <summary>
    /// 更新全站 SEO 配置 (管理员权限)
    /// </summary>
    [Authorize(Roles = "admin")]
    [HttpPut("seo")]
    public async Task<ActionResult<ApiResponse>> UpdateSeoConfig([FromBody] SeoConfigDto dto)
    {
        _logger.LogWarning("管理员 {User} 正在修改全站 SEO 配置", User.Identity?.Name);

        await _systemService.UpdateSeoConfigAsync(dto);

        return Ok(ApiResponse.Success("SEO 配置已更新并同步至缓存"));
    }

    // ================= 2. 动态页面 (Page Content) =================

    /// <summary>
    /// 获取动态页面内容 (如：关于、隐私政策、使用规范)
    /// </summary>
    /// <param name="slug">页面标识符 (about, privacy, guidelines)</param>
    [HttpGet("page/{slug}")]
    [AllowAnonymous]
    public async Task<ActionResult<ApiResponse<PageContentDto>>> GetPage(string slug)
    {
        // 1. 安全白名单过滤
        var allowed = new[] { "about", "privacy", "guidelines" };

        if (string.IsNullOrWhiteSpace(slug) || !allowed.Contains(slug.ToLower()))
        {
            _logger.LogWarning("拦截到非法的页面请求 Slug: {Slug}", slug);
            return NotFound(ApiResponse.Fail("请求的页面不存在", 404));
        }

        // 2. 调用具备缓存降级能力的服务
        var data = await _systemService.GetPageContentAsync(slug);
        return Ok(ApiResponse<PageContentDto>.Success(data));
    }

    /// <summary>
    /// 更新动态页面内容 (仅限管理员)
    /// </summary>
    [Authorize(Roles = "admin")]
    [HttpPut("page")]
    public async Task<ActionResult<ApiResponse>> UpdatePage([FromBody] PageContentDto dto)
    {
        if (string.IsNullOrEmpty(dto.Slug))
        {
            return BadRequest(ApiResponse.Fail("页面标识 (Slug) 不能为空"));
        }

        _logger.LogInformation("审计日志：管理员正在更新页面内容 | Slug: {Slug}", dto.Slug);

        await _systemService.UpdatePageContentAsync(dto);

        return Ok(ApiResponse.Success($"{dto.Slug} 页面内容已发布，全局缓存已刷新"));
    }
}
