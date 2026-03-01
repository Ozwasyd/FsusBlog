using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Responses;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.OutputCaching;
using System.Security.Claims;

namespace FsusBlog.Server.Modules.Endpoints;

/// <summary>
/// 评论公开查询端点 (Minimal API)
/// 修复日期: 2026-02-23 (适配统一的 DTO 定义，修复返回类型推断)
/// </summary>
public static class CommentEndpoints
{
    public static void MapCommentEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("api/Comment").WithTags("Comment");

        // GET /api/Comment/{articleId}
        group.MapGet("/{articleId:int}", async Task<Ok<ApiResponse<CommentListResponseDto>>> (
            int articleId,
            long? cursor,
            int? limit,
            ICommentService commentService) =>
        {
            int actualLimit = Math.Clamp(limit ?? 10, 5, 50);
            // 此时 result 的 Data 已经是 struct 类型的 CommentQueryResultDto 了
            var result = await commentService.GetCommentsByCursorAsync(articleId, cursor, actualLimit);

            var data = new List<CommentItemDto>(result.Data.Count);
            foreach (var c in result.Data)
            {
                // 这里的 c 已经是映射好的 struct，读取速度极快且零分配
                data.Add(new CommentItemDto(c.Id.ToString(), c.Content, c.CreateTime, c.UserName));
            }

            var response = new CommentListResponseDto(data, result.NextCursor, result.HasMore);
            return TypedResults.Ok(ApiResponse<CommentListResponseDto>.Success(response));
        });

        // GET /api/Comment/me
        group.MapGet("/me", async Task<Results<Ok<ApiResponse<CursorResult<UserCommentDto>>>, JsonHttpResult<ApiResponse>>> (
             long? cursor,
             int? limit,
             ICommentService commentService,
             ClaimsPrincipal user) =>
        {
            int userId = user.GetUserId();
            if (userId == 0) return TypedResults.Json(ApiResponse.Fail("未找到用户信息", 401), statusCode: 401);

            int actualLimit = Math.Clamp(limit ?? 10, 5, 50);
            var result = await commentService.GetUserCommentsAsync(userId, cursor, actualLimit);

            return TypedResults.Ok(ApiResponse<CursorResult<UserCommentDto>>.Success(result));
        })
         .RequireAuthorization();
    }
}