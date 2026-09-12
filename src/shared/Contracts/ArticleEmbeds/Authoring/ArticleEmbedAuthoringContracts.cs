namespace FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;

/// <summary>Names the authoring-resolution contract artifacts layered on the #2454 provider contract.</summary>
public static class ArticleEmbedAuthoringSchemas
{
    public const int Version = 1;
    public const string AuthoritySnapshot = "fsusblog.article-embed-authority-snapshot.v1";
    public const string Resolution = "fsusblog.article-embed-authoring-resolution.v1";
    public const string Receipt = "fsusblog.article-embed-authoring-receipt.v1";
    public const string OpenSourceIntentKind = "open-source-article";
    public const string DeliveryPolicy = "authoring-current-verified-authority";
}

/// <summary>Closed per-resolution cost limits. Bounds are themselves capped so a caller cannot request unbounded work.</summary>
public sealed record ArticleEmbedResolutionBudgetLimits(
    int MaxDepth,
    int MaxExpandedNodes,
    long MaxSourceBytes,
    long MaxElapsedMilliseconds,
    int MaxAuthorityMessages)
{
    public const int DepthBound = 32;
    public const int ExpandedNodesBound = 4096;
    public const long SourceBytesBound = 16L * 1024 * 1024;
    public const long ElapsedMillisecondsBound = 300_000;
    public const int AuthorityMessagesBound = 8192;
}

/// <summary>Whether an authoring-resolved target may enter a publication plan.</summary>
public enum ArticleEmbedPublicationEligibility : byte
{
    PublicationEligible = 1,
    AuthoringOnly = 2
}

/// <summary>Top-level authoring resolution disposition.</summary>
public enum ArticleEmbedAuthoringResolutionStatus : byte
{
    Completed = 1,
    Rejected = 2
}

/// <summary>
/// One heading coordinate observed by the caller's authority at the resolved revision. A repeated
/// <see cref="HeadingIdentity"/> inside one fact list is an ambiguity signal and must never first-match.
/// </summary>
public sealed record ArticleEmbedHeadingFact(
    string HeadingIdentity,
    ArticleEmbedSafeProjectionReference SubtreeProjection);

/// <summary>One #289 canonical block anchor coordinate observed at the resolved revision.</summary>
public sealed record ArticleEmbedBlockFact(
    string BlockAnchor,
    ArticleEmbedSafeProjectionReference BlockProjection);

/// <summary>
/// Verified current facts for one target article as the caller's permission-aware authority observed them.
/// The resolver re-checks site, permission, lifecycle and revision on every use and never treats the record
/// as a cache.
/// </summary>
public sealed record ArticleEmbedTargetFacts(
    string PortableArticleIdentity,
    string SiteIdentity,
    long AuthorityGeneration,
    long ResolvedRevision,
    long SourceRevision,
    long LatestObservedRevision,
    ArticleEmbedVisibilityStatus Visibility,
    ArticleEmbedLifecycleStatus Lifecycle,
    ArticleEmbedPermissionStatus Permission,
    string SourceDigest,
    string TargetVersionIdentity,
    long SourceByteCount,
    string AttributionDisplayText,
    ArticleEmbedSafeProjectionReference BodyProjection,
    IReadOnlyList<ArticleEmbedHeadingFact> Headings,
    IReadOnlyList<ArticleEmbedBlockFact> Blocks,
    IReadOnlyList<ArticleEmbedDirectiveProjection> NestedDirectives);

/// <summary>
/// Sealed point-in-time authority view the resolver consumes. It binds host document identity and epoch,
/// source revision, actor/site/permission context, provider runtime and material locale/theme so any drift
/// makes in-flight or recorded results stale instead of silently current.
/// </summary>
public sealed record ArticleEmbedAuthoritySnapshot(
    string Schema,
    int SchemaVersion,
    string HostPortableArticleIdentity,
    ArticleEmbedDocumentIdentity HostDocument,
    long HostSourceRevision,
    string HostSourceDigest,
    long AuthorityGeneration,
    ArticleEmbedActorContext Actor,
    ArticleEmbedRuntimeContext Runtime,
    string? MaterialLocale,
    string? MaterialTheme,
    IReadOnlyList<ArticleEmbedTargetFacts> Targets,
    string SnapshotDigest);

