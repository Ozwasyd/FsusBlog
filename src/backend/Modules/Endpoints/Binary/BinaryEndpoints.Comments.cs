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
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Models.Requests;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;
using FsusBlog.Shared.Contracts.Outputs;
using SqlSugar;
using System.Buffers;
using System.Data.Common;
using System.Text;

namespace FsusBlog.Server.Modules.Endpoints.Binary;

public static partial class BinaryEndpoints
{
    private static void MapBinaryCommentEndpoints(IEndpointRouteBuilder group, Int64CursorCodec cursorCodec)
    {
        group.MapPost("/comment", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            ICommentEndpointService commentService,
            IContentFilterService contentFilterService,
            IClientRegionResolver regionResolver,
            IRegionLegalModerationService regionLegalModerationService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            int userId = httpContext.User.GetUserId();
            if (userId <= 0)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, "未授权的访问，请重新登录"), aeds);
            }

            var payload = await ReadBinaryRequestPayloadAsync(
                httpContext,
                aeds,
                AedsFrameType.CommentCreateRequest,
                cancellationToken,
                CommentLimits.CreatePayloadMaxBytes);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodeCommentCreateRequest(payload.Payload, out var request))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "评论请求体非法"), aeds);
            }

            string content = request.Content?.Trim() ?? string.Empty;
            if (!IsCommentContentWithinLimit(content))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, $"评论内容不能超过 {CommentLimits.ContentMaxChars} 字或 {CommentLimits.ContentMaxUtf8Bytes} 字节"), aeds);
            }

            ContentValidationResult validation = contentFilterService.ValidateContent(content);
            if (!validation.IsValid)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, validation.Message), aeds);
            }

            ClientRegionResolution submitRegion = regionResolver.Resolve(httpContext);
            RegionModerationDecision regionDecision = regionLegalModerationService.EvaluateOnSubmit(new RegionModerationRequest(
                content,
                request.ArticleId,
                userId,
                submitRegion.Region,
                submitRegion.Confidence,
                submitRegion.Provider,
                submitRegion.ClientIpHash,
                httpContext.Request.Headers.UserAgent.ToString(),
                DateTime.UtcNow));
            if (!regionDecision.CanPublish)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, regionDecision.PublicReason), aeds);
            }

            var dto = new CommentDto
            {
                ArticleId = request.ArticleId,
                Content = content,
                ParentId = request.ParentId,
                RootId = request.RootId,
                ReplyToCommentId = request.ReplyToCommentId,
                ReplyToUserId = request.ReplyToUserId,
                RegionDecision = regionDecision
            };

            bool success = await commentService.CreateCommentAsync(userId, dto);
            return success
                ? BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess)
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "发布失败：可能文章已关闭评论或数据异常"), aeds);
        })
        .RequireAuthorization()
        .RequireRateLimiting("fixed_ip")
        .AddEndpointFilter<RequiresPowFilter>();

        group.MapGet("/comment/{articleId:int}", async Task<IResult> (
            int articleId,
            HttpContext httpContext,
            ICommentEndpointService commentService,
            IClientRegionResolver regionResolver,
            IUnifiedCache cache,
            IAedsEncoder aeds) =>
        {
            CursorBindResult<long> bind = CursorPageBinder.Bind(httpContext.Request, CommentCursorPolicies.Threads, cursorCodec);
            if (!bind.IsSuccess)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, bind.ErrorMessage ?? "游标参数非法"), aeds);
            }

            string viewerRegion = regionResolver.Resolve(httpContext).Region;
            string identity = BuildCommentThreadFrameIdentity(articleId, bind.Request, previewLimit: 3, viewerRegion);
            CacheReadResult<ReadOnlyMemory<byte>> frame = await cache.TryGetRawReadonlyAsync(CachePolicyId.CommentCursorFrame, identity);
            if (frame.Hit && frame.Value.Length > 0)
            {
                return BinaryResults.PreencodedFrame(frame.Value);
            }

            var result = await commentService.GetCommentThreadsByCursorAsync(articleId, bind.Request, viewerRegion: viewerRegion);
            byte[] payload = PodBinaryCodec.EncodeCommentThreadCursor(result);
            byte[] encodedFrame = aeds.Encode(AedsFrameType.CommentArticleCursor, payload);
            await cache.SetRawAsync(CachePolicyId.CommentCursorFrame, identity, encodedFrame, TimeSpan.FromMinutes(5), httpContext.RequestAborted);
            return BinaryResults.PreencodedFrame(encodedFrame);
        })
        .AllowAnonymous()
        .RequireRateLimiting("public_read")
        .AddEndpointFilter<RiskAwarePublicReadFilter>();

        group.MapGet("/comment/{articleId:int}/thread/{rootId:long}", async Task<IResult> (
            int articleId,
            long rootId,
            HttpContext httpContext,
            ICommentEndpointService commentService,
            IClientRegionResolver regionResolver,
            IUnifiedCache cache,
            IAedsEncoder aeds) =>
        {
            CursorBindResult<long> bind = CursorPageBinder.Bind(httpContext.Request, CommentCursorPolicies.Replies, cursorCodec);
            if (!bind.IsSuccess)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, bind.ErrorMessage ?? "游标参数非法"), aeds);
            }

            string viewerRegion = regionResolver.Resolve(httpContext).Region;
            string identity = BuildCommentReplyFrameIdentity(articleId, rootId, bind.Request, viewerRegion);
            CacheReadResult<ReadOnlyMemory<byte>> frame = await cache.TryGetRawReadonlyAsync(CachePolicyId.CommentCursorFrame, identity);
            if (frame.Hit && frame.Value.Length > 0)
            {
                return BinaryResults.PreencodedFrame(frame.Value);
            }

            var result = await commentService.GetThreadRepliesByCursorAsync(articleId, rootId, bind.Request, viewerRegion);
            byte[] payload = PodBinaryCodec.EncodeCommentReplyCursor(rootId, result);
            byte[] encodedFrame = aeds.Encode(AedsFrameType.CommentThreadReplyCursor, payload);
            await cache.SetRawAsync(CachePolicyId.CommentCursorFrame, identity, encodedFrame, TimeSpan.FromMinutes(5), httpContext.RequestAborted);
            return BinaryResults.PreencodedFrame(encodedFrame);
        })
        .AllowAnonymous()
        .RequireRateLimiting("public_read")
        .AddEndpointFilter<RiskAwarePublicReadFilter>();

        group.MapGet("/comment/me", async Task<IResult> (
            HttpContext httpContext,
            ICommentCoreService core,
            IUnifiedCache cache,
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

            string identity = BuildUserCommentFrameIdentity(userId, bind.Request);
            CacheReadResult<ReadOnlyMemory<byte>> frame = await cache.TryGetRawReadonlyAsync(CachePolicyId.UserCommentCursorFrame, identity);
            if (frame.Hit && frame.Value.Length > 0)
            {
                return BinaryResults.PreencodedFrame(frame.Value);
            }

            var result = await core.GetUserCommentsAsync(userId, bind.Request.Cursor, bind.Request.Limit);
            if (!result.IsSuccess)
            {
                return BinaryResults.FromError(result.Error, aeds);
            }

            byte[] payload = PodBinaryCodec.EncodeUserCommentCursor(result.Value);
            byte[] encodedFrame = aeds.Encode(AedsFrameType.CommentUserCursor, payload);
            await cache.SetRawAsync(CachePolicyId.UserCommentCursorFrame, identity, encodedFrame, TimeSpan.FromMinutes(5), httpContext.RequestAborted);
            return BinaryResults.PreencodedFrame(encodedFrame);
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

    private static bool IsCommentContentWithinLimit(string content)
        => !string.IsNullOrWhiteSpace(content)
            && content.Length <= CommentLimits.ContentMaxChars
            && Encoding.UTF8.GetByteCount(content) <= CommentLimits.ContentMaxUtf8Bytes;

    private static string BuildCommentThreadFrameIdentity(int articleId, CursorPageRequest<long> request, int previewLimit, string viewerRegion)
        => $"article:{articleId}:roots:{request.Cursor?.ToString() ?? "0"}:{request.Limit}:{previewLimit}:region:{NormalizeCommentFrameRegion(viewerRegion)}";

    private static string BuildCommentReplyFrameIdentity(int articleId, long rootId, CursorPageRequest<long> request, string viewerRegion)
        => $"article:{articleId}:root:{rootId}:replies:{request.Cursor?.ToString() ?? "0"}:{request.Limit}:region:{NormalizeCommentFrameRegion(viewerRegion)}";

    private static string BuildUserCommentFrameIdentity(int userId, CursorPageRequest<long> request)
        => $"user:{userId}:comments:{request.Cursor?.ToString() ?? "0"}:{request.Limit}";

    private static string NormalizeCommentFrameRegion(string? viewerRegion)
    {
        string value = (viewerRegion ?? RegionCodes.Unknown).Trim().ToUpperInvariant();
        if (value.Length == 0)
        {
            return RegionCodes.Unknown;
        }

        return value.Replace(':', '_').Replace('/', '_');
    }
}
