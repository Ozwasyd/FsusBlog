using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Helpers.Security;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Outputs;
using SqlSugar;
using System.Buffers;
using System.Data.Common;

namespace FsusBlog.Server.Modules.Endpoints.Binary;

public static partial class BinaryEndpoints
{
    private static void MapBinaryCommentEndpoints(IEndpointRouteBuilder group, Int64CursorCodec cursorCodec)
    {
        group.MapPost("/comment", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            ICommentEndpointService commentService,
            IContentFilterService contentFilterService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            int userId = httpContext.User.GetUserId();
            if (userId <= 0)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, "未授权的访问，请重新登录"), aeds);
            }

            var payload = await ReadBinaryRequestPayloadAsync(httpContext, aeds, AedsFrameType.CommentCreateRequest, cancellationToken);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodeCommentCreateRequest(payload.Payload, out var request))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "评论请求体非法"), aeds);
            }

            ContentValidationResult validation = contentFilterService.ValidateContent(request.Content);
            if (!validation.IsValid)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, validation.Message), aeds);
            }

            var dto = new CommentDto
            {
                ArticleId = request.ArticleId,
                Content = request.Content,
                ParentId = request.ParentId,
                RootId = request.RootId,
                ReplyToCommentId = request.ReplyToCommentId,
                ReplyToUserId = request.ReplyToUserId
            };

            bool success = await commentService.CreateCommentAsync(userId, dto);
            return success
                ? BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess)
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "发布失败：可能文章已关闭评论或数据异常"), aeds);
        })
        .RequireAuthorization()
        .RequireRateLimiting("fixed_ip")
        .AddEndpointFilter<RequiresPowFilter>();

        group.MapGet("/comment/{articleId:int}", async Task<BinaryFrameResult> (
            int articleId,
            HttpContext httpContext,
            ICommentEndpointService commentService,
            IAedsEncoder aeds) =>
        {
            CursorBindResult<long> bind = CursorPageBinder.Bind(httpContext.Request, CommentCursorPolicies.Threads, cursorCodec);
            if (!bind.IsSuccess)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, bind.ErrorMessage ?? "游标参数非法"), aeds);
            }

            var result = await commentService.GetCommentThreadsByCursorAsync(articleId, bind.Request);
            return BinaryResults.Frame(aeds, AedsFrameType.CommentArticleCursor, writer => PodBinaryCodec.WriteCommentThreadCursor(result, writer));
        })
        .AllowAnonymous()
        .CacheOutput(HttpCachePolicyCatalog.ApplyCommentThreads);

        group.MapGet("/comment/{articleId:int}/thread/{rootId:long}", async Task<BinaryFrameResult> (
            int articleId,
            long rootId,
            HttpContext httpContext,
            ICommentEndpointService commentService,
            IAedsEncoder aeds) =>
        {
            CursorBindResult<long> bind = CursorPageBinder.Bind(httpContext.Request, CommentCursorPolicies.Replies, cursorCodec);
            if (!bind.IsSuccess)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, bind.ErrorMessage ?? "游标参数非法"), aeds);
            }

            var result = await commentService.GetThreadRepliesByCursorAsync(articleId, rootId, bind.Request);
            return BinaryResults.Frame(aeds, AedsFrameType.CommentThreadReplyCursor, writer => PodBinaryCodec.WriteCommentReplyCursor(rootId, result, writer));
        })
        .AllowAnonymous()
        .CacheOutput(HttpCachePolicyCatalog.ApplyCommentThreadReplies);

        group.MapGet("/comment/me", async Task<BinaryFrameResult> (
            HttpContext httpContext,
            ICommentCoreService core,
            IAedsEncoder aeds) =>
        {
            int userId = httpContext.User.GetUserId();
            if (userId <= 0)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, "未找到用户信息"), aeds);
            }

            CursorBindResult<long> bind = CursorPageBinder.Bind(httpContext.Request, CommentCursorPolicies.UserComments, cursorCodec);
            if (!bind.IsSuccess)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, bind.ErrorMessage ?? "游标参数非法"), aeds);
            }

            var result = await core.GetUserCommentsAsync(userId, bind.Request.Cursor, bind.Request.Limit);
            return BinaryResults.FromResult(result, aeds, AedsFrameType.CommentUserCursor, static (value, writer) => PodBinaryCodec.WriteUserCommentCursor(value, writer));
        }).RequireAuthorization();

        group.MapDelete("/comment/{id:long}", static async Task<BinaryFrameResult> (
            long id,
            string? reason,
            HttpContext httpContext,
            ICommentEndpointService commentService,
            IAedsEncoder aeds) =>
        {
            int userId = httpContext.User.GetUserId();
            bool isAdmin = httpContext.User.IsInRole("admin");
            bool success = await commentService.DeleteCommentAsync(id, userId, isAdmin, reason ?? "不符合社区规范");

            return success
                ? BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess)
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Forbidden, "未找到该评论或无权删除"), aeds);
        })
        .RequireAuthorization()
        .AddEndpointFilter<RequiresPowFilter>();
    }
}
