using System.Text.Json;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Common;
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
            .WithName("ArticlePackageCandidateReviewRead")
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
            var requestContext = context.RequestServices.GetRequiredService<IBinaryEndpointRequestContext>();
            using BinaryRequestPayload payload = await requestContext.ReadFrameAsync(context, aeds,
                (AedsFrameType)ArticlePackageCandidateReviewWireValidation.ReservedRequestFrame, token,
                ArticlePackageCandidateReviewReadLimits.MaxRequestBytes).ConfigureAwait(false);
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
                return AedsJsonResults.BadRequest(aeds, outcome.Result.ReasonCode ?? ArticlePackageCandidateReviewWireValidation.InvalidResponse);
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
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
            return AedsJsonResults.BadRequest(aeds, "article_package_import_cancelled");
        }
        catch (Exception)
        {
            // No exception text, archive bytes or private reader context enters the public error.
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.InfraFailure, "article_package_candidate_review_unavailable"), aeds);
        }
    }
}
