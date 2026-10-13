using System.Globalization;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Shared.Contracts.ArticlePackages;
using FsusBlog.Shared.Contracts.ArticleRelations;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Bounded readonly result, not qualified site, permission, archive or execution admission.</summary>
public sealed record ArticlePackageCandidateReviewReadOutcome(
    ArticlePackageManifestCandidateResult Result,
    ArticlePackageCandidateReviewReadResponse? Response);

/// <summary>
/// Inactive consumer adaptation of the supplied canonical reader declarations. No registration,
/// store, initialization or HTTP route is provided. Production use awaits canonical review and
/// actual owner binding; controlled Current models in unit tests are not production authority.
/// </summary>
public sealed class ArticlePackageCandidateReviewReadService(
    ISystemSiteIdentityReader siteIdentityReader,
    IHttpContextAccessor httpContextAccessor,
    IConfiguration configuration,
    TimeProvider? timeProvider = null)
{
    private readonly ArticlePackageImportCandidateReviewProducer _producer = new(httpContextAccessor, timeProvider);

    /// <summary>
    /// Replays the same bounded original bytes and caller intent without retaining a second plan.
    /// Seed requests have neither expectation and page zero; later reads echo both expectations.
    /// The exact configured SITE_BASEURL must be in Current.Scopes, without trimming or fallback.
    /// Lifecycle/generation/mapping/scope revisions are preserved and compared even if identity
    /// and original plan digest stay unchanged. Cancellation and owner failures are not grants.
    /// </summary>
    public async Task<ArticlePackageCandidateReviewReadOutcome> ReadAsync(
        ArticlePackageCandidateReviewReadRequest? request,
        CancellationToken cancellationToken = default)
    {
        if (cancellationToken.IsCancellationRequested)
        {
            return Refuse("article_package_import_cancelled");
        }
        AuthenticatedScope? owner = ResolveOwner();
        if (owner is null)
        {
            return Refuse("article_package_candidate_review_access_denied");
        }
        if (!ValidEnvelope(request))
        {
            return Refuse("article_package_candidate_review_read_invalid");
        }
        try
        {
            SystemSiteIdentityReadModel initial = await siteIdentityReader.ReadCurrentSiteIdentityAsync(cancellationToken)
                .ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            SiteBinding? binding = Bind(initial, owner.Scope);
            if (binding is null)
            {
                return Refuse("article_package_candidate_review_site_unavailable");
            }
            if (!SameOwner(owner, ResolveOwner()))
            {
                return Refuse("article_package_candidate_review_context_drift");
            }
            if (request!.ExpectedContext is not null && request.ExpectedContext != binding.Expectation)
            {
                return Refuse("article_package_candidate_review_plan_stale");
            }
            string actor = string.Concat(AnonymousIdentityRuntime.AdminPrincipalKind, ":",
                owner.AdminPrincipalId.ToString(CultureInfo.InvariantCulture));
            var actorContext = new ArticleRelationActorContext(actor, binding.Expectation.Identity,
                request.CallerPermissionContextDigest);
            if (!ArticleRelationContractValidator.Validate(actorContext).IsValid
                || !TryTargets(request.RequestedTargets, out ArticlePackageImportRequestedTarget[]? targets))
            {
                return Refuse("article_package_import_request_invalid");
            }
            ArticlePackageImportCandidateMode mode = request.RequestedMode == "CreateNew"
                ? ArticlePackageImportCandidateMode.CreateNew : ArticlePackageImportCandidateMode.UpdateRequested;
            var original = new ArticlePackageImportCandidateRequest(actorContext, mode, request.CallerPolicyDigest,
                request.CreatedAtUtc, request.ExpiresAtUtc, targets);
            bool initialDelivered = false;
            async ValueTask<ArticleRelationActorContext?> Observe(CancellationToken token)
            {
                if (!SameOwner(owner, ResolveOwner()))
                {
                    return null;
                }
                if (!initialDelivered)
                {
                    initialDelivered = true;
                    // This is the actual pre-intake read above, not another fresh observation.
                    return actorContext;
                }
                SystemSiteIdentityReadModel current = await siteIdentityReader.ReadCurrentSiteIdentityAsync(token)
                    .ConfigureAwait(false);
                token.ThrowIfCancellationRequested();
                return Bind(current, owner.Scope) == binding && SameOwner(owner, ResolveOwner()) ? actorContext : null;
            }
            ArticlePackageImportCandidateReviewProduction produced = await _producer.ProduceAsync(request.ArchiveBytes,
                original, request.PageIndex, request.PageSize, Observe, cancellationToken).ConfigureAwait(false);
            if (!produced.Result.IsValid)
            {
                return new(produced.Result, null);
            }
            if (cancellationToken.IsCancellationRequested)
            {
                return Refuse("article_package_import_cancelled");
            }
            if (!SameOwner(owner, ResolveOwner()))
            {
                return Refuse("article_package_candidate_review_context_drift");
            }
            if (request.ExpectedPlanDigest is not null
                && !string.Equals(request.ExpectedPlanDigest, produced.Review!.PlanDigest, StringComparison.Ordinal))
            {
                return Refuse("article_package_candidate_review_plan_stale");
            }
            return new(produced.Result, new(request.RequestId, produced.Review!, binding.Expectation));
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            return Refuse("article_package_import_cancelled");
        }
    }

    private AuthenticatedScope? ResolveOwner()
    {
        HttpContext? context = httpContextAccessor.HttpContext;
        string? scope = configuration["SITE_BASEURL"];
        if (context?.User.Identity?.IsAuthenticated != true || !context.User.IsAdminPrincipal()
            || !context.User.TryGetAdminPrincipalId(out long adminId)
            || string.IsNullOrWhiteSpace(context.User.GetAdminSessionId())
            || !context.User.HasAdminPermission(AdminPermissions.ArticleWrite)
            || string.IsNullOrEmpty(scope))
        {
            return null;
        }
        return new(context, adminId, context.User.GetAdminSessionId()!, scope);
    }

    private static bool SameOwner(AuthenticatedScope expected, AuthenticatedScope? current)
        => current is not null && ReferenceEquals(expected.Context, current.Context)
            && expected.AdminPrincipalId == current.AdminPrincipalId
            && expected.SessionId == current.SessionId && expected.Scope == current.Scope;

    private static bool ValidEnvelope(ArticlePackageCandidateReviewReadRequest? request)
        => request is not null && !string.IsNullOrWhiteSpace(request.RequestId)
            && request.RequestId.Length <= ArticlePackageCandidateReviewReadLimits.MaxRequestIdLength
            && request.ArchiveBytes is not null && request.ArchiveBytes.Length is > 0
                and <= ArticlePackageCandidateReviewReadLimits.MaxArchiveBytes
            && request.RequestedMode is "CreateNew" or "UpdateRequested"
            && request.PageIndex >= 0 && request.PageSize is >= 1 and <= ArticlePackageCandidateReviewReadLimits.MaxPageSize
            && (request.ExpectedPlanDigest is null && request.ExpectedContext is null && request.PageIndex == 0
                || request.ExpectedContext is not null && ArticleRelationDigest.IsSha256(request.ExpectedPlanDigest));

    private static SiteBinding? Bind(SystemSiteIdentityReadModel? observed, string exactScope)
    {
        if (observed?.State != SystemSiteIdentityState.Current || observed.Identity is null
            || observed.LifecycleVersion != 1 || observed.Generation is not (>= 1 and <= 16)
            || observed.MappingRevision is not (>= 1 and <= 1024)
            || observed.Scopes is null || observed.Scopes.Count is < 1 or > 1024)
        {
            return null;
        }
        SystemSiteIdentityScope? selected = null;
        foreach (SystemSiteIdentityScope scope in observed.Scopes)
        {
            if (scope is null || scope.Revision < 1 || scope.Revision > observed.MappingRevision)
            {
                return null;
            }
            if (string.Equals(scope.Scope, exactScope, StringComparison.Ordinal))
            {
                if (selected is not null)
                {
                    return null;
                }
                selected = scope;
            }
        }
        return selected is null ? null : new(exactScope, new(observed.Identity, observed.LifecycleVersion.Value,
            observed.Generation.Value, observed.MappingRevision.Value, selected.Revision));
    }

    private static bool TryTargets(IReadOnlyList<ArticlePackageCandidateReviewRequestedTarget>? input,
        out ArticlePackageImportRequestedTarget[]? targets)
    {
        targets = null;
        if (input is null)
        {
            return true;
        }
        if (input.Count > ArticlePackageImportCandidatePlanner.MaxArticles)
        {
            return false;
        }
        var owned = new ArticlePackageImportRequestedTarget[input.Count];
        for (int index = 0; index < owned.Length; index++)
        {
            ArticlePackageCandidateReviewRequestedTarget hint = input[index];
            if (hint is null || !ArticlePackageIdentity.TryCreate(ArticlePackageIdentityKind.Article,
                    hint.PortableArticle, out ArticlePackageIdentity identity).IsValid
                || !long.TryParse(hint.ExpectedTargetRevision, NumberStyles.None, CultureInfo.InvariantCulture, out long revision)
                || revision <= 0 || hint.ExpectedTargetRevision != revision.ToString(CultureInfo.InvariantCulture))
            {
                return false;
            }
            owned[index] = new(identity, hint.RequestedTargetArticleId, revision);
        }
        targets = owned;
        return true;
    }

    private static ArticlePackageCandidateReviewReadOutcome Refuse(string reason)
        => new(new(false, reason), null);

    private sealed record AuthenticatedScope(HttpContext Context, long AdminPrincipalId, string SessionId, string Scope);
    private sealed record SiteBinding(string ApprovedScope, ArticlePackageCandidateReviewContextExpectation Expectation);
}
