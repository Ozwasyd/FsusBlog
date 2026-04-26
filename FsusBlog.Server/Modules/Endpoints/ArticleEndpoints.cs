using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Models.Responses;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.OutputCaching;
using System.Security.Claims;

namespace FsusBlog.Server.Modules.Endpoints;

/// <summary>
/// 文章公开查询端点 (Minimal API)
/// 最终修复版: 2026-02-23 (应用 Results 联合返回类型，移除详情页 CacheOutput 以修复计数逻辑，对齐 struct 契约)
/// </summary>
public static class ArticleEndpoints
{
    public static void MapArticleEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("api/Article").WithTags("Article-Query");

        // 1. 获取文章列表 (GET /api/Article)
        group.MapGet("/", async Task<Results<Ok<ApiResponse<PageResponse<ArticleListItemResponse>>>, JsonHttpResult<ApiResponse>>> (
            [AsParameters] ArticleQueryRequest req,
            IArticleService articleService,
            ClaimsPrincipal user) =>
        {
            if (req.IsDeleted && (user.Identity?.IsAuthenticated != true || !user.IsInRole("admin")))
            {
                return ApiResults.Forbidden("权限不足");
            }
            var result = await articleService.GetPageListAsync(req.Page, req.Size, req.CategoryId, req.TagId, req.IsDeleted);
            return ApiResults.Ok(ArticleProjection.ToResponsePage(result));
        })
        .CacheOutput(HttpCachePolicyCatalog.ApplyArticleList);

        // 2. 获取文章详情 (GET /api/Article/{id})
        // 核心修复：移除 CacheOutput，确保阅读量统计逻辑每次都被触发
        group.MapGet("/{id:int}", async Task<Results<Ok<ApiResponse<ArticleDetailResponse>>, NotFound<ApiResponse>>> (
            int id,
            IArticleService articleService,
            IUnifiedCache cache,
            HttpContext context) =>
        {
            var article = await articleService.GetByIdAsync(id);
            if (article == null) return ApiResults.NotFound("文章不存在");

            string identity = BuildArticleViewerIdentity(context, id);
            if (await cache.TryAcquireLeaseAsync(CachePolicyId.ArticleViewLock, identity, "1", TimeSpan.FromHours(1)))
            {
                await articleService.IncreaseViewCountAsync(id);
                article = article with { Views = article.Views + 1 };
            }

            return ApiResults.Ok(ArticleProjection.ToResponse(article));
        });

        // 3. 热门文章 (GET /api/Article/hot)
        group.MapGet("/hot", async Task<Ok<ApiResponse<List<PopularArticleSummaryDto>>>> (
            int? size,
            IArticleService articleService) =>
        {
            int actualSize = Math.Clamp(size ?? 10, 1, 50);
            var hotArticles = await articleService.GetHotArticlesAsync(actualSize);
            return ApiResults.Ok(hotArticles);
        })
        .CacheOutput(HttpCachePolicyCatalog.ApplyHotArticles);
    }

    private static string BuildArticleViewerIdentity(HttpContext context, int articleId)
    {
        string? deviceFingerprint = GetDeviceFingerprint(context);
        if (!string.IsNullOrWhiteSpace(deviceFingerprint))
        {
            return $"article:{articleId}:viewer:fp:{deviceFingerprint}";
        }

        return $"article:{articleId}:viewer:ip:{context.GetClientIp()}";
    }

    private static string? GetDeviceFingerprint(HttpContext context)
    {
        if (!context.Request.Headers.TryGetValue("X-Fsus-Device-Fp", out var raw))
        {
            return null;
        }

        string? value = raw.ToString();
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        return value.Length <= 128 ? value : value[..128];
    }
}
