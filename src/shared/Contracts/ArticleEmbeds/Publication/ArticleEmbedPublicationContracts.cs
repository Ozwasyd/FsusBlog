using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;

namespace FsusBlog.Shared.Contracts.ArticleEmbeds.Publication;

/// <summary>Names the publication-planning contract artifacts layered on the #2454 provider contract.</summary>
public static class ArticleEmbedPublicationSchemas
{
    public const int Version = 1;
    public const string Authority = "fsusblog.article-embed-publication-authority.v1";
    public const string Edge = "fsusblog.article-embed-publication-edge.v1";
    public const string Plan = "fsusblog.article-embed-publication-plan.v1";
    public const string Receipt = "fsusblog.article-embed-publication-receipt.v1";
    public const string DeliveryPolicy = "publication-frozen-artifact";
}

/// <summary>Whether the frozen plan may feed a publication writer.</summary>
public enum ArticleEmbedPublicationPlanStatus : byte
{
    Sealed = 1,
    Blocked = 2
}

/// <summary>Per-edge disposition inside a publication plan.</summary>
public enum ArticleEmbedPublicationEdgeStatus : byte
{
    Frozen = 1,
    Blocked = 2
}

/// <summary>
/// One heading coordinate observed by the public publication authority at the resolved public revision. A repeated
/// <see cref="HeadingIdentity"/> inside one fact list is an ambiguity signal and must never first-match.
/// </summary>
public sealed record ArticleEmbedPublicationHeadingFact(
    string HeadingIdentity,
    ArticleEmbedSafeProjectionReference SubtreeProjection);

/// <summary>One #289 canonical block anchor coordinate observed at the resolved public revision.</summary>
public sealed record ArticleEmbedPublicationBlockFact(
    string BlockAnchor,
    ArticleEmbedSafeProjectionReference BlockProjection);

/// <summary>
/// Verified current public facts for one candidate target as the publication authority observed them. The planner
/// re-checks generation, site, permission, lifecycle, visibility and package completeness on every edge and never
/// treats the record as a cache or as authorization for same-actor shortcuts.
/// </summary>
public sealed record ArticleEmbedPublicationTargetFacts(
    string PortableArticleIdentity,
    string SiteIdentity,
    long AuthorityGeneration,
    long ResolvedPublicRevision,
    long LatestObservedRevision,
    ArticleEmbedVisibilityStatus Visibility,
    ArticleEmbedLifecycleStatus Lifecycle,
    ArticleEmbedPermissionStatus Permission,
    bool RevisionPackageComplete,
    string PublicSourceDigest,
    string TargetVersionIdentity,
    string RightsDigest,
    long SourceByteCount,
    string AttributionDisplayText,
    ArticleEmbedSafeProjectionReference BodyProjection,
    IReadOnlyList<ArticleEmbedPublicationHeadingFact> Headings,
    IReadOnlyList<ArticleEmbedPublicationBlockFact> Blocks,
    IReadOnlyList<ArticleEmbedDirectiveProjection> NestedDirectives);

/// <summary>
/// Sealed point-in-time public authority view the planner consumes. It binds the host article, the current host
/// revision and source digest under publication, the publication request and expected revision, actor/site/
/// permission context, provider runtime, material locale/theme and whether the product retains frozen public
/// artifacts, so any drift makes a recorded plan stale instead of silently current.
/// </summary>
public sealed record ArticleEmbedPublicationAuthority(
    string Schema,
    int SchemaVersion,
    string HostPortableArticleIdentity,
    ArticleEmbedDocumentIdentity HostDocument,
    long HostCurrentRevision,
    string HostSourceDigest,
    string PublicationRequestId,
    long ExpectedRevision,
    long AuthorityGeneration,
    ArticleEmbedActorContext Actor,
    ArticleEmbedRuntimeContext Runtime,
    string? MaterialLocale,
    string? MaterialTheme,
    bool FrozenArtifactRetention,
    IReadOnlyList<ArticleEmbedPublicationTargetFacts> Targets,
    string AuthorityDigest);

/// <summary>
/// One frozen or blocked host-to-target dependency edge. The owner is the document whose canonical source contains
/// the directive: the host for top-level embeds and the resolved public target for nested embeds. A frozen edge
/// permanently binds the exact public revision and anchor; later target updates never rewrite it. Blocked edges
/// may carry a null directive or target when the occurrence itself was too malformed to decode.
/// </summary>
public sealed record ArticleEmbedPublicationEdge(
    string Schema,
    int SchemaVersion,
    string OwnerPortableArticleIdentity,
    long OwnerRevision,
    ArticleEmbedDirectiveProjection? Directive,
    ArticleEmbedTargetIdentity? Target,
    ArticleEmbedPublicationEdgeStatus Status,
    ArticleEmbedDependencyCoordinate? Coordinate,
    ArticleEmbedError? Error,
    int Depth,
    long LatestObservedRevision,
    string EdgeDigest);

/// <summary>Receipt line per request: identities, statuses, digests and blocked descendants; never content.</summary>
public sealed record ArticleEmbedPublicationReceiptItem(
    string RequestId,
    ArticleEmbedTargetIdentity? Target,
    ArticleEmbedPublicationEdgeStatus Status,
    ArticleEmbedErrorCode? ErrorCode,
    long? ResolvedRevision,
    int DescendantEdgeCount,
    int BlockedDescendantCount,
    string EdgeDigest);

/// <summary>
/// Auditable publication-plan receipt. Records host binding, authority generation/digest, permission context,
/// graph and budget meters, per-request outcomes and digests. Target content is never recorded.
/// </summary>
public sealed record ArticleEmbedPublicationReceipt(
    string Schema,
    int SchemaVersion,
    string HostPortableArticleIdentity,
    ArticleEmbedDocumentIdentity HostDocument,
    long HostCurrentRevision,
    string HostSourceDigest,
    string PublicationRequestId,
    long ExpectedRevision,
    long AuthorityGeneration,
    string AuthorityDigest,
    ArticleEmbedActorContext Actor,
    ArticleEmbedRuntimeContext Runtime,
    string? MaterialLocale,
    string? MaterialTheme,
    ArticleEmbedResolutionBudgetLimits Budgets,
    ArticleEmbedBudgetObservation Observed,
    int RequestCount,
    int FrozenEdgeCount,
    int BlockedEdgeCount,
    int MaxObservedDepth,
    string GraphDigest,
    IReadOnlyList<ArticleEmbedPublicationReceiptItem> Items,
    string ReceiptDigest);

/// <summary>
/// The sealed or blocked publication dependency plan. A blocked plan carries every evaluated edge for diagnostics
/// but may never feed a publication writer; a sealed plan is the immutable snapshot bound to the commit receipt.
/// </summary>
public sealed record ArticleEmbedPublicationPlan(
    string Schema,
    int SchemaVersion,
    ArticleEmbedPublicationPlanStatus Status,
    string? BlockedReasonCode,
    IReadOnlyList<ArticleEmbedPublicationEdge> Edges,
    ArticleEmbedPublicationReceipt Receipt,
    string PlanDigest);

/// <summary>Independent verification outcome for a candidate publication plan.</summary>
public sealed record ArticleEmbedPublicationVerification(
    bool Valid,
    IReadOnlyList<string> ReasonCodes,
    string VerificationDigest);
