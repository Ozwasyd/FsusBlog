using FsusBlog.Contracts.Articles;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.AuthoringCanvas;

namespace FsusBlog.Server.Modules.Endpoints;

public static partial class AuthoringEndpoints
{
    private static void MapArticleCanvasLinkRoutes(IEndpointRouteBuilder group)
    {
        group.MapPost("/articles/{articleId:int}/canvas-links", static async Task<BinaryFrameResult> (
            int articleId, HttpContext context, IAedsEncoder aeds, IArticleCanvasLinkWriter writer,
            IBinaryEndpointRequestContext requests, CancellationToken cancellationToken) =>
        {
            using BinaryRequestPayload payload = await requests.ReadFrameAsync(context, aeds,
                AedsFrameType.ArticleCanvasLinkRequest, cancellationToken, ArticleCanvasLinkContract.MaxPayloadBytes + AedsFrameHeader.Size);
            if (!payload.IsSuccess)
                return BinaryResults.FromError(payload.Error, aeds);
            if (!PodBinaryCodec.TryDecodeArticleCanvasLinkRequest(payload.Payload, out ArticleCanvasLinkRequest request)
                || request.SourceArticleId != articleId)
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "article_canvas_link_request_invalid"), aeds);
            try
            {
                var owner = new AuthoringCanvasOwner(ResolveRequiredAdminPrincipalId(context), "primary-site");
                ArticleCanvasLinkReceipt receipt = await writer.ConvertAsync(owner, request, cancellationToken);
                return BinaryResults.Frame(aeds, AedsFrameType.ArticleCanvasLinkReceipt,
                    destination => PodBinaryCodec.WriteArticleCanvasLinkReceipt(receipt, destination));
            }
            catch (ArticleRevisionConflictException)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Conflict, "article_canvas_link_revision_conflict"), aeds);
            }
            catch (ArticleCanvasLinkOutcomeUnknownException)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.InfraFailure, "article_canvas_link_outcome_unknown"), aeds);
            }
            catch (AuthoringCanvasIdempotencyConflictException)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Conflict, "article_canvas_link_idempotency_conflict"), aeds);
            }
            catch (AuthoringCanvasAccessDeniedException)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "article_canvas_link_unavailable"), aeds);
            }
            catch (AuthoringCanvasValidationException error)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, error.Code), aeds);
            }
            catch (AuthoringCanvasBudgetExceededException error)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, error.Message), aeds);
            }
            catch (ArgumentException)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "article_canvas_link_request_invalid"), aeds);
            }
        })
        .WithName("binary_author_article_canvas_link_apply")
        .WithMetadata(new FsusOpenApiAedsContractMetadata(AedsFrameType.ArticleCanvasLinkRequest, AedsFrameType.ArticleCanvasLinkReceipt))
        .RequireNoStoreResponse()
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .AddEndpointFilterWithMetadata<RequiresPowFilter>();

        group.MapGet("/articles/{articleId:int}/canvas-links/history", static async Task<BinaryFrameResult> (
            int articleId, HttpContext context, IAedsEncoder aeds, IArticleCanvasLinkWriter writer,
            CancellationToken cancellationToken) =>
        {
            try
            {
                var owner = new AuthoringCanvasOwner(ResolveRequiredAdminPrincipalId(context), "primary-site");
                ArticleCanvasLinkHistoryResponse history = await writer.ReadHistoryAsync(owner, articleId, cancellationToken);
                return BinaryResults.Frame(aeds, AedsFrameType.ArticleCanvasLinkHistoryResponse,
                    destination => PodBinaryCodec.WriteArticleCanvasLinkHistoryResponse(history, destination));
            }
            catch (AuthoringCanvasAccessDeniedException)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "article_canvas_link_unavailable"), aeds);
            }
            catch (AuthoringCanvasValidationException error)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, error.Code), aeds);
            }
        })
        .WithName("binary_author_article_canvas_link_history")
        .WithMetadata(new FsusOpenApiAedsContractMetadata(null, AedsFrameType.ArticleCanvasLinkHistoryResponse))
        .RequireNoStoreResponse()
        .RequireAdminPermission(AdminPermissions.ArticleWrite);
    }
}
