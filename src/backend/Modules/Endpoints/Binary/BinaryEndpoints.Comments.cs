using System.Buffers;
using System.Data.Common;
using System.Text;
using System.Text.Json;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Content;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Helpers.Security;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Pagination;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Infrastructure.Security;
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

namespace FsusBlog.Server.Modules.Endpoints.Binary;

public static partial class BinaryEndpoints
{
    private static readonly JsonSerializerOptions s_commentJsonOptions = new(JsonSerializerDefaults.Web);

    private static void MapBinaryCommentEndpoints(IEndpointRouteBuilder group)
    {
        group.MapGet("/comment/policy", static async Task<BinaryFrameResult> (
            int? articleId,
            long? rootId,
            IAnonymousCommentPolicyService policyService,
            IArticleCommentPolicyService articlePolicyService,
            IZkAnonymousProofService zkProofService,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            AnonymousCommentPolicySnapshot policy = await policyService.GetCurrentAsync(cancellationToken);
            if (articleId is > 0)
            {
                EffectiveArticleCommentPolicy effective = await articlePolicyService.ResolveAsync(articleId.Value, rootId, cancellationToken);
                bool writable = effective.IsOpen(DateTime.UtcNow) && !effective.ThreadLocked;
                policy = policy with
                {
                    AnonymousCommentsEnabled = policy.AnonymousCommentsEnabled && writable && effective.AnonymousCommentsEnabled,
                    PublicCommentsEnabled = policy.PublicCommentsEnabled && writable && effective.PublicCommentsEnabled,
                    SnapshotHash = effective.SnapshotHash,
                    Reason = effective.ThreadLocked ? "comment_thread_locked" : writable ? policy.Reason : "comment_policy_closed"
                };
            }
            CommentPolicySnapshotCoreModel snapshot = ToCommentPolicyCore(
                policy,
                zkProofService.CurrentZkCommentPolicy);
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
            IZkAnonymousProofService zkProofService,
            CancellationToken cancellationToken) =>
            await HandleAnonymousCommentTicketAsync(httpContext, aeds, ticketService, zkProofService, cancellationToken))
        .AllowAnonymous()
        .RequireRateLimiting("public_read")
        .RequireStrongAnonymousRequest();

        group.MapPost("/comment/anonymous", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            ICommentEndpointService commentService,
            IContentFilterService contentFilterService,
            IClientRegionResolver regionResolver,
            IRegionLegalModerationService regionLegalModerationService,
            ISecurityRiskSignalSink riskSignals,
            IZkAnonymousProofService zkProofService,
            IAnonymousCommentPolicyService policyService,
            IConfiguration configuration,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
            await HandleAnonymousCommentCreateAsync(
                httpContext,
                commentService,
                contentFilterService,
                regionResolver,
                regionLegalModerationService,
                riskSignals,
                zkProofService,
                aeds,
                cancellationToken,
                policyService,
                configuration))
        .AllowAnonymous()
        .RequireRateLimiting("public_read")
        .RequireStrongAnonymousRequest();

        group.MapPost("/comment", static async Task<BinaryFrameResult> (
            HttpContext httpContext,
            AccountPrincipalContext account,
            ICommentEndpointService commentService,
            IContentFilterService contentFilterService,
            IClientRegionResolver regionResolver,
            IRegionLegalModerationService regionLegalModerationService,
            ISecurityRiskSignalSink riskSignals,
            IAnonymousCommentPolicyService policyService,
            IConfiguration configuration,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            if (!IsCommentMutationIdempotencyEnabled(configuration))
            {
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.InfraFailure, "comment_mutation_idempotency_disabled"),
                    aeds,
                    ApiErrorSemanticMapper.RequireTransportMappingId(
                        StatusCodes.Status503ServiceUnavailable,
                        ErrorCode.InfraFailure));
            }

            var payload = await ReadBinaryRequestPayloadAsync(
                httpContext,
                aeds,
                [AedsFrameType.CommentCreateRequest],
                cancellationToken,
                CommentLimits.CreatePayloadMaxBytes);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }

