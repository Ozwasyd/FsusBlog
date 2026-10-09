using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticlePackages;

namespace FsusBlog.Server.Modules.Endpoints;

public static partial class AuthoringEndpoints
{
    /// <summary>
    /// Inactive package-owned mapping. The original registry/DI owner must bind its closed
    /// frame pair and qualified canonical reader before adding this to the authoring host.
    /// </summary>
    internal static void MapArticlePackageCandidateReviewRoutes(IEndpointRouteBuilder group)
    {
        group.MapPost("/article-packages/candidate-review", ReadArticlePackageCandidateReviewAsync)
            .RequireAdminPermission(AdminPermissions.ArticleWrite);
    }

    internal static async Task<IResult> ReadArticlePackageCandidateReviewAsync(
        HttpContext context,
        IAedsEncoder aeds,
        ArticlePackageCandidateReviewReadService service,
        CancellationToken cancellationToken)
    {
        using var linkedCancellation = CancellationTokenSource.CreateLinkedTokenSource(
            context.RequestAborted, cancellationToken);
        CancellationToken token = linkedCancellation.Token;
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

        // The actual original route resolver owns frame selection. Until its closed pair is
        // registered, this refuses before reading any body; no substitute frame is admitted.
        AedsJsonRequest<ArticlePackageCandidateReviewReadRequest> parsed =
            await ReadRequestAsync<ArticlePackageCandidateReviewReadRequest>(context, aeds,
                "article_package_candidate_review_read_invalid", token).ConfigureAwait(false);
        token.ThrowIfCancellationRequested();
        if (!parsed.IsSuccess)
        {
            return parsed.ToErrorResult(aeds);
        }
        ArticlePackageCandidateReviewReadOutcome outcome = await service.ReadAsync(parsed.Value, token)
            .ConfigureAwait(false);
        token.ThrowIfCancellationRequested();
        if (!outcome.Result.IsValid)
        {
            string reason = outcome.Result.ReasonCode ?? "article_package_candidate_review_read_invalid";
            ApiErrorTransportMappingId mapping = reason switch
            {
                "article_package_candidate_review_context_drift" or "article_package_candidate_review_plan_stale"
                    => ApiErrorTransportMappingId.Default409Conflict,
                "article_package_candidate_review_access_denied" => ApiErrorTransportMappingId.Default403Forbidden,
                _ => ApiErrorTransportMappingId.Default400Validation
            };
            return AedsJsonResults.Error(aeds, mapping, reason);
        }
        return outcome.Response is null
            ? AedsJsonResults.BadRequest(aeds, "article_package_candidate_review_read_invalid")
            : Ok(context, aeds, outcome.Response);
    }
}
