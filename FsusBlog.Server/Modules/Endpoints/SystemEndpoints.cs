using FsusBlog.Server.Infrastructure.Helpers.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using Microsoft.AspNetCore.Http.HttpResults;

namespace FsusBlog.Server.Modules.Endpoints;

/// <summary>
/// 系统配置查询端点 (Minimal API)
/// 修复日期: 2026-02-23 
/// </summary>
public static class SystemEndpoints
{
    // 核心安全与性能优化：将白名单固化为静态哈希集，实现 O(1) 零分配查找
    private static readonly HashSet<string> _allowedPageSlugs = new(StringComparer.OrdinalIgnoreCase)
    {
        "about", "privacy", "guidelines"
    };

    public static void MapSystemEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("api/System").WithTags("System");

        // GET /api/System/seo
        group.MapGet("/seo", static async (ISystemService systemService) =>
        {
            var data = await systemService.GetSeoConfigAsync();
            return TypedResults.Ok(ApiResponse<SeoConfigDto>.Success(data));
        })
        .AllowAnonymous()
        .CacheOutput(p => p.Expire(TimeSpan.FromMinutes(10)));

        // GET /api/System/page/{slug}
        group.MapGet("/page/{slug}", static async Task<Results<Ok<ApiResponse<PageContentDto>>, NotFound<ApiResponse>>> (
             string slug,
             ISystemService systemService,
             ILoggerFactory loggerFactory) =>
        {
            var slugSpan = slug.AsSpan();

            // 核心安全优化：
            // 1. 物理层拦截：利用 SIMD 确保 slug 不含任何非法路径字符或注入字符
            // 2. 逻辑层拦截：查白名单
            if (slugSpan.IsEmpty ||
                !FastCharValidator.IsAlphaNumericHyphen(slugSpan) ||
                !_allowedPageSlugs.Contains(slug))
            {
                var logger = loggerFactory.CreateLogger("SystemEndpoints");
                logger.LogWarning("拦截到非法的页面请求 Slug: {Slug}", slug);
                return TypedResults.NotFound(ApiResponse.Fail("请求的页面不存在", 404));
            }

            var data = await systemService.GetPageContentAsync(slug);
            return TypedResults.Ok(ApiResponse<PageContentDto>.Success(data));
        })
         .AllowAnonymous()
         .CacheOutput(p => p.SetVaryByRouteValue("slug").Expire(TimeSpan.FromMinutes(30)));
    }
}