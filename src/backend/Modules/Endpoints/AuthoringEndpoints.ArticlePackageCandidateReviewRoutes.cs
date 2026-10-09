using System.Text.Json;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticlePackages;

namespace FsusBlog.Server.Modules.Endpoints;

public static partial class AuthoringEndpoints
{
    /// <summary>Inactive until the sole central owner admits the frame pair, route and canonical reader.</summary>
    private static void MapArticlePackageCandidateReviewRoutes(IEndpointRouteBuilder group)
    {
        group.MapPost("/article-packages/candidate-review", ReadArticlePackageCandidateReviewAsync)
            .WithName("binary_post_author_article_packages_candidate_review")
            .RequireAdminPermission(AdminPermissions.ArticleWrite);
    }

    internal static async Task<IResult> ReadArticlePackageCandidateReviewAsync(
        HttpContext context,
        IAedsEncoder aeds,
        ArticlePackageCandidateReviewReadService service,
        CancellationToken cancellationToken)
    {
        using var linked = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken, context.RequestAborted);
        CancellationToken token = linked.Token;
        try
        {
            token.ThrowIfCancellationRequested();
            if (context.User.Identity?.IsAuthenticated != true)
            {
                return AedsJsonResults.Unauthorized(aeds);
            }
            if (!context.User.IsAdminPrincipal() || !context.User.TryGetAdminPrincipalId(out _)
                || string.IsNullOrWhiteSpace(context.User.GetAdminSessionId())
                || !context.User.HasAdminPermission(AdminPermissions.ArticleWrite))
            {
                return AedsJsonResults.Error(aeds, ApiErrorTransportMappingId.Default403Forbidden,
                    "article_package_candidate_review_access_denied");
            }
            if (context.Request.ContentLength > ArticlePackageCandidateReviewReadLimits.MaxRequestBytes)
            {
                return AedsJsonResults.BadRequest(aeds, "authoring_binary_body_too_large");
            }
            var requestContext = context.RequestServices.GetRequiredService<IBinaryEndpointRequestContext>();
            using BinaryRequestPayload payload = await requestContext.ReadFrameAsync(context, aeds,
                (AedsFrameType)ArticlePackageCandidateReviewWireValidation.ReservedRequestFrame, token,
                ArticlePackageCandidateReviewReadLimits.MaxRequestBytes).ConfigureAwait(false);
            token.ThrowIfCancellationRequested();
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }
            // The canonical helper bounds the declared frame. Unknown-length HTTP bodies must
            // also end here: even one trailing byte refuses before a typed service can observe it.
            while (true)
            {
                var remaining = await context.Request.BodyReader.ReadAsync(token).ConfigureAwait(false);
                bool trailing = !remaining.Buffer.IsEmpty;
                context.Request.BodyReader.AdvanceTo(remaining.Buffer.End);
                token.ThrowIfCancellationRequested();
                if (remaining.IsCanceled)
                {
                    throw new OperationCanceledException(token);
                }
                if (trailing)
                {
                    return AedsJsonResults.BadRequest(aeds, ArticlePackageCandidateReviewWireValidation.InvalidRequest);
                }
                if (remaining.IsCompleted)
                {
                    break;
                }
            }
            if (!ArticlePackageCandidateReviewWireValidation.TryReadRequest(payload.Payload, out ArticlePackageCandidateReviewReadRequest? request))
            {
                return AedsJsonResults.BadRequest(aeds, ArticlePackageCandidateReviewWireValidation.InvalidRequest);
            }
            token.ThrowIfCancellationRequested();
            ArticlePackageCandidateReviewReadOutcome outcome = await service.ReadAsync(request, token).ConfigureAwait(false);
            token.ThrowIfCancellationRequested();
            if (!outcome.Result.IsValid)
            {
                string reason = outcome.Result.ReasonCode ?? ArticlePackageCandidateReviewWireValidation.InvalidRequest;
                ApiErrorTransportMappingId mapping = reason switch
                {
                    "article_package_candidate_review_context_drift" or "article_package_candidate_review_plan_stale"
                        => ApiErrorTransportMappingId.Default409Conflict,
                    "article_package_candidate_review_access_denied" => ApiErrorTransportMappingId.Default403Forbidden,
                    _ => ApiErrorTransportMappingId.Default400Validation
                };
                return AedsJsonResults.Error(aeds, mapping, reason);
            }
            // Validate serialized output too: Web deserialization alone cannot close nested shapes.
            byte[] responseBytes = JsonSerializer.SerializeToUtf8Bytes(outcome.Response, new JsonSerializerOptions(JsonSerializerDefaults.Web));
            if (!ArticlePackageCandidateReviewWireValidation.TryReadResponse(responseBytes, out ArticlePackageCandidateReviewReadResponse? response)
                || !ArticlePackageCandidateReviewWireValidation.IsCorrelated(request!, response!))
            {
                return AedsJsonResults.BadRequest(aeds, ArticlePackageCandidateReviewWireValidation.InvalidResponse);
            }
            token.ThrowIfCancellationRequested();
            return BinaryResults.FrameRaw(aeds, (AedsFrameType)ArticlePackageCandidateReviewWireValidation.ReservedResponseFrame, responseBytes);
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (Exception)
        {
            token.ThrowIfCancellationRequested();
            // No exception text, archive bytes or private reader context enters the public error.
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.InfraFailure, "article_package_candidate_review_unavailable"), aeds);
        }
    }
}
