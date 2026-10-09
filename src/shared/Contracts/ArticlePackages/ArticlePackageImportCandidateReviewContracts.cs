namespace FsusBlog.Shared.Contracts.ArticlePackages;

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
