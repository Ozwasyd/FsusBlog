using System.Globalization;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Shared.Contracts.ArticlePackages;
using FsusBlog.Shared.Contracts.ArticleRelations;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Original finite-candidate result and optional readonly projection, never an admission receipt.</summary>
public sealed record ArticlePackageImportCandidateReviewProduction(
    ArticlePackageManifestCandidateResult Result,
    ArticlePackageCandidateReview? Review);

/// <summary>
/// Composes the original finite ZIP, immutable planner and readonly projection. The application
/// supplies a server context observer; it must bind a real canonical site to the authenticated
/// administrator. This module supplies no site identity, persisted permission authority or route.
/// </summary>
public sealed class ArticlePackageImportCandidateReviewProducer(
    IHttpContextAccessor httpContextAccessor,
    TimeProvider? timeProvider = null)
{
    private readonly TimeProvider _timeProvider = timeProvider ?? TimeProvider.System;

    /// <summary>
    /// The request is server-composed, not a transport DTO. Actor identity is checked against the
    /// actual admin principal; site and permission-context assertions must match both observations.
    /// The observer is a server application dependency, never a client callback or client context.
    /// Two observations detect drift but do not create an atomic or persisted permission receipt.
    /// Missing production site binding remains WIP; controlled contexts do not qualify that binding.
    /// </summary>
    public async Task<ArticlePackageImportCandidateReviewProduction> ProduceAsync(
        ReadOnlyMemory<byte> archiveBytes,
        ArticlePackageImportCandidateRequest? request,
        int pageIndex,
        int pageSize,
        Func<CancellationToken, ValueTask<ArticleRelationActorContext?>>? observeServerContext,
        CancellationToken cancellationToken = default)
    {
        if (cancellationToken.IsCancellationRequested)
        {
            return Cancelled();
        }
        if (request is null || observeServerContext is null)
        {
            return Refuse("article_package_import_request_invalid");
        }
        AuthenticatedRequest? authenticated = ReadAuthenticatedRequest();
        if (authenticated is null)
        {
            return Refuse("article_package_candidate_review_access_denied");
        }
        try
        {
            ArticleRelationActorContext? initial = await observeServerContext(cancellationToken).ConfigureAwait(false);
            if (cancellationToken.IsCancellationRequested)
            {
                return Cancelled();
            }
            if (!SameRequest(authenticated, ReadAuthenticatedRequest()))
            {
                return ContextDrift();
            }
            if (initial is null)
            {
                return Refuse("article_package_candidate_review_context_unavailable");
            }
            if (!ArticleRelationContractValidator.Validate(initial).IsValid)
            {
                return Refuse("article_package_candidate_review_context_invalid");
            }
            // This backend projection uses the observed canonical admin kind and numeric ID.
            // Neither a package source actor nor a request-selected actor can stand in for it.
            string actorIdentity = string.Concat(AnonymousIdentityRuntime.AdminPrincipalKind, ":",
                authenticated.AdminPrincipalId.ToString(CultureInfo.InvariantCulture));
            if (!string.Equals(initial.ActorIdentity, actorIdentity, StringComparison.Ordinal)
                || request.Actor != initial)
            {
                return Refuse("article_package_candidate_review_context_mismatch");
            }
            ArticlePackageManifestCandidateResult read = ArticlePackageImportZipCandidateReader.TryReadCandidate(
                archiveBytes.Span, out ArticlePackageImportZipCandidate? archive, cancellationToken);
            if (!read.IsValid)
            {
                return new(read, null);
            }
            ArticlePackageManifestCandidateResult planned = ArticlePackageImportCandidatePlanner.TryCreatePlan(
                archive!.Candidate, request, out ArticlePackageImportCandidatePlan? plan, cancellationToken);
            if (!planned.IsValid)
            {
                return new(planned, null);
            }
            if (!SameRequest(authenticated, ReadAuthenticatedRequest()))
            {
                return ContextDrift();
            }
            ArticleRelationActorContext? current = await observeServerContext(cancellationToken).ConfigureAwait(false);
            if (cancellationToken.IsCancellationRequested)
            {
                return Cancelled();
            }
            if (current != initial || !SameRequest(authenticated, ReadAuthenticatedRequest()))
            {
                return ContextDrift();
            }
            ArticlePackageManifestCandidateResult projected = ArticlePackageImportCandidateReviewProjection.TryProject(
                plan, pageIndex, pageSize, _timeProvider.GetUtcNow().UtcDateTime, out ArticlePackageCandidateReview? review);
            if (!projected.IsValid)
            {
                return new(projected, null);
            }
            if (cancellationToken.IsCancellationRequested)
            {
                return Cancelled();
            }
            if (!SameRequest(authenticated, ReadAuthenticatedRequest()))
            {
                return ContextDrift();
            }
            return new(projected, review);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return Cancelled();
        }
    }

    private AuthenticatedRequest? ReadAuthenticatedRequest()
    {
        HttpContext? context = httpContextAccessor.HttpContext;
        if (context?.User.Identity?.IsAuthenticated != true
            || !context.User.IsAdminPrincipal()
            || !context.User.TryGetAdminPrincipalId(out long adminPrincipalId)
            || string.IsNullOrWhiteSpace(context.User.GetAdminSessionId())
            || !context.User.HasAdminPermission(AdminPermissions.ArticleWrite))
        {
            return null;
        }
        return new(context, adminPrincipalId, context.User.GetAdminSessionId()!);
    }

    private static bool SameRequest(AuthenticatedRequest expected, AuthenticatedRequest? current)
        => current is not null && ReferenceEquals(expected.Context, current.Context)
            && expected.AdminPrincipalId == current.AdminPrincipalId
            && string.Equals(expected.SessionId, current.SessionId, StringComparison.Ordinal);

    private static ArticlePackageImportCandidateReviewProduction ContextDrift()
        => Refuse("article_package_candidate_review_context_drift");

    private static ArticlePackageImportCandidateReviewProduction Cancelled()
        => Refuse("article_package_import_cancelled");

    private static ArticlePackageImportCandidateReviewProduction Refuse(string reason)
        => new(new(false, reason), null);

    private sealed record AuthenticatedRequest(HttpContext Context, long AdminPrincipalId, string SessionId);
}
