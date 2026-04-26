using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Models.Responses;
using FsusBlog.Server.Services;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.AspNetCore.Http.HttpResults;
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
        Int64CursorCodec cursorCodec = Int64CursorCodec.Instance;

        // GET /api/Comment/{articleId}
        group.MapGet("/{articleId:int}", async Task<Results<Ok<ApiResponse<CursorResponse<CommentThreadItemDto>>>, BadRequest<ApiResponse>>> (
            int articleId,
            HttpContext httpContext,
            CommentService commentService) =>
        {
            CursorBindResult<long> bind = CursorPageBinder.Bind(httpContext.Request, CommentCursorPolicies.Threads, cursorCodec);
            if (!bind.IsSuccess)
            {
                return ApiResults.BadRequest(bind.ErrorMessage ?? "游标参数非法");
            }

            var threaded = await commentService.GetCommentThreadsByCursorAsync(articleId, bind.Request);
            return ApiResults.Ok(threaded);
        });

        group.MapGet("/{articleId:int}/thread/{rootId:long}", async Task<Results<Ok<ApiResponse<CursorResponse<CommentReplyItemDto>>>, BadRequest<ApiResponse>>> (
            int articleId,
            long rootId,
            HttpContext httpContext,
            CommentService commentService) =>
        {
            CursorBindResult<long> bind = CursorPageBinder.Bind(httpContext.Request, CommentCursorPolicies.Replies, cursorCodec);
            if (!bind.IsSuccess)
            {
                return ApiResults.BadRequest(bind.ErrorMessage ?? "游标参数非法");
            }

            var replyCursor = await commentService.GetThreadRepliesByCursorAsync(articleId, rootId, bind.Request);
            return ApiResults.Ok(replyCursor);
        });

        // GET /api/Comment/me
        group.MapGet("/me", async Task<Results<Ok<ApiResponse<CursorResponse<UserCommentResponse>>>, JsonHttpResult<ApiResponse>, BadRequest<ApiResponse>>> (
             HttpContext httpContext,
             CommentService commentService,
             ClaimsPrincipal user) =>
        {
            var userContext = EndpointUserContext.From(user);
            if (userContext.UserId == 0) return ApiResults.Unauthorized("未找到用户信息");

            CursorBindResult<long> bind = CursorPageBinder.Bind(httpContext.Request, CommentCursorPolicies.UserComments, cursorCodec);
            if (!bind.IsSuccess)
            {
                return ApiResults.BadRequest(bind.ErrorMessage ?? "游标参数非法");
            }

            var result = await commentService.GetUserCommentsAsync(userContext.UserId, bind.Request);

            return ApiResults.Ok(result);
        })
         .RequireAuthorization();
    }
}
