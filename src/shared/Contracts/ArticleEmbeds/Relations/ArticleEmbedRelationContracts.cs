using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Publication;

namespace FsusBlog.Shared.Contracts.ArticleEmbeds.Relations;

/// <summary>Names the relation-edge contract artifacts layered on the #2454–#2456 embed contracts.</summary>
public static class ArticleEmbedRelationSchemas
{
    public const int Version = 1;
    public const string EdgeSet = "fsusblog.article-embed-edge-set.v1";
    public const string Edge = "fsusblog.article-embed-edge.v1";
    public const string DependencyReceipt = "fsusblog.article-embed-dependency-receipt.v1";
    public const string InvalidationTicket = "fsusblog.article-embed-invalidation-ticket.v1";
    public const string QueryReceipt = "fsusblog.article-embed-relation-query-receipt.v1";
    /// <summary>Public delivery reads frozen publication edges only; authoring edges never serve it.</summary>
    public const string PublicDeliveryPolicy = "frozen-edge-artifact-only";
}

/// <summary>Which verified pipeline produced an edge; the two families never share cache or query space.</summary>
public enum ArticleEmbedEdgeScope : byte
{
    Authoring = 1,
    FrozenPublication = 2
}

/// <summary>
/// Lifecycle of one stored embed edge. Current edges track the authoring authority; frozen edges are
/// immutable once written and never transition.
/// </summary>
public enum ArticleEmbedEdgeStatus : byte
{
    Current = 1,
    UpdateAvailable = 2,
    Stale = 3,
    Broken = 4,
    Frozen = 5
}

/// <summary>Closed reasons a precise invalidation ticket may carry.</summary>
public enum ArticleEmbedInvalidationReason : byte
{
    HostRevisionChanged = 1,
    TargetUpdated = 2,
    TargetRemoved = 3,
    TargetNonPublic = 4,
    AuthorityGenerationChanged = 5
}

/// <summary>
/// One embed relation edge as it would be stored through the #1808 relation authority. The owner is the
/// article whose canonical source contains the directive: the host for top-level embeds and a resolved
/// target for nested embeds. <see cref="EdgeIdentity"/> is revision-independent so re-derivation is
/// idempotent and deduplicates; <see cref="EdgeDigest"/> seals the full record. No content, title, slug,
/// route, URL or raw database id ever appears on an edge.
/// </summary>
public sealed record ArticleEmbedRelationEdge(
    string Schema,
    int SchemaVersion,
    string EdgeIdentity,
    ArticleEmbedEdgeScope Scope,
    ArticleEmbedEdgeStatus Status,
    string OwnerPortableArticleIdentity,
    long OwnerRevision,
    ArticleEmbedDirectiveProjection Directive,
    ArticleEmbedTargetIdentity Target,
    long ResolvedRevision,
    long LatestObservedRevision,
    ArticleEmbedVisibilityStatus Visibility,
    ArticleEmbedLifecycleStatus Lifecycle,
    ArticleEmbedPermissionStatus Permission,
    string DependencyDigest,
    string EdgeDigest);

/// <summary>
/// One derivation batch bound to the authority generation and the verified source artifact digest it came
/// from (authoring receipt or publication plan). An edge set is replaceable as a unit per host document;
/// its digest makes replay and partial writes observable.
/// </summary>
public sealed record ArticleEmbedRelationEdgeSet(
    string Schema,
    int SchemaVersion,
    string HostPortableArticleIdentity,
    ArticleEmbedDocumentIdentity HostDocument,
    long HostSourceRevision,
    ArticleEmbedEdgeScope Scope,
    long AuthorityGeneration,
    ArticleEmbedActorContext Actor,
    ArticleEmbedRuntimeContext Runtime,
    string? MaterialLocale,
    string? MaterialTheme,
    string SourceArtifactDigest,
    IReadOnlyList<ArticleEmbedRelationEdge> Edges,
    string SetDigest);

/// <summary>
/// Per-edge frozen dependency receipt: binds one stored frozen edge to the publication plan and the exact
/// sealed dependency coordinate it was derived from, so later target updates provably cannot rewrite it.
/// </summary>
public sealed record ArticleEmbedDependencyReceipt(
    string Schema,
    int SchemaVersion,
    string EdgeIdentity,
    string PlanDigest,
    string PublicationEdgeDigest,
    ArticleEmbedDependencyCoordinate Coordinate,
    string ReceiptDigest);

