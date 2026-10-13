using FsusBlog.Contracts.ArticleCapture;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Modules.Endpoints;

/// <summary>Capture-specific typed route source; actual central registration and rollout remain held.</summary>
public static class ArticleInboxCaptureEndpoints
{
    public static void MapArticleInboxCaptureRoutes(IEndpointRouteBuilder group)
    {
        Map(group, "/articles/inbox", "binary_author_article_inbox_create",
            AedsFrameType.ArticleInboxCaptureCreateRequest, reconcileOnly: false);
        Map(group, "/articles/inbox/reconcile", "binary_author_article_inbox_reconcile",
            AedsFrameType.ArticleInboxCaptureReconcileRequest, reconcileOnly: true);
    }

    private static void Map(IEndpointRouteBuilder group, string path, string name, AedsFrameType requestFrame,
        bool reconcileOnly)
    {
        group.MapPost(path, async Task<BinaryFrameResult> (HttpContext context, IAedsEncoder aeds,
            IBinaryEndpointRequestContext binder, ArticleInboxCaptureTransport transport, CancellationToken cancellationToken) =>
        {
            context.Response.Headers.CacheControl = "private, no-store";
            try
            {
                using BinaryRequestPayload payload = await binder.ReadFrameAsync(context, aeds, requestFrame,
                    cancellationToken, maxFrameBytes: ArticleInboxCaptureContract.MaxRequestFrameBytes).ConfigureAwait(false);
                if (!payload.IsSuccess) return BinaryResults.FromError(payload.Error, aeds);
                if (!PodBinaryCodec.TryDecodeArticleInboxCaptureRequest(payload.Payload, out var request))
                    return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation,
                        "article_inbox_capture_request_invalid"), aeds);
                ArticleInboxCaptureResponse response = reconcileOnly
                    ? await transport.ReconcileAsync(request, cancellationToken).ConfigureAwait(false)
                    : await transport.CreateAsync(request, cancellationToken).ConfigureAwait(false);
                return BinaryResults.Frame(aeds, AedsFrameType.ArticleInboxCaptureResponse,
                    destination => PodBinaryCodec.WriteArticleInboxCaptureResponse(response, destination));
            }
            catch (ArticleTemplateAccessDeniedException)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Forbidden,
                    "article_inbox_capture_access_denied"), aeds);
            }
            catch (ArticleCreateConflictException)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Conflict,
                    "article_inbox_capture_idempotency_conflict"), aeds);
            }
            catch (ArgumentException)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation,
                    "article_inbox_capture_request_invalid"), aeds);
            }
            catch (ArticleCreateException)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.InfraFailure,
                    "article_inbox_capture_receipt_binding_invalid"), aeds);
            }
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .RequireNoStoreResponse()
        .WithName(name)
        .WithMetadata(new FsusOpenApiAedsContractMetadata(requestFrame, AedsFrameType.ArticleInboxCaptureResponse))
        .AddEndpointFilterWithMetadata<RequiresPowFilter>();
    }
}
