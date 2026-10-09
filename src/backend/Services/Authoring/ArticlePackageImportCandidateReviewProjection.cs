using System.Globalization;

using FsusBlog.Shared.Contracts.ArticlePackages;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>Content-free summary of the existing finite-byte candidate, not package admission.</summary>
public sealed record ArticlePackageCandidateReviewSummary(
    int ArticleCount,
    int FileCount,
    int SchemaVersion,
    int CanonicalHashVersion,
    int PropertySchemaVersion,
    string PackageBytesDigest,
    string ManifestSemanticDigest,
    string ChecksumComponentDigest);

/// <summary>Unresolved caller hints only. Int64 revisions are decimal strings on every serializer.</summary>
public sealed record ArticlePackageCandidateReviewTarget(
    string PortableArticle,
    bool RequiresNewIdentity,
    int? RequestedTargetArticleId,
    string? ExpectedTargetRevision);

/// <summary>
/// Bounded read model for a supplied immutable candidate plan. No actor, private titles, source
/// bytes, permission decision, validation receipt or execution result crosses this boundary.
/// Timestamps retain the original UTC precision; interval status observes caller assertions only.
/// No HTTP transport or permission projection is defined here; integration remains with #3663.
/// </summary>
public sealed record ArticlePackageCandidateReview(
    string CandidateStatus,
    ArticlePackageCandidateReviewSummary Summary,
    string RequestedMode,
    string PolicyDigest,
    string CreatedAtUtc,
    string ExpiresAtUtc,
    string IntervalStatus,
    string PlanDigest,
    int PageIndex,
    int PageSize,
    int TotalTargets,
    IReadOnlyList<ArticlePackageCandidateReviewTarget> Targets,
    IReadOnlyList<string> RequiredAuthorities,
    bool ExecuteDisabled,
    string ExecutionReasonCode);

/// <summary>
/// Projects the original planner without replanning, resolving targets, hashing or granting
/// authority. Invalid page requests return a fixed reason and no partial read model.
/// </summary>
public static class ArticlePackageImportCandidateReviewProjection
{
    public const int MaxPageSize = 50;
    public const string ExecutionRefusal = "article_package_import_authority_unavailable";

    public static ArticlePackageManifestCandidateResult TryProject(
        ArticlePackageImportCandidatePlan? plan,
        int pageIndex,
        int pageSize,
        DateTime nowUtc,
        out ArticlePackageCandidateReview? review)
    {
        review = null;
        if (plan is null || nowUtc.Kind != DateTimeKind.Utc
            || pageSize is < 1 or > MaxPageSize || pageIndex < 0)
        {
            return Invalid();
        }
        int count = plan.Targets.Count;
        if (count is < 1 or > ArticlePackageImportCandidatePlanner.MaxArticles
            || pageIndex >= (count + pageSize - 1) / pageSize
            || plan.RequiredAuthorities.Count is < 1 or > 16)
        {
            return Invalid();
        }
        ArticlePackageManifestCandidateResult authority = plan.RequireExecutionAuthority();
        if (authority.IsValid || authority.ReasonCode != ExecutionRefusal)
        {
            return Invalid();
        }
        int start = pageIndex * pageSize;
        var targets = new ArticlePackageCandidateReviewTarget[Math.Min(pageSize, count - start)];
        for (int index = 0; index < targets.Length; index++)
        {
            ArticlePackageImportCandidateTarget target = plan.Targets[start + index];
            targets[index] = new(target.PortableArticle.Value!, target.RequiresNewIdentity,
                target.RequestedTargetArticleId,
                target.ExpectedTargetRevision?.ToString(CultureInfo.InvariantCulture));
        }
        ArticlePackageValidatedImportCandidate candidate = plan.Candidate;
        ArticlePackageManifestCandidate manifest = candidate.Manifest;
        review = new(
            "finite_bytes_validated",
            new(manifest.Articles.Count, candidate.FilePaths.Count, manifest.SchemaVersion,
                manifest.CanonicalHashVersion, manifest.PropertySchemaVersion,
                candidate.PackageBytesDigest, manifest.SemanticDigest, candidate.ChecksumComponentDigest),
            plan.Mode.ToString(), plan.PolicyDigest,
            plan.CreatedAtUtc.ToString("O", CultureInfo.InvariantCulture),
            plan.ExpiresAtUtc.ToString("O", CultureInfo.InvariantCulture),
            nowUtc < plan.CreatedAtUtc ? "caller_interval_not_started"
                : nowUtc >= plan.ExpiresAtUtc ? "caller_interval_expired" : "caller_interval_current",
            plan.PlanDigest, pageIndex, pageSize, count, Array.AsReadOnly(targets),
            Array.AsReadOnly(plan.RequiredAuthorities.ToArray()), true, authority.ReasonCode!);
        return new(true, null);
    }

    private static ArticlePackageManifestCandidateResult Invalid()
        => new(false, "article_package_candidate_review_invalid");
}
