using FsusBlog.Server.Entities;
using FsusBlog.Shared.Contracts.Outputs;
using FsusBlog.Server.Models.Responses;
using Microsoft.AspNetCore.OutputCaching;
using SqlSugar;

namespace FsusBlog.Server.Modules.Endpoints;

/// <summary>
/// 文章标签查询端点 (Minimal API)
/// 修复日期: 2026-02-23 (适配统一的 DTO 定义)
/// </summary>
public static class TagEndpoints
{
    public static void MapTagEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("api/Tag").WithTags("Tag");

        // GET /api/Tag
        group.MapGet("/", async (ISqlSugarClient db) =>
        {
            var articleCounts = await db.Queryable<ArticleTag>()
                .GroupBy(at => at.TagId)
                .Select(at => new { TagId = at.TagId, Count = SqlFunc.AggregateCount(at.ArticleId) })
                .ToListAsync();

            var countDict = articleCounts.ToDictionary(x => x.TagId, x => x.Count);

            var tags = await db.Queryable<Tag>().OrderBy(t => t.Id).ToListAsync();

            var result = tags.Select(t => new TagWithCountDto(
                t.Id,
                t.Name,
                countDict.GetValueOrDefault(t.Id, 0)
            )).ToList();

            return TypedResults.Ok(ApiResponse<List<TagWithCountDto>>.Success(result));
        })
        .CacheOutput(p => p.Expire(TimeSpan.FromMinutes(5)).Tag("Tag")); // 增加 Tag 以便手动失效
    }
}