/// <summary>
/// Precise invalidation unit emitted only for edges whose observed status actually changed. It carries the
/// edge identity, the transition and the bounded cache key the entry was stored under; it never flushes a
/// family and never carries content.
/// </summary>
public sealed record ArticleEmbedInvalidationTicket(
    string Schema,
    int SchemaVersion,
    string EdgeIdentity,
    ArticleEmbedEdgeStatus FromStatus,
    ArticleEmbedEdgeStatus ToStatus,
    ArticleEmbedInvalidationReason Reason,
    string CacheKeyDigest,
    long ReconcileGeneration,
    string TicketDigest);

/// <summary>
/// Bounded lookup key for one edge family. Host document identity/epoch/revision, scope, provider runtime,
/// permission/site context and material locale/theme are all bound, so authoring and frozen entries can
/// never collide and no key can be shared across actors, revisions, runtimes or documents.
/// </summary>
public sealed record ArticleEmbedRelationCacheKey(
    string HostDocumentId,
    long HostDocumentEpoch,
    long HostSourceRevision,
    ArticleEmbedEdgeScope Scope,
    string ProviderId,
    int ProviderVersion,
    string RuntimeDigest,
    string PermissionContextDigest,
    string SiteIdentity,
    string? MaterialLocale,
    string? MaterialTheme);

/// <summary>Closed query over stored edges; public queries admit frozen edges only.</summary>
public enum ArticleEmbedRelationQueryKind : byte
{
    AuthoringCurrent = 1,
    PublicDelivery = 2
}

/// <summary>
/// Per-edge query line: identity, scope, status, coordinate digests and revisions only. Display text,
/// projections and content never appear, and no count or marker for withheld edges is emitted.
/// </summary>
public sealed record ArticleEmbedRelationQueryItem(
    string EdgeIdentity,
    string OwnerPortableArticleIdentity,
    long OwnerRevision,
    ArticleEmbedTargetIdentity Target,
    long ResolvedRevision,
    long LatestObservedRevision,
    ArticleEmbedEdgeStatus Status,
    string DependencyDigest,
    string EdgeDigest);

/// <summary>
/// Auditable query receipt bound to the queried edge set and the caller's actor/runtime context. Frozen
/// publication edges are the only payload of a public-delivery query; authoring queries stay bound to the
/// actor and revision the edges were derived under.
/// </summary>
public sealed record ArticleEmbedRelationQueryReceipt(
    string Schema,
    int SchemaVersion,
    ArticleEmbedRelationQueryKind Kind,
    string SetDigest,
    string HostPortableArticleIdentity,
    ArticleEmbedDocumentIdentity HostDocument,
    long HostSourceRevision,
    ArticleEmbedActorContext Actor,
    ArticleEmbedRuntimeContext Runtime,
    int EdgeCount,
    IReadOnlyList<ArticleEmbedRelationQueryItem> Items,
    string ReceiptDigest);

/// <summary>Rejected derivations carry a closed reason and never a partial edge set.</summary>
public sealed record ArticleEmbedRelationDerivation(
    bool Accepted,
    string? RejectedReasonCode,
    ArticleEmbedRelationEdgeSet? EdgeSet,
    IReadOnlyList<ArticleEmbedDependencyReceipt> DependencyReceipts);

/// <summary>
/// Result of reconciling stored current edges against a fresh authority: the updated edge set plus the
/// precise invalidation tickets for edges whose status actually changed. Frozen edges never appear here.
/// </summary>
public sealed record ArticleEmbedRelationReconciliation(
    bool Accepted,
    string? RejectedReasonCode,
    ArticleEmbedRelationEdgeSet? EdgeSet,
    IReadOnlyList<ArticleEmbedInvalidationTicket> Tickets,
    long ReconcileGeneration);

/// <summary>Independent verification outcome for a candidate relation artifact.</summary>
public sealed record ArticleEmbedRelationVerification(
    bool Valid,
    IReadOnlyList<string> ReasonCodes,
    string VerificationDigest);
