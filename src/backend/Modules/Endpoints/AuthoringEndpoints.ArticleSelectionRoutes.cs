using FsusBlog.Contracts.AuthoringNavigation;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Modules.Endpoints;

public static partial class AuthoringEndpoints
{
    private static void MapArticleSelectionRoutes(IEndpointRouteBuilder group)
    {
        group.MapPost("/articles/revalidate-selection", static async Task<BinaryFrameResult> (
            HttpContext context, IAedsEncoder aeds, IBinaryEndpointRequestContext binder,
            AuthorArticleSelectionRevalidationTransport transport, CancellationToken cancellationToken) =>
        {
            using BinaryRequestPayload payload = await binder.ReadFrameAsync(context, aeds,
                AedsFrameType.AuthorArticleSelectionRevalidateRequest, cancellationToken,
                maxFrameBytes: AuthorArticleSelectionRevalidationContract.MaxRequestFrameBytes).ConfigureAwait(false);
            if (!payload.IsSuccess)
                return BinaryResults.FromError(payload.Error, aeds);
            if (!PodBinaryCodec.TryDecodeAuthorArticleSelectionRevalidationRequest(payload.Payload, out var request))
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation,
                    "author_article_selection_request_invalid"), aeds);
            var result = await transport.RevalidateAsync(request, cancellationToken).ConfigureAwait(false);
            return BinaryResults.Frame(aeds, AedsFrameType.AuthorArticleSelectionRevalidateResponse,
                destination => PodBinaryCodec.WriteAuthorArticleSelectionRevalidationResponse(result, destination));
        })
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .RequireNoStoreResponse()
        .WithName("binary_author_article_selection_revalidate")
        .WithMetadata(new FsusOpenApiAedsContractMetadata(
            AedsFrameType.AuthorArticleSelectionRevalidateRequest, AedsFrameType.AuthorArticleSelectionRevalidateResponse))
        .AddEndpointFilterWithMetadata<ArticleSelectionBoundaryFilter>()
        .AddEndpointFilterWithMetadata<RequiresPowFilter>();
    }

    private sealed class ArticleSelectionBoundaryFilter(IAedsEncoder aeds) : IEndpointFilter
    {
        public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
        {
            HttpContext http = context.HttpContext;
            http.Response.Headers.CacheControl = "private, no-store";
            if (http.User.Identity?.IsAuthenticated != true || !http.User.IsAdminPrincipal()
                || !http.User.TryGetAdminPrincipalId(out long principal) || principal <= 0
                || string.IsNullOrWhiteSpace(http.User.GetAdminSessionId()))
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Unauthorized, "admin_session_required"), aeds);
            try
            {
                return await next(context).ConfigureAwait(false);
            }
            catch (AuthorRecentArticleHistoryAccessDeniedException)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Forbidden,
                    "author_article_selection_access_denied"), aeds);
            }
            catch (AuthorRecentArticleHistoryValidationException)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation,
                    "author_article_selection_authority_invalid"), aeds);
            }
        }
    }
}