/// <summary>
/// Exact memo key used inside one resolution. It binds host document identity/epoch, host source revision,
/// target article/revision/kind/anchor, provider identity/version, runtime digest, permission/site context
/// and material locale/theme, so no key can be shared across actors, revisions, runtimes or documents.
/// </summary>
public sealed record ArticleEmbedAuthoringCacheKey(
    string HostDocumentId,
    long HostDocumentEpoch,
    long HostSourceRevision,
    string PortableArticleIdentity,
    long ResolvedRevision,
    ArticleEmbedTargetKind Kind,
    string? HeadingIdentity,
    string? BlockAnchor,
    string ProviderId,
    int ProviderVersion,
    string RuntimeDigest,
    string PermissionContextDigest,
    string SiteIdentity,
    string? MaterialLocale,
    string? MaterialTheme);

/// <summary>Stable target-only navigation intent for the UI open-source flow; carries no content and no mutation.</summary>
public sealed record ArticleEmbedOpenSourceIntent(
    string IntentKind,
    ArticleEmbedTargetIdentity Target,
    long ResolvedRevision);

/// <summary>
/// One nested embed occurrence expanded under the same resolver and budget context. Nested nodes never mint
/// new provider requests; they carry the directive projection, decoded target, outcome and their own children.
/// </summary>
public sealed record ArticleEmbedResolvedNode(
    ArticleEmbedDirectiveProjection Directive,
    ArticleEmbedTargetIdentity? Target,
    ArticleEmbedProviderResultStatus Status,
    ArticleEmbedDependencyCoordinate? Coordinate,
    ArticleEmbedError? Error,
    IReadOnlyList<ArticleEmbedResolvedNode> Children);

/// <summary>
/// Per-directive authoring outcome: the sealed #2454 provider result plus the publication eligibility mark,
/// an open-source navigation intent and the update-available fact comparing the authority's latest observed
/// revision with the resolved coordinate.
/// </summary>
public sealed record ArticleEmbedAuthoringEmbedResult(
    string RequestId,
    ArticleEmbedProviderResult Result,
    ArticleEmbedPublicationEligibility Eligibility,
    ArticleEmbedOpenSourceIntent? OpenSource,
    bool UpdateAvailable,
    IReadOnlyList<ArticleEmbedResolvedNode> Children);

/// <summary>Receipt line per request: identities, statuses, eligibility and cache fact; never content.</summary>
public sealed record ArticleEmbedAuthoringReceiptItem(
    string RequestId,
    ArticleEmbedTargetIdentity? Target,
    ArticleEmbedProviderResultStatus Status,
    ArticleEmbedErrorCode? ErrorCode,
    ArticleEmbedVisibilityStatus Visibility,
    ArticleEmbedLifecycleStatus Lifecycle,
    ArticleEmbedPermissionStatus Permission,
    long? ResolvedRevision,
    ArticleEmbedPublicationEligibility Eligibility,
    bool CacheHit,
    int ChildCount,
    string ResultDigest);

/// <summary>
/// Auditable resolution receipt. Records host/target identities, permission/lifecycle observations, graph and
/// budget meters, cache hits, statuses and digests. Display text and target content are never recorded.
/// </summary>
public sealed record ArticleEmbedAuthoringReceipt(
    string Schema,
    int SchemaVersion,
    string HostPortableArticleIdentity,
    ArticleEmbedDocumentIdentity HostDocument,
    long HostSourceRevision,
    long AuthorityGeneration,
    string SnapshotDigest,
    ArticleEmbedActorContext Actor,
    ArticleEmbedRuntimeContext Runtime,
    string? MaterialLocale,
    string? MaterialTheme,
    ArticleEmbedResolutionBudgetLimits Budgets,
    ArticleEmbedBudgetObservation Observed,
    int RequestCount,
    int ResolvedCount,
    int FailedCount,
    int CacheHitCount,
    int MaxObservedDepth,
    IReadOnlyList<ArticleEmbedAuthoringReceiptItem> Items,
    string ReceiptDigest);

/// <summary>Sealed outcome of one document-scoped authoring resolution.</summary>
public sealed record ArticleEmbedAuthoringResolution(
    string Schema,
    int SchemaVersion,
    ArticleEmbedAuthoringResolutionStatus Status,
    string? RejectedReasonCode,
    IReadOnlyList<ArticleEmbedAuthoringEmbedResult> Results,
    ArticleEmbedAuthoringReceipt Receipt,
    string ResolutionDigest);

/// <summary>Independent verification outcome for a candidate resolution.</summary>
public sealed record ArticleEmbedAuthoringVerification(
    bool Valid,
    IReadOnlyList<string> ReasonCodes,
    string VerificationDigest);