            if (!PodBinaryCodec.TryDecodeCommentCreateRequest(payload.Payload, out CommentCreateRequestCoreModel request))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "评论请求体非法"), aeds);
            }

            string rawClientMutationId = httpContext.Request.Headers["X-Fsus-Client-Mutation-Id"].ToString().Trim();
            if (string.IsNullOrEmpty(rawClientMutationId))
            {
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.Validation, "comment_client_mutation_id_required"),
                    aeds, ApiErrorSemanticMapper.RequireTransportMappingId(StatusCodes.Status400BadRequest, ErrorCode.Validation));
            }

            if (!TryResolveCommentClientMutationId(rawClientMutationId, out string clientMutationId))
            {
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.Validation, "comment_client_mutation_id_invalid"),
                    aeds, ApiErrorSemanticMapper.RequireTransportMappingId(StatusCodes.Status400BadRequest, ErrorCode.Validation));
            }

            CommentAuthorModeDecision authorMode = await policyService.EvaluateAuthorModeAsync(
                request.AuthorMode,
                request.PublicSendExplicitlySelected,
                cancellationToken);
            if (!authorMode.Allowed)
            {
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.Validation, authorMode.Status),
                    aeds, ApiErrorSemanticMapper.RequireTransportMappingId(StatusCodes.Status400BadRequest, ErrorCode.Validation));
            }

            if (!string.Equals(authorMode.EffectiveAuthorMode, CommentAuthorModes.Public, StringComparison.Ordinal))
            {
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.Validation, "anonymous_ticket_required"),
                    aeds, ApiErrorSemanticMapper.RequireTransportMappingId(StatusCodes.Status400BadRequest, ErrorCode.Validation));
            }

            string content = request.Content?.Trim() ?? string.Empty;
            AnonymousCommentPolicySnapshot policy = await policyService.GetCurrentAsync(cancellationToken);
            if (!IsCommentContentWithinLimit(content, policy))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, BuildCommentLengthError(policy)), aeds);
            }

            CommentMarkdownPolicyResult markdownReview = CommentMarkdownPolicy.ValidateForSubmit(content);
            if (!markdownReview.IsValid)
            {
                await RecordCommentRiskSignalAsync(
                    httpContext,
                    riskSignals,
                    SecurityRiskReason.CommentSpamPattern,
                    markdownReview.ReasonCode,
                    score: 7,
                    cancellationToken);
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, markdownReview.PublicMessage), aeds);
            }

            ContentValidationResult validation = contentFilterService.ValidateContent(markdownReview.ReviewText);
            if (!validation.IsValid)
            {
                await RecordCommentRiskSignalAsync(
                    httpContext,
                    riskSignals,
                    SecurityRiskReason.CommentSpamPattern,
                    "content_filter",
                    score: 10,
                    cancellationToken);
            }

            ClientRegionResolution submitRegion = regionResolver.Resolve(httpContext);
            RegionModerationDecision regionDecision = regionLegalModerationService.EvaluateOnSubmit(new RegionModerationRequest(
                markdownReview.ReviewText,
                request.ArticleId,
                account.AccountId,
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

            request = request with
            {
                Content = content
            };
            CommentCreateResult result = await commentService.CreateAttributablePublicCommentResultAsync(
                account,
                request,
                clientMutationId,
                regionDecision);

            return result.Created
                ? WriteCommentCreateResult(aeds, result)
                : WriteCommentCreateFailure(aeds, result, "发布失败：可能文章已关闭评论或数据异常");
        })
        .RequireAnonymousAccountPrincipal()
        .RequireAuthorization()
        .RequireRateLimiting("fixed_ip")
        .WithRiskAction(RiskActionNames.CommentCreate)
        .AddEndpointFilterWithMetadata<CommentRiskActionFilter>()
        .AddEndpointFilterWithMetadata<RequiresRiskControlFilter>()
        .AddEndpointFilterWithMetadata<RequiresPowFilter>();

        group.MapGet("/comment/{articleId:int}", static async Task<IResult> (
            int articleId,
            HttpContext httpContext,
            ICommentQueryService commentService,
            IClientRegionResolver regionResolver,
            ICommentCursorPolicyResolver cursorPolicies,
            IConfiguration configuration,
            ICacheStringReader cache,
            IOwnedFrameCache ownedFrameCache,
            IAedsEncoder aeds) =>
        {
            if (!configuration.GetValue("CommentThreads:RecursiveReadsEnabled", true))
            {
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.InfraFailure, "comment_recursive_reads_disabled"),
                    aeds, ApiErrorSemanticMapper.RequireTransportMappingId(StatusCodes.Status503ServiceUnavailable, ErrorCode.InfraFailure));
            }
            CursorBindResult<long> bind = CursorPageBinder.Bind(
                httpContext.Request,
                cursorPolicies.Resolve(CommentCursorPolicyKind.Threads, ResolveCommentCursorTenant(httpContext)),
                Int64CursorCodec.Instance);
            if (!bind.IsSuccess)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, bind.ErrorMessage ?? "游标参数非法"), aeds);
            }

            string viewerRegion = regionResolver.Resolve(httpContext).Region;
            string version = await ReadCommentCursorVersionAsync(cache, articleId, rootId: null, accountId: null, httpContext.RequestAborted);
            string identity = BuildCommentThreadFrameIdentity(articleId, bind.Request, previewLimit: 3, viewerRegion, version);
            OwnedFrameCacheReadResult frame = await ownedFrameCache.TryGetOwnedFrameAsync(
                CachePolicyId.CommentCursorFrame,
                identity,
                AedsFrameType.CommentTreeRootCursor,
                httpContext.RequestAborted);
            RecordCommentFrameCacheResult("roots", viewerRegion, frame.Hit && frame.Lease is not null);
            if (frame.Hit && frame.Lease is not null)
            {
                return BinaryResults.PreencodedFrame(frame.Lease);
            }

            var result = await commentService.GetTreeRootsAsync(articleId, bind.Request, viewerRegion: viewerRegion);
            OwnedAedsFrame ownedFrame = BuildCachedFrame(AedsFrameType.CommentTreeRootCursor, writer => PodBinaryCodec.WriteCommentTreeRootCursor(result, writer));
            return await StoreAndReturnOwnedFrameAsync(
                ownedFrameCache,
                CachePolicyId.CommentCursorFrame,
                identity,
                ownedFrame,
                TimeSpan.FromMinutes(5),
                httpContext.RequestAborted);
        })
        .AllowAnonymous()
        .RequireRateLimiting("public_read")
        .WithRiskAction(RiskActionNames.PublicRead, "comment.threads")
        .AddEndpointFilterWithMetadata<RiskAwarePublicReadFilter>();

        group.MapGet("/comment/{articleId:int}/children/{parentId:long}", static async Task<IResult> (
            int articleId,
            long parentId,
            HttpContext httpContext,
            ICommentQueryService commentService,
            IClientRegionResolver regionResolver,
            ICommentCursorPolicyResolver cursorPolicies,
            IConfiguration configuration,
            ICacheStringReader cache,
            IOwnedFrameCache ownedFrameCache,
            IAedsEncoder aeds) =>
        {
            if (!configuration.GetValue("CommentThreads:RecursiveReadsEnabled", true))
            {
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.InfraFailure, "comment_recursive_reads_disabled"),
                    aeds, ApiErrorSemanticMapper.RequireTransportMappingId(StatusCodes.Status503ServiceUnavailable, ErrorCode.InfraFailure));
            }
            CursorBindResult<long> bind = CursorPageBinder.Bind(
                httpContext.Request,
                cursorPolicies.Resolve(CommentCursorPolicyKind.Replies, ResolveCommentCursorTenant(httpContext)),
                Int64CursorCodec.Instance);
            if (!bind.IsSuccess)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, bind.ErrorMessage ?? "游标参数非法"), aeds);
            }

            string viewerRegion = regionResolver.Resolve(httpContext).Region;
            string version = await ReadCommentCursorVersionAsync(cache, articleId, parentId, accountId: null, httpContext.RequestAborted);
            string identity = BuildCommentChildFrameIdentity(articleId, parentId, bind.Request, viewerRegion, version);
            OwnedFrameCacheReadResult frame = await ownedFrameCache.TryGetOwnedFrameAsync(
                CachePolicyId.CommentCursorFrame,
                identity,
                AedsFrameType.CommentChildCursor,
                httpContext.RequestAborted);
            RecordCommentFrameCacheResult("children", viewerRegion, frame.Hit && frame.Lease is not null);
            if (frame.Hit && frame.Lease is not null)
            {
                return BinaryResults.PreencodedFrame(frame.Lease);
            }

            CommentChildCursorDto result = await commentService.GetChildrenAsync(articleId, parentId, bind.Request, viewerRegion);
            OwnedAedsFrame ownedFrame = BuildCachedFrame(
                AedsFrameType.CommentChildCursor,
                writer => PodBinaryCodec.WriteCommentChildCursor(
                    long.Parse(result.ParentId),
                    long.Parse(result.RootId),
                    result.Cursor,
                    writer));
            return await StoreAndReturnOwnedFrameAsync(
                ownedFrameCache,
                CachePolicyId.CommentCursorFrame,
                identity,
                ownedFrame,
                TimeSpan.FromMinutes(5),
                httpContext.RequestAborted);
        })
        .AllowAnonymous()
        .RequireRateLimiting("public_read")
        .WithRiskAction(RiskActionNames.PublicRead, "comment.children")
        .AddEndpointFilterWithMetadata<RiskAwarePublicReadFilter>();

        group.MapGet("/comment/{articleId:int}/context/{commentId:long}", static async Task<IResult> (
            int articleId,
            long commentId,
            int? window,
            HttpContext httpContext,
            ICommentQueryService commentService,
            IClientRegionResolver regionResolver,
            IConfiguration configuration,
            ICacheStringReader cache,
            IOwnedFrameCache ownedFrameCache,
            IAedsEncoder aeds) =>
        {
            if (!configuration.GetValue("CommentThreads:RecursiveReadsEnabled", true))
            {
                return BinaryResults.FromError(
                    ErrorDetail.Create(ErrorCode.InfraFailure, "comment_recursive_reads_disabled"),
                    aeds, ApiErrorSemanticMapper.RequireTransportMappingId(StatusCodes.Status503ServiceUnavailable, ErrorCode.InfraFailure));
            }
            int siblingWindow = Math.Clamp(window ?? 6, 2, 20);
            string viewerRegion = regionResolver.Resolve(httpContext).Region;
            string version = await ReadCommentCursorVersionAsync(cache, articleId, commentId, accountId: null, httpContext.RequestAborted);
            string identity = BuildCommentPermalinkFrameIdentity(articleId, commentId, siblingWindow, viewerRegion, version);
            OwnedFrameCacheReadResult frame = await ownedFrameCache.TryGetOwnedFrameAsync(
                CachePolicyId.CommentCursorFrame,
                identity,
                AedsFrameType.CommentPermalinkContext,
                httpContext.RequestAborted);
            RecordCommentFrameCacheResult("permalink", viewerRegion, frame.Hit && frame.Lease is not null);
            if (frame.Hit && frame.Lease is not null)
            {
                return BinaryResults.PreencodedFrame(frame.Lease);
            }

            CommentPermalinkContextDto result = await commentService.GetPermalinkContextAsync(
                articleId,
                commentId,
                siblingWindow,
                viewerRegion);
            OwnedAedsFrame ownedFrame = BuildCachedFrame(
                AedsFrameType.CommentPermalinkContext,
                writer => PodBinaryCodec.WriteCommentPermalinkContext(result, writer));
            return await StoreAndReturnOwnedFrameAsync(
                ownedFrameCache,
                CachePolicyId.CommentCursorFrame,
                identity,
                ownedFrame,
                TimeSpan.FromMinutes(5),
                httpContext.RequestAborted);
        })
        .AllowAnonymous()
        .RequireRateLimiting("public_read")
        .WithRiskAction(RiskActionNames.PublicRead, "comment.permalink")
        .AddEndpointFilterWithMetadata<RiskAwarePublicReadFilter>();

        group.MapGet("/comment/{articleId:int}/thread/{rootId:long}", static async Task<IResult> (
            int articleId,
            long rootId,
            HttpContext httpContext,
            ICommentQueryService commentService,
            IClientRegionResolver regionResolver,
            ICommentCursorPolicyResolver cursorPolicies,
            ICacheStringReader cache,
            IOwnedFrameCache ownedFrameCache,
            IAedsEncoder aeds) =>
        {
            CursorBindResult<long> bind = CursorPageBinder.Bind(
                httpContext.Request,
                cursorPolicies.Resolve(CommentCursorPolicyKind.Replies, ResolveCommentCursorTenant(httpContext)),
                Int64CursorCodec.Instance);
            if (!bind.IsSuccess)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, bind.ErrorMessage ?? "游标参数非法"), aeds);
            }

            string viewerRegion = regionResolver.Resolve(httpContext).Region;
            string version = await ReadCommentCursorVersionAsync(cache, articleId, rootId, accountId: null, httpContext.RequestAborted);
            string identity = BuildCommentReplyFrameIdentity(articleId, rootId, bind.Request, viewerRegion, version);
            OwnedFrameCacheReadResult frame = await ownedFrameCache.TryGetOwnedFrameAsync(
                CachePolicyId.CommentCursorFrame,
                identity,
                AedsFrameType.CommentThreadReplyCursor,
                httpContext.RequestAborted);
            RecordCommentFrameCacheResult("replies", viewerRegion, frame.Hit && frame.Lease is not null);
            if (frame.Hit && frame.Lease is not null)
            {
                return BinaryResults.PreencodedFrame(frame.Lease);
            }

            var result = await commentService.GetRepliesAsync(articleId, rootId, bind.Request, viewerRegion);
            OwnedAedsFrame ownedFrame = BuildCachedFrame(AedsFrameType.CommentThreadReplyCursor, writer => PodBinaryCodec.WriteCommentReplyCursor(rootId, result, writer));
            return await StoreAndReturnOwnedFrameAsync(
                ownedFrameCache,
                CachePolicyId.CommentCursorFrame,
                identity,
                ownedFrame,
                TimeSpan.FromMinutes(5),
                httpContext.RequestAborted);
        })
        .AllowAnonymous()
        .RequireRateLimiting("public_read")
        .WithRiskAction(RiskActionNames.PublicRead, "comment.replies")
        .AddEndpointFilterWithMetadata<RiskAwarePublicReadFilter>();

        group.MapGet("/comment/me", static async Task<IResult> (
            HttpContext httpContext,
            int? articleId,
            AccountPrincipalContext account,
            ICommentCoreService core,
            ICommentCursorPolicyResolver cursorPolicies,
            ICacheStringReader cache,
            IOwnedFrameCache ownedFrameCache,
            IAedsEncoder aeds) =>
        {
            if (articleId is <= 0)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "articleId 参数非法"), aeds);
            }

            CursorBindResult<long> bind = CursorPageBinder.Bind(
                httpContext.Request,
                cursorPolicies.Resolve(CommentCursorPolicyKind.UserComments, ResolveCommentCursorTenant(httpContext)),
                Int64CursorCodec.Instance);
            if (!bind.IsSuccess)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, bind.ErrorMessage ?? "游标参数非法"), aeds);
            }

            string version = await ReadCommentCursorVersionAsync(cache, articleId: null, rootId: null, accountId: account.AccountId, httpContext.RequestAborted);
            string identity = BuildUserCommentFrameIdentity(account.AccountId, articleId, bind.Request, version);
            OwnedFrameCacheReadResult frame = await ownedFrameCache.TryGetOwnedFrameAsync(
                CachePolicyId.UserCommentCursorFrame,
                identity,
                AedsFrameType.CommentUserCursor,
                httpContext.RequestAborted);
            if (frame.Hit && frame.Lease is not null)
            {
                return BinaryResults.PreencodedFrame(frame.Lease);
            }

            var result = articleId.HasValue
                ? await core.GetUserCommentsForArticleAsync(account.AccountId, articleId.Value, bind.Request.Cursor, bind.Request.Limit)
                : await core.GetUserCommentsAsync(account.AccountId, bind.Request.Cursor, bind.Request.Limit);
            if (!result.IsSuccess)
            {
                return BinaryResults.FromError(result.Error, aeds);
            }

            OwnedAedsFrame ownedFrame = BuildCachedFrame(AedsFrameType.CommentUserCursor, writer => PodBinaryCodec.WriteUserCommentCursor(result.Value, writer));
            return await StoreAndReturnOwnedFrameAsync(
                ownedFrameCache,
                CachePolicyId.UserCommentCursorFrame,
                identity,
                ownedFrame,
                TimeSpan.FromMinutes(5),
                httpContext.RequestAborted);
        }).RequireAnonymousAccountPrincipal();

        group.MapDelete("/comment/{id:long}", static async Task<BinaryFrameResult> (
            long id,
            string? reason,
            HttpContext httpContext,
            ICommentEndpointService commentService,
            IAdminPrincipalService adminPrincipals,
            IAedsEncoder aeds) =>
        {
            EndpointUserContext user = EndpointUserContext.From(httpContext);
            string normalizedReason = reason ?? "不符合社区规范";
            bool success;
            if (user.IsAnonymousAccount && user.AccountId > 0)
            {
                success = await commentService.DeleteCommentAsAccountAsync(id, user.AccountId, normalizedReason);
            }
            else if (httpContext.User.IsAdminPrincipal()
                && TryResolveAdminSessionContext(httpContext, out long adminPrincipalId, out string adminSessionId)
                && httpContext.User.HasAdminPermission(AdminPermissions.CommentModerate))
            {
                var stepUp = await RequireAdminSensitiveStepUpAsync(httpContext, adminPrincipals);
                if (stepUp is not null)
                {
                    return BinaryResults.FromError(stepUp.Value.Error, aeds, ApiErrorSemanticMapper.RequireTransportMappingId(stepUp.Value.StatusCode, (stepUp.Value.Error).Code));
                }

                success = await commentService.DeleteCommentAsAdminAsync(id, new AdminPrincipalActor(adminPrincipalId, adminSessionId), normalizedReason);
            }
            else
            {
                success = false;
            }

            return success
                ? BinaryResults.Frame(aeds, AedsFrameType.EmptySuccess, PodBinaryCodec.WriteEmptySuccess)
                : BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Forbidden, "未找到该评论或无权删除"), aeds);
        })
        .RequireAuthorization()
        .WithAdminSensitiveStepUp(adminPrincipalBranchOnly: true)
        .AddEndpointFilterWithMetadata<RequiresPowFilter>();

        group.MapPost("/comment/{id:long}/author/challenge", static async Task<IResult> (
            long id,
            HttpContext context,
            AccountPrincipalContext account,
            ICommentAuthorManagementService management,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadCommentManagementRequestAsync<CommentManagementChallengeRequest>(
                context,
                aeds,
                AedsFrameType.CommentManagementChallengeRequest,
                "comment_management_challenge_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            CommentManagementChallengeResult result = await management.IssueAccountChallengeAsync(
                id,
                account.AccountId,
                parsed.Value!.Purpose,
                cancellationToken);
            return WriteCommentChallengeResult(aeds, result);
        })
        .RequireAnonymousAccountPrincipal()
        .RequireAuthorization()
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/comment/{id:long}/author/edit", static async Task<IResult> (
            long id,
            HttpContext context,
            AccountPrincipalContext account,
            ICommentAuthorManagementService management,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadCommentManagementRequestAsync<CommentEditRequest>(
                context,
                aeds,
                AedsFrameType.CommentAuthorEditRequest,
                "comment_author_edit_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            CommentAuthorMutationResult result = await management.EditAsAccountAsync(
                id,
                account.AccountId,
                parsed.Value!,
                cancellationToken);
            return WriteCommentMutationResult(aeds, result);
        })
        .RequireAnonymousAccountPrincipal()
        .RequireAuthorization()
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/comment/{id:long}/author/delete", static async Task<IResult> (
            long id,
            HttpContext context,
            AccountPrincipalContext account,
            ICommentAuthorManagementService management,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadCommentManagementRequestAsync<AnonymousCommentActionRequest>(
                context,
                aeds,
                AedsFrameType.CommentAuthorStatusRequest,
                "comment_author_delete_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            CommentAuthorMutationResult result = await management.DeleteAsAccountAsync(
                id,
                account.AccountId,
                parsed.Value!.Challenge,
                cancellationToken);
            return WriteCommentMutationResult(aeds, result);
        })
        .RequireAnonymousAccountPrincipal()
        .RequireAuthorization()
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/comment/{id:long}/author/appeal", static async Task<IResult> (
            long id,
            HttpContext context,
            AccountPrincipalContext account,
            ICommentAuthorManagementService management,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadCommentManagementRequestAsync<CommentAppealRequest>(
                context,
                aeds,
                AedsFrameType.CommentAuthorAppealRequest,
                "comment_author_appeal_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            return WriteCommentMutationResult(aeds, await management.AppealAsAccountAsync(
                id, account.AccountId, parsed.Value!, cancellationToken));
        })
        .RequireAnonymousAccountPrincipal()
        .RequireAuthorization()
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/comment/{id:long}/report", static async Task<IResult> (
            long id,
            HttpContext context,
            AccountPrincipalContext account,
            ICommentGovernanceService governance,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadCommentManagementRequestAsync<CommentReportRequest>(
                context, aeds, AedsFrameType.CommentReportRequest, "comment_report_request_invalid", cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }
            CommentReportResult result = await governance.ReportAsAccountAsync(id, account.AccountId, parsed.Value!, cancellationToken);
            return result.Success
                ? AedsJsonResults.Ok(aeds, AedsFrameType.CommentReportResult, result)
                : AedsJsonResults.BadRequest(aeds, result.Code);
        })
        .RequireAnonymousAccountPrincipal()
        .RequireAuthorization()
        .RequireRateLimiting("fixed_ip");

        group.MapPost("/comment/{id:long}/anonymous-report", static async Task<IResult> (
            long id,
            HttpContext context,
            ICommentGovernanceService governance,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadCommentManagementRequestAsync<CommentReportRequest>(
                context, aeds, AedsFrameType.CommentReportRequest, "comment_report_request_invalid", cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }
            CommentReportResult result = await governance.ReportAsScopedAnonymousAsync(id, parsed.Value!, cancellationToken);
            return result.Success
                ? AedsJsonResults.Ok(aeds, AedsFrameType.CommentReportResult, result)
                : AedsJsonResults.BadRequest(aeds, result.Code);
        })
        .AllowAnonymous()
        .RequireRateLimiting("fixed_ip")
        .RequireStrongAnonymousRequest();

        group.MapPost("/comment/{id:long}/management/challenge", static async Task<IResult> (
            long id,
            HttpContext context,
            ICommentManagementCapabilityService capabilities,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadCommentManagementRequestAsync<CommentManagementChallengeRequest>(
                context,
                aeds,
                AedsFrameType.CommentManagementChallengeRequest,
                "comment_management_challenge_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess || string.IsNullOrWhiteSpace(parsed.Value!.CapabilitySecret))
            {
                return parsed.IsSuccess
                    ? AedsJsonResults.NotFound(aeds, "comment_management_not_found")
                    : parsed.ToErrorResult(aeds);
            }

            CommentManagementChallengeResult result = await capabilities.IssueChallengeAsync(
                id,
                parsed.Value.CapabilitySecret,
                parsed.Value.Purpose,
                cancellationToken);
            return WriteCommentChallengeResult(aeds, result);
        })
        .AllowAnonymous()
        .RequireRateLimiting("fixed_ip")
        .RequireStrongAnonymousRequest();

        group.MapPost("/comment/{id:long}/management/edit", static async Task<IResult> (
            long id,
            HttpContext context,
            ICommentAuthorManagementService management,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadCommentManagementRequestAsync<AnonymousCommentEditRequest>(
                context,
                aeds,
                AedsFrameType.CommentAuthorEditRequest,
                "comment_management_edit_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            AnonymousCommentEditRequest request = parsed.Value!;
            CommentAuthorMutationResult result = await management.EditAsAnonymousAsync(
                id,
                request.CapabilitySecret,
                new CommentEditRequest(request.ExpectedVersion, request.Content, request.Challenge),
                cancellationToken);
            return WriteCommentMutationResult(aeds, result);
        })
        .AllowAnonymous()
        .RequireRateLimiting("fixed_ip")
        .RequireStrongAnonymousRequest();

        group.MapPost("/comment/{id:long}/management/delete", static async Task<IResult> (
            long id,
            HttpContext context,
            ICommentAuthorManagementService management,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadCommentManagementRequestAsync<AnonymousCommentActionRequest>(
                context,
                aeds,
                AedsFrameType.CommentAuthorStatusRequest,
                "comment_management_delete_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            CommentAuthorMutationResult result = await management.DeleteAsAnonymousAsync(
                id,
                parsed.Value!.CapabilitySecret,
                parsed.Value.Challenge,
                cancellationToken);
            return WriteCommentMutationResult(aeds, result);
        })
        .AllowAnonymous()
        .RequireRateLimiting("fixed_ip")
        .RequireStrongAnonymousRequest();

        group.MapPost("/comment/{id:long}/management/status", static async Task<IResult> (
            long id,
            HttpContext context,
            ICommentAuthorManagementService management,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadCommentManagementRequestAsync<AnonymousCommentActionRequest>(
                context,
                aeds,
                AedsFrameType.CommentAuthorStatusRequest,
                "comment_management_status_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            CommentAuthorStatusResult result = await management.ReadAnonymousStatusAsync(
                id,
                parsed.Value!.CapabilitySecret,
                parsed.Value.Challenge,
                cancellationToken);
            return result.Found
                ? AedsJsonResults.Ok(aeds, AedsFrameType.CommentAuthorStatusResult, result)
                : AedsJsonResults.NotFound(aeds, "comment_management_not_found");
        })
        .AllowAnonymous()
        .RequireRateLimiting("fixed_ip")
        .RequireStrongAnonymousRequest();

        group.MapPost("/comment/{id:long}/management/appeal", static async Task<IResult> (
            long id,
            HttpContext context,
            ICommentAuthorManagementService management,
            IAedsEncoder aeds,
            CancellationToken cancellationToken) =>
        {
            var parsed = await ReadCommentManagementRequestAsync<AnonymousCommentAppealRequest>(
                context,
                aeds,
                AedsFrameType.CommentAuthorAppealRequest,
                "comment_management_appeal_request_invalid",
                cancellationToken);
            if (!parsed.IsSuccess)
            {
                return parsed.ToErrorResult(aeds);
            }

            AnonymousCommentAppealRequest request = parsed.Value!;
            CommentAuthorMutationResult result = await management.AppealAsAnonymousAsync(
                id,
                request.CapabilitySecret,
                new CommentAppealRequest(request.Reason, request.Challenge),
                cancellationToken);
            return WriteCommentMutationResult(aeds, result);
        })
        .AllowAnonymous()
        .RequireRateLimiting("fixed_ip")
        .RequireStrongAnonymousRequest();
    }

    internal static async Task<BinaryFrameResult> HandleAnonymousCommentTicketAsync(
        HttpContext httpContext,
        IAedsEncoder aeds,
        IAnonymousCommentTicketService ticketService,
        IZkAnonymousProofService zkProofService,
        CancellationToken cancellationToken)
    {
        if (!IsZkProdTicketReady(zkProofService.CurrentZkCommentPolicy))
        {
            return BinaryResults.FromError(
                ErrorDetail.Create(ErrorCode.InfraFailure, "anonymous_comment_ticket_unavailable"),
                aeds, ApiErrorSemanticMapper.RequireTransportMappingId(StatusCodes.Status503ServiceUnavailable, ErrorCode.InfraFailure));
        }

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

    private static bool IsZkProdTicketReady(ZkCommentPolicySnapshot policy)
        => policy.Enabled &&
            policy.NativeVerifierConfigured &&
            policy.TrustedSetupVerified &&
            policy.CredentialRequired &&
            policy.CredentialRootReady &&
            string.IsNullOrWhiteSpace(policy.UnavailableReason);

    internal static async Task<BinaryFrameResult> HandleAnonymousCommentCreateAsync(
        HttpContext httpContext,
        ICommentEndpointService commentService,
        IContentFilterService contentFilterService,
        IClientRegionResolver regionResolver,
        IRegionLegalModerationService regionLegalModerationService,
        ISecurityRiskSignalSink riskSignals,
        IZkAnonymousProofService zkProofService,
        IAedsEncoder aeds,
        CancellationToken cancellationToken,
        IAnonymousCommentPolicyService? policyService = null,
        IConfiguration? configuration = null)
    {
        if (!(configuration?.GetValue<bool?>("Comments:MutationIdempotencyEnabled") ?? true))
        {
            return BinaryResults.FromError(
                ErrorDetail.Create(ErrorCode.InfraFailure, "comment_mutation_idempotency_disabled"),
                aeds, ApiErrorSemanticMapper.RequireTransportMappingId(StatusCodes.Status503ServiceUnavailable, ErrorCode.InfraFailure));
        }

        if (!IsZkProdTicketReady(zkProofService.CurrentZkCommentPolicy))
        {
            return BinaryResults.FromError(
                ErrorDetail.Create(ErrorCode.InfraFailure, "anonymous_comment_submit_unavailable"),
                aeds, ApiErrorSemanticMapper.RequireTransportMappingId(StatusCodes.Status503ServiceUnavailable, ErrorCode.InfraFailure));
        }

        var payload = await ReadBinaryRequestPayloadAsync(
            httpContext,
            aeds,
            AedsFrameType.AnonymousCommentCreateRequest,
            cancellationToken,
            CommentLimits.CreatePayloadMaxBytes);
        if (!payload.IsSuccess)
        {
            return BinaryResults.FromError(payload.Error, aeds);
        }

        if (!PodBinaryCodec.TryDecodeAnonymousCommentCreateRequest(payload.Payload, out AnonymousCommentCreateRequestCoreModel request))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "anonymous_comment_create_request_invalid"), aeds);
        }

        string content = request.Content?.Trim() ?? string.Empty;
        AnonymousCommentPolicySnapshot policy = policyService is null
            ? AnonymousCommentPolicySnapshot.Default
            : await policyService.GetCurrentAsync(cancellationToken);
        if (!IsCommentContentWithinLimit(content, policy))
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, BuildCommentLengthError(policy)), aeds);
        }

        CommentMarkdownPolicyResult markdownReview = CommentMarkdownPolicy.ValidateForSubmit(content);
        if (!markdownReview.IsValid)
        {
            await RecordCommentRiskSignalAsync(
                httpContext,
                riskSignals,
                SecurityRiskReason.CommentSpamPattern,
                markdownReview.ReasonCode,
                score: 7,
                cancellationToken);
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, markdownReview.PublicMessage), aeds);
        }

        ContentValidationResult validation = contentFilterService.ValidateContent(markdownReview.ReviewText);
        if (!validation.IsValid)
        {
            await RecordCommentRiskSignalAsync(
                httpContext,
                riskSignals,
                SecurityRiskReason.CommentSpamPattern,
                "anonymous_content_filter",
                score: 10,
                cancellationToken);
        }

        ClientRegionResolution submitRegion = regionResolver.Resolve(httpContext);
        RegionModerationDecision regionDecision = regionLegalModerationService.EvaluateOnSubmit(new RegionModerationRequest(
            markdownReview.ReviewText,
            request.ArticleId,
            0,
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
        CommentCreateResult result = await commentService.CreateStrongAnonymousCommentResultAsync(
            request with
            {
                Content = content
            },
            regionDecision,
            cancellationToken);

        return result.Created
            ? WriteAnonymousCommentCreateResult(aeds, result)
            : WriteCommentCreateFailure(aeds, result, "anonymous_comment_submit_failed");
    }

    private static BinaryFrameResult WriteAnonymousCommentCreateResult(IAedsEncoder aeds, CommentCreateResult result)
    {
        byte[] payload = JsonSerializer.SerializeToUtf8Bytes(new AnonymousCommentCreateResponse(
            result.CommentId,
            result.RootId,
            result.ParentId,
            result.CreatedAtUtc,
            (int)result.ModerationStatus,
            result.VisibilityState,
            result.IsPubliclyVisible,
            result.IdempotencyReplay,
            result.ManagementSecret ?? string.Empty), s_commentJsonOptions);
        return BinaryResults.Frame(
            aeds,
            AedsFrameType.AnonymousCommentCreateResult,
            writer => writer.Write(payload));
    }

    private static async Task<AedsJsonRequest<T>> ReadCommentManagementRequestAsync<T>(
        HttpContext context,
        IAedsEncoder aeds,
        AedsFrameType frameType,
        string invalidMessage,
        CancellationToken cancellationToken)
    {
        context.Response.Headers.CacheControl = "no-store";
        return await AedsJsonResults.ReadAsync<T>(
            context,
            aeds,
            frameType,
            64 * 1024,
            invalidMessage,
            cancellationToken);
    }

    private static IResult WriteCommentChallengeResult(
        IAedsEncoder aeds,
        CommentManagementChallengeResult result)
        => result.Issued
            ? AedsJsonResults.Ok(aeds, AedsFrameType.CommentManagementChallengeResponse, result)
            : AedsJsonResults.NotFound(aeds, result.FailureCode ?? "comment_management_not_found");

    private static IResult WriteCommentMutationResult(
        IAedsEncoder aeds,
        CommentAuthorMutationResult result)
    {
        if (result.Success)
        {
            return AedsJsonResults.Ok(aeds, AedsFrameType.CommentAuthorMutationResult, result);
        }

        return result.Code == "comment_version_conflict"
            ? AedsJsonResults.Error(aeds, ApiErrorTransportMappingId.Default409Conflict, result.Code)
            : AedsJsonResults.NotFound(aeds, result.Code);
    }

    private static BinaryFrameResult WriteCommentCreateFailure(
        IAedsEncoder aeds,
        CommentCreateResult result,
        string fallbackMessage)
        => BinaryResults.FromError(
            ErrorDetail.Create(
                string.Equals(result.FailureCode, "comment_child_limit", StringComparison.Ordinal)
                    || string.Equals(result.FailureCode, "comment_mutation_content_conflict", StringComparison.Ordinal)
                    || string.Equals(result.FailureCode, "comment_policy_closed", StringComparison.Ordinal)
                    || string.Equals(result.FailureCode, "comment_thread_locked", StringComparison.Ordinal)
                    || string.Equals(result.FailureCode, "comment_slow_mode_active", StringComparison.Ordinal)
                    ? ErrorCode.Conflict
                    : ErrorCode.Validation,
                result.FailureCode ?? fallbackMessage),
            aeds);

    private static BinaryFrameResult WriteCommentCreateResult(IAedsEncoder aeds, CommentCreateResult result)
        => BinaryResults.Frame(
            aeds,
            AedsFrameType.CommentCreateResult,
            writer => PodBinaryCodec.WriteCommentCreateResult(
                result.CommentId,
                (int)result.ModerationStatus,
                result.VisibilityState switch
                {
                    "public" => (byte)1,
                    "hidden" => (byte)2,
                    "rejected" => (byte)3,
                    _ => (byte)0
                },
                result.IsPubliclyVisible,
                result.RootId,
                result.ParentId,
                result.CreatedAtUtc,
                result.IdempotencyReplay,
                writer));

    private static bool TryResolveCommentClientMutationId(string candidate, out string clientMutationId)
    {
        if (Guid.TryParseExact(candidate, "D", out Guid parsed))
        {
            clientMutationId = parsed.ToString("D", System.Globalization.CultureInfo.InvariantCulture);
            return string.Equals(candidate, clientMutationId, StringComparison.Ordinal);
        }

        clientMutationId = string.Empty;
        return false;
    }

    private static bool IsCommentMutationIdempotencyEnabled(IConfiguration configuration)
        => configuration.GetValue<bool?>("Comments:MutationIdempotencyEnabled") ?? true;

    private static bool IsCommentContentWithinLimit(string content, AnonymousCommentPolicySnapshot policy)
        => !string.IsNullOrWhiteSpace(content)
            && content.Length <= policy.CommentMaxChars
            && Encoding.UTF8.GetByteCount(content) <= policy.CommentMaxUtf8Bytes;

    private static string BuildCommentLengthError(AnonymousCommentPolicySnapshot policy)
        => $"评论内容不能超过 {policy.CommentMaxChars} 字或 {policy.CommentMaxUtf8Bytes} 字节";

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

    private static CommentPolicySnapshotCoreModel ToCommentPolicyCore(
        AnonymousCommentPolicySnapshot snapshot,
        ZkCommentPolicySnapshot zkProd)
        => new(
            snapshot.AnonymousCommentsEnabled,
            snapshot.PublicCommentsEnabled,
            snapshot.ZkAnonymousEnabled,
            snapshot.DefaultAuthorMode,
            snapshot.SupportedDisplayLanguages,
            snapshot.SnapshotHash,
            snapshot.CommentMaxChars,
            snapshot.CommentMaxUtf8Bytes,
            zkProd.Enabled,
            zkProd.NativeVerifierConfigured,
            zkProd.TrustedSetupVerified,
            zkProd.CredentialRequired,
            zkProd.CredentialRootReady,
            zkProd.UnavailableReason);

    private static OwnedAedsFrame BuildCachedFrame(
        AedsFrameType frameType,
        Action<IBufferWriter<byte>> writePayload)
        => AedsOwnedFrameBuilder.BuildOwned(frameType, writePayload);

    private static async Task<IResult> StoreAndReturnOwnedFrameAsync(
        IOwnedFrameCache cache,
        CachePolicyId policyId,
        string identity,
        OwnedAedsFrame frame,
        TimeSpan ttl,
        CancellationToken cancellationToken)
    {
        OwnedAedsFrameReadLease responseLease = frame.AcquireReadLease();
        try
        {
            await cache.SetOwnedFrameAsync(policyId, identity, frame, ttl, cancellationToken);
            return BinaryResults.PreencodedFrame(responseLease);
        }
        catch
        {
            responseLease.Dispose();
            throw;
        }
    }

    private static string BuildCommentThreadFrameIdentity(int articleId, CursorPageRequest<long> request, int previewLimit, string viewerRegion, string version)
        => $"article:{articleId}:v:{version}:roots:{request.Cursor?.ToString() ?? "0"}:{request.Limit}:{previewLimit}:region:{NormalizeCommentFrameRegion(viewerRegion)}";

    private static string BuildCommentReplyFrameIdentity(int articleId, long rootId, CursorPageRequest<long> request, string viewerRegion, string version)
        => $"article:{articleId}:root:{rootId}:v:{version}:replies:{request.Cursor?.ToString() ?? "0"}:{request.Limit}:region:{NormalizeCommentFrameRegion(viewerRegion)}";

    private static string BuildCommentChildFrameIdentity(int articleId, long parentId, CursorPageRequest<long> request, string viewerRegion, string version)
        => $"article:{articleId}:parent:{parentId}:v:{version}:children:{request.Cursor?.ToString() ?? "0"}:{request.Limit}:region:{NormalizeCommentFrameRegion(viewerRegion)}";

    private static string BuildCommentPermalinkFrameIdentity(int articleId, long commentId, int siblingWindow, string viewerRegion, string version)
        => $"article:{articleId}:comment:{commentId}:v:{version}:context:{siblingWindow}:region:{NormalizeCommentFrameRegion(viewerRegion)}";

    private static string BuildUserCommentFrameIdentity(int accountId, int? articleId, CursorPageRequest<long> request, string version)
        => $"account:{accountId}:article:{articleId?.ToString() ?? "all"}:v:{version}:comments:{request.Cursor?.ToString() ?? "0"}:{request.Limit}";

    private static async Task<string> ReadCommentCursorVersionAsync(
        ICacheStringReader cache,
        int? articleId,
        long? rootId,
        int? accountId,
        CancellationToken cancellationToken)
    {
        if (accountId is > 0)
        {
            long global = await ReadVersionAsync(cache, CachePolicyId.UserCommentCursorVersion, "global", cancellationToken);
            long account = await ReadVersionAsync(cache, CachePolicyId.UserCommentCursorVersion, $"account:{accountId.Value}", cancellationToken);
            return $"ug{global}:u{account}";
        }

        long commentGlobal = await ReadVersionAsync(cache, CachePolicyId.CommentCursorVersion, "global", cancellationToken);
        if (articleId is not > 0)
        {
            return $"cg{commentGlobal}";
        }

        long article = await ReadVersionAsync(cache, CachePolicyId.CommentCursorVersion, $"article:{articleId.Value}", cancellationToken);
        if (rootId is > 0)
        {
            long root = await ReadVersionAsync(cache, CachePolicyId.CommentCursorVersion, $"article:{articleId.Value}:root:{rootId.Value}", cancellationToken);
            return $"cg{commentGlobal}:a{article}:r{root}";
        }

        return $"cg{commentGlobal}:a{article}";
    }

    private static async Task<long> ReadVersionAsync(
        ICacheStringReader cache,
        CachePolicyId policyId,
        string identity,
        CancellationToken cancellationToken)
    {
        string? value = await cache.GetStringAsync(policyId, identity, cancellationToken);
        return long.TryParse(value, System.Globalization.NumberStyles.Integer, System.Globalization.CultureInfo.InvariantCulture, out long version)
            ? version
            : 0;
    }

    private static void RecordCommentFrameCacheResult(string frameKind, string viewerRegion, bool hit)
        => FsusObservability.RecordCacheOperation(
            "read",
            "comment-cursor-frame",
            $"comment:{frameKind}:region:{NormalizeCommentFrameRegion(viewerRegion)}",
            hit ? "hit" : "miss",
            TimeSpan.Zero);

    private static string? ResolveCommentCursorTenant(HttpContext httpContext)
        => httpContext.Request.Headers.TryGetValue("X-Fsus-Tenant", out var tenantValues)
            ? tenantValues.FirstOrDefault()
            : null;

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
