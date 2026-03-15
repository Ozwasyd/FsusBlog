using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.OutputCaching;
using StackExchange.Redis;
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
        group.MapGet("/", async Task<Results<Ok<ApiResponse<PageResultDto<ArticleListDto>>>, JsonHttpResult<ApiResponse>>> (
            [AsParameters] ArticleQueryRequestDto req,
            IArticleService articleService,
            ClaimsPrincipal user) =>
        {
            if (req.IsDeleted && (user.Identity?.IsAuthenticated != true || !user.IsInRole("admin")))
            {
                return TypedResults.Json(ApiResponse.Fail("权限不足", 403), statusCode: 403);
            }
            var result = await articleService.GetPageListAsync(req.Page, req.Size, req.CategoryId, req.TagId, req.IsDeleted);
            return TypedResults.Ok(ApiResponse<PageResultDto<ArticleListDto>>.Success(result));
        })
        .CacheOutput(p => p.SetVaryByQuery("page", "size", "categoryId", "tagId", "isDeleted").Expire(TimeSpan.FromMinutes(1)).Tag("ArticleList"));

        // 2. 获取文章详情 (GET /api/Article/{id})
        // 核心修复：移除 CacheOutput，确保阅读量统计逻辑每次都被触发
        group.MapGet("/{id:int}", async Task<Results<Ok<ApiResponse<ArticleDetailDto>>, NotFound<ApiResponse>>> (
            int id,
            IArticleService articleService,
            IConnectionMultiplexer redis,
            HttpContext context) =>
        {
            var article = await articleService.GetByIdAsync(id);
            if (article == null) return TypedResults.NotFound(ApiResponse.Fail("文章不存在", 404));

            var db = redis.GetDatabase();
            var clientIp = context.GetClientIp();

            // 零分配 ViewLock Key
            const string LockPrefix = "view_lock:";
            int idDigits = DigitCount.GetDigitCount(id);
            string lockKey = string.Create(LockPrefix.Length + idDigits + 1 + clientIp.Length, (id, clientIp), (span, state) =>
            {
                LockPrefix.AsSpan().CopyTo(span);
                state.id.TryFormat(span[LockPrefix.Length..], out int w);
                span[LockPrefix.Length + w] = ':';
                state.clientIp.AsSpan().CopyTo(span[(LockPrefix.Length + w + 1)..]);
            });

            if (await db.StringSetAsync(lockKey, "1", TimeSpan.FromHours(1), When.NotExists))
            {
                await articleService.IncreaseViewCountAsync(id);
                article.Views += 1;
            }

            // 对齐前端契约：组装嵌套的 CategoryView
            var detailDto = new ArticleDetailDto
            {
                Id = article.Id,
                Title = article.Title,
                Content = article.Content,
                Summary = article.Summary,
                Views = article.Views,
                CreateTime = article.CreateTime,
                Category = new ArticleCategoryView(article.CategoryId, article.Category?.Name ?? "默认"),
                Tags = [.. article.Tags.Select(t => new TagDto(t.Id, t.Name))]
            };

            return TypedResults.Ok(ApiResponse<ArticleDetailDto>.Success(detailDto));
        });

        // 3. 热门文章 (GET /api/Article/hot)
        group.MapGet("/hot", async Task<Ok<ApiResponse<List<PopularArticleDto>>>> (
            int? size,
            IArticleService articleService) =>
        {
            int actualSize = Math.Clamp(size ?? 10, 1, 50);
            var hotArticles = await articleService.GetHotArticlesAsync(actualSize);
            return TypedResults.Ok(ApiResponse<List<PopularArticleDto>>.Success(hotArticles));
        })
        .CacheOutput(p => p.SetVaryByQuery("size").Expire(TimeSpan.FromMinutes(2)).Tag("HotArticles"));

        // 4. 全文搜索 (GET /api/Article/search)
        group.MapGet("/search", async Task<Results<Ok<ApiResponse<List<ArticleListDto>>>, BadRequest<ApiResponse>, JsonHttpResult<ApiResponse>>> (
            [AsParameters] SearchDto dto,
            IArticleService articleService,
            HttpContext context) =>
        {
            if (string.IsNullOrWhiteSpace(dto.Keyword))
                return TypedResults.BadRequest(ApiResponse.Fail("搜索关键词不能为空"));


            var results = await articleService.SearchArticlesAsync(dto.Keyword);
            return TypedResults.Ok(ApiResponse<List<ArticleListDto>>.Success(results));
        })
        .RequireRateLimiting("fixed_ip")
        .AllowAnonymous()
        .AddEndpointFilter<RequiresPowFilter>();
    }
}