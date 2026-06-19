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
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models;
using FsusBlog.Server.Models.CommentIdentity;
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
    private static void MapBinaryCommentEndpoints(IEndpointRouteBuilder group)
    {
        group.MapGet("/comment/policy", static BinaryFrameResult (
            IAnonymousCommentPolicyService policyService,
            IAedsEncoder aeds) =>
        {
            CommentPolicySnapshotCoreModel snapshot = ToCommentPolicyCore(policyService.Current);
            return BinaryResults.Frame(
                aeds,
                AedsFrameType.CommentPolicySnapshot,
                writer => PodBinaryCodec.WriteCommentPolicySnapshot(snapshot, writer));
        })
        .AllowAnonymous()
        .RequireRateLimiting("public_read");

        group.MapPost("/comment/anonymous-ticket", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            IAedsEncoder aeds,
            IAnonymousCommentTicketService ticketService,
            CancellationToken cancellationToken) =>
            await HandleAnonymousCommentTicketAsync(httpContext, aeds, ticketService, cancellationToken))
        .AllowAnonymous()
        .RequireRateLimiting("public_read")
        .RequireStrongAnonymousRequest();

        group.MapPost("/comment", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            ICommentEndpointService commentService,
            IContentFilterService contentFilterService,
            IClientRegionResolver regionResolver,
            IRegionLegalModerationService regionLegalModerationService,
            ISecurityRiskSignalSink riskSignals,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            int userId = httpContext.GetUserId();
            if (userId <= 0)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, "未授权的访问，请重新登录"), aeds);
            }

            var payload = await ReadBinaryRequestPayloadAsync(
                httpContext,
                aeds,
                [AedsFrameType.CommentCreateRequest, AedsFrameType.CommentCreateV2Request],
                cancellationToken,
                CommentLimits.CreatePayloadMaxBytes);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            bool isV2Request = payload.FrameType == AedsFrameType.CommentCreateV2Request;
            CommentCreateV2RequestCoreModel requestV2 = default;
            CommentCreateRequestCoreModel requestLegacy = default;
            if (isV2Request)
            {
                if (!PodBinaryCodec.TryDecodeCommentCreateV2Request(payload.Payload, out requestV2))
                {
                    return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "评论请求体非法"), aeds);
                }
            }
            else if (!PodBinaryCodec.TryDecodeCommentCreateRequest(payload.Payload, out requestLegacy))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "评论请求体非法"), aeds);
            }

            string content = (isV2Request ? requestV2.Content : requestLegacy.Content)?.Trim() ?? string.Empty;
            if (!IsCommentContentWithinLimit(content))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, $"评论内容不能超过 {CommentLimits.ContentMaxChars} 字或 {CommentLimits.ContentMaxUtf8Bytes} 字节"), aeds);
            }

            ContentValidationResult validation = contentFilterService.ValidateContent(content);
            if (!validation.IsValid)
            {
                await RecordCommentRiskSignalAsync(
                    httpContext,
                    riskSignals,
                    SecurityRiskReason.CommentSpamPattern,
                    "content_filter",
                    score: 10,
                    cancellationToken);
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, validation.Message), aeds);
            }

            ClientRegionResolution submitRegion = regionResolver.Resolve(httpContext);
            int articleId = isV2Request ? requestV2.ArticleId : requestLegacy.ArticleId;
            RegionModerationDecision regionDecision = regionLegalModerationService.EvaluateOnSubmit(new RegionModerationRequest(
                content,
                articleId,
                userId,
                submitRegion.Region,
                submitRegion.Confidence,
                submitRegion.Provider,
                submitRegion.ClientIpHash,
                httpContext.GetUserAgent(),
                DateTime.UtcNow));
            if (ShouldRecordRegionRiskSignal(regionDecision))
            {
                await RecordCommentRiskSignalAsync(
                    httpContext,
                    riskSignals,
                    SecurityRiskReason.CommentRegionCompliance,
                    regionDecision.DecisionReason,
                    score: 8,
                    cancellationToken);
            }

            if (!regionDecision.CanPublish)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, regionDecision.PublicReason), aeds);
            }

            regionDecision = ApplyRiskControlModerationDecision(httpContext, regionDecision);

            bool success;
            if (isV2Request)
            {
                requestV2 = requestV2 with { Content = content };
                success = await commentService.CreateCommentV2Async(userId, requestV2, regionDecision);
            }
            else
            {
                var dto = new CommentDto
                {
                    ArticleId = requestLegacy.ArticleId,
                    Content = content,
                    ParentId = requestLegacy.ParentId,
                    RootId = requestLegacy.RootId,
                    ReplyToCommentId = requestLegacy.ReplyToCommentId,
                    ReplyToUserId = requestLegacy.ReplyToUserId,
                    RegionDecision = regionDecision
                };

                success = await commentService.CreateCommentAsync(userId, dto);
            }

            return success
                ? BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess)
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "发布失败：可能文章已关闭评论或数据异常"), aeds);
        })
        .RequireAuthorization()
        .RequireRateLimiting("fixed_ip")
        .WithRiskAction(RiskActionNames.CommentCreate)
        .AddEndpointFilter<CommentRiskActionFilter>()
        .AddEndpointFilter<RequiresRiskControlFilter>()
        .AddEndpointFilter<RequiresPowFilter>();

        group.MapGet("/comment/{articleId:int}", static async Task<IResult> (
            int articleId,
            HttpContext httpContext,
            ICommentEndpointService commentService,
            IClientRegionResolver regionResolver,
            IUnifiedCache cache,
            IAedsEncoder aeds) =>
        {
            CursorBindResult<long> bind = CursorPageBinder.Bind(httpContext.Request, CommentCursorPolicies.Threads, Int64CursorCodec.Instance);
            if (!bind.IsSuccess)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, bind.ErrorMessage ?? "游标参数非法"), aeds);
            }

            string viewerRegion = regionResolver.Resolve(httpContext).Region;
            string identity = BuildCommentThreadFrameIdentity(articleId, bind.Request, previewLimit: 3, viewerRegion);
            CacheReadResult<ReadOnlyMemory<byte>> frame = await cache.TryGetRawReadonlyAsync(CachePolicyId.CommentCursorFrame, identity, httpContext.RequestAborted);
            if (frame.Hit && frame.Value.Length > 0)
            {
                return BinaryResults.PreencodedFrame(frame.Value);
            }

            var result = await commentService.GetCommentThreadsByCursorAsync(articleId, bind.Request, viewerRegion: viewerRegion);
            byte[] encodedFrame = EncodeCachedFrame(AedsFrameType.CommentArticleCursor, writer => PodBinaryCodec.WriteCommentThreadCursor(result, writer));
            await cache.SetRawAsync(CachePolicyId.CommentCursorFrame, identity, encodedFrame, TimeSpan.FromMinutes(5), httpContext.RequestAborted);
            return BinaryResults.PreencodedFrame(encodedFrame);
        })
        .AllowAnonymous()
        .RequireRateLimiting("public_read")
        .AddEndpointFilter<RiskAwarePublicReadFilter>();

        group.MapGet("/comment/{articleId:int}/thread/{rootId:long}", static async Task<IResult> (
            int articleId,
            long rootId,
            HttpContext httpContext,
            ICommentEndpointService commentService,
            IClientRegionResolver regionResolver,
            IUnifiedCache cache,
            IAedsEncoder aeds) =>
        {
            CursorBindResult<long> bind = CursorPageBinder.Bind(httpContext.Request, CommentCursorPolicies.Replies, Int64CursorCodec.Instance);
            if (!bind.IsSuccess)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, bind.ErrorMessage ?? "游标参数非法"), aeds);
            }

            string viewerRegion = regionResolver.Resolve(httpContext).Region;
            string identity = BuildCommentReplyFrameIdentity(articleId, rootId, bind.Request, viewerRegion);
            CacheReadResult<ReadOnlyMemory<byte>> frame = await cache.TryGetRawReadonlyAsync(CachePolicyId.CommentCursorFrame, identity, httpContext.RequestAborted);
            if (frame.Hit && frame.Value.Length > 0)
            {
                return BinaryResults.PreencodedFrame(frame.Value);
            }

            var result = await commentService.GetThreadRepliesByCursorAsync(articleId, rootId, bind.Request, viewerRegion);
            byte[] encodedFrame = EncodeCachedFrame(AedsFrameType.CommentThreadReplyCursor, writer => PodBinaryCodec.WriteCommentReplyCursor(rootId, result, writer));
            await cache.SetRawAsync(CachePolicyId.CommentCursorFrame, identity, encodedFrame, TimeSpan.FromMinutes(5), httpContext.RequestAborted);
            return BinaryResults.PreencodedFrame(encodedFrame);
        })
        .AllowAnonymous()
        .RequireRateLimiting("public_read")
        .AddEndpointFilter<RiskAwarePublicReadFilter>();

        group.MapGet("/comment/me", static async Task<IResult> (
            HttpContext httpContext,
            ICommentCoreService core,
            IUnifiedCache cache,
            IAedsEncoder aeds) =>
        {
            int userId = httpContext.GetUserId();
            if (userId <= 0)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, "未找到用户信息"), aeds);
            }

            CursorBindResult<long> bind = CursorPageBinder.Bind(httpContext.Request, CommentCursorPolicies.UserComments, Int64CursorCodec.Instance);
            if (!bind.IsSuccess)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, bind.ErrorMessage ?? "游标参数非法"), aeds);
            }

            string identity = BuildUserCommentFrameIdentity(userId, bind.Request);
            CacheReadResult<ReadOnlyMemory<byte>> frame = await cache.TryGetRawReadonlyAsync(CachePolicyId.UserCommentCursorFrame, identity, httpContext.RequestAborted);
            if (frame.Hit && frame.Value.Length > 0)
            {
                return BinaryResults.PreencodedFrame(frame.Value);
            }

            var result = await core.GetUserCommentsAsync(userId, bind.Request.Cursor, bind.Request.Limit);
            if (!result.IsSuccess)
            {
                return BinaryResults.FromError(result.Error, aeds);
            }

            byte[] encodedFrame = EncodeCachedFrame(AedsFrameType.CommentUserCursor, writer => PodBinaryCodec.WriteUserCommentCursor(result.Value, writer));
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
            int userId = httpContext.GetUserId();
            bool isAdmin = httpContext.User.IsInRole("admin");
            bool success = await commentService.DeleteCommentAsync(id, userId, isAdmin, reason ?? "不符合社区规范");

            return success
                ? BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess)
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Forbidden, "未找到该评论或无权删除"), aeds);
        })
        .RequireAuthorization()
        .AddEndpointFilter<RequiresPowFilter>();
    }

    internal static async Task<BinaryFrameResult> HandleAnonymousCommentTicketAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        IAnonymousCommentTicketService ticketService,
        CancellationToken cancellationToken)
    {
        var payload = await ReadBinaryRequestPayloadAsync(
            httpContext,
            aeds,
            [AedsFrameType.AnonymousCommentTicketRequest],
            cancellationToken,
            AnonymousCommentTicketService.MaxRequestFrameBytes);
        if (!payload.IsSuccess)
        {
            return BinaryResults.FromError(payload.Error, aeds);
        }

        if (!PodBinaryCodec.TryDecodeAnonymousCommentTicketRequest(payload.Payload, out AnonymousCommentTicketRequestCoreModel request))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "anonymous_comment_ticket_request_invalid"), aeds);
        }

        AnonymousCommentTicketIssueResult result = await ticketService.IssueAsync(request, cancellationToken);
        return result.Issued
            ? BinaryResults.Frame(
                aeds,
                AedsFrameType.AnonymousCommentTicketResponse,
                writer => PodBinaryCodec.WriteAnonymousCommentTicketResponse(result.Response, writer))
            : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, result.PublicMessage), aeds);
    }

    private static bool IsCommentContentWithinLimit(string content)
        => !string.IsNullOrWhiteSpace(content)
            && content.Length <= CommentLimits.ContentMaxChars
            && Encoding.UTF8.GetByteCount(content) <= CommentLimits.ContentMaxUtf8Bytes;

    private static RegionModerationDecision ApplyRiskControlModerationDecision(
        HttpContext httpContext,
        RegionModerationDecision decision)
    {
        if (httpContext.Items[RiskControlDecisionContext.HttpContextItemKey] is not RiskControlDecisionContext { Decision.Kind: RiskDecisionKind.QueueForModeration } context)
        {
            return decision;
        }

        RiskDecision riskDecision = context.Decision;
        string riskReason = $"risk_control_queue:{string.Join(',', riskDecision.Reasons)}";
        List<string> riskLabels = AppendDistinct(
            decision.RiskLabels,
            [
                "risk_control_queue",
                $"risk_action:{riskDecision.ActionName}",
                $"risk_score:{riskDecision.EffectiveRiskScore}"
            ]);

        return decision with
        {
            RiskLabels = riskLabels,
            DecisionReason = NormalizeCommentRiskDetail(riskReason, 256),
            RequiresManualReview = true,
            HideUntilReviewed = true
        };
    }

    private static async ValueTask RecordCommentRiskSignalAsync(
        HttpContext httpContext,
        ISecurityRiskSignalSink riskSignals,
        SecurityRiskReason reason,
        string? detail,
        int score,
        CancellationToken cancellationToken)
    {
        await riskSignals.AddRiskAsync(new SecurityRiskSignal(
            httpContext,
            reason,
            score,
            TimeSpan.FromMinutes(15),
            SecurityRiskSources.RiskControl,
            ResolveCommentRiskAction(httpContext),
            NormalizeCommentRiskDetail(detail, 256)), cancellationToken);
    }

    private static bool ShouldRecordRegionRiskSignal(RegionModerationDecision decision)
        => !decision.CanPublish
            || decision.RequiresManualReview
            || decision.HideUntilReviewed
            || decision.RiskLabels.Count > 0;

    private static string ResolveCommentRiskAction(HttpContext httpContext)
        => httpContext.Items[RiskActionEndpointMetadata.HttpContextItemKey] is RiskActionEndpointMetadata metadata
            ? metadata.ActionName
            : RiskActionNames.CommentCreate;

    private static List<string> AppendDistinct(IReadOnlyList<string> values, IReadOnlyList<string> additions)
    {
        var merged = new List<string>(values.Count + additions.Count);
        foreach (string value in values.Concat(additions))
        {
            string normalized = value.Trim();
            if (normalized.Length > 0 && !merged.Contains(normalized, StringComparer.Ordinal))
            {
                merged.Add(normalized);
            }
        }

        return merged;
    }

    private static string NormalizeCommentRiskDetail(string? value, int maxLength)
    {
        string normalized = (value ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            return "comment_risk";
        }

        return normalized.Length <= maxLength ? normalized : normalized[..maxLength];
    }

    private static CommentPolicySnapshotCoreModel ToCommentPolicyCore(AnonymousCommentPolicySnapshot snapshot)
        => new(
            snapshot.AnonymousCommentsEnabled,
            snapshot.PublicCommentsEnabled,
            snapshot.ZkAnonymousEnabled,
            snapshot.DefaultAuthorMode,
            snapshot.SupportedDisplayLanguages);

    private static byte[] EncodeCachedFrame(AedsFrameType frameType, Action<IBufferWriter<byte>> writePayload)
    {
        using var frameWriter = new AedsFrameBufferWriter();
        writePayload(frameWriter.PayloadWriter);
        frameWriter.Seal(frameType);
        return frameWriter.WrittenFrame.ToArray();
    }

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
