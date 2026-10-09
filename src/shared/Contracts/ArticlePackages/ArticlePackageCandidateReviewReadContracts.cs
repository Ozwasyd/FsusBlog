namespace FsusBlog.Shared.Contracts.ArticlePackages;

/// <summary>Transport hint only; the original portable identity codec and planner validate it.</summary>
public sealed record ArticlePackageCandidateReviewRequestedTarget(
    string PortableArticle,
    int RequestedTargetArticleId,
    string ExpectedTargetRevision);

/// <summary>
/// Echoed observed coordinates for readonly stale detection, never an identity assertion grant,
/// signed plan reference or execution receipt. The server resolves its actual approved scope.
/// </summary>
public sealed record ArticlePackageCandidateReviewContextExpectation(
    string Identity,
    int LifecycleVersion,
    int Generation,
    int MappingRevision,
    int ScopeRevision);

/// <summary>
/// Stateless bounded read input. ArchiveBytes is original ZIP data (base64 inside a typed AEDS
/// JSON frame); the browser does not parse it. Digests and interval are caller assertions.
/// No actor, session, target permission, server scope or lifecycle mutation is accepted here.
/// </summary>
public sealed record ArticlePackageCandidateReviewReadRequest(
    string RequestId,
    byte[] ArchiveBytes,
    string RequestedMode,
    string CallerPolicyDigest,
    string CallerPermissionContextDigest,
    DateTime CreatedAtUtc,
    DateTime ExpiresAtUtc,
    IReadOnlyList<ArticlePackageCandidateReviewRequestedTarget>? RequestedTargets,
    int PageIndex,
    int PageSize,
    string? ExpectedPlanDigest,
    ArticlePackageCandidateReviewContextExpectation? ExpectedContext);

/// <summary>
/// Original projection and correlated readonly context echo. Contains no source bytes, title,
/// actor/session, full scope list, permission verdict or executable plan reference.
/// </summary>
public sealed record ArticlePackageCandidateReviewReadResponse(
    string RequestId,
    ArticlePackageCandidateReview Review,
    ArticlePackageCandidateReviewContextExpectation Context);

/// <summary>
/// Explicit small stateless preview profile. The full typed request still must pass the original
/// 1 MiB authoring body limit; no large-package or full archive admission is implied.
/// </summary>
public static class ArticlePackageCandidateReviewReadLimits
{
    public const int MaxRequestBytes = 1024 * 1024;
    public const int MaxArchiveBytes = 512 * 1024;
    public const int MaxRequestIdLength = 128;
    public const int MaxPageSize = 50;
}
