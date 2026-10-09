using FsusBlog.Shared.Contracts.ArticleRelations;

namespace FsusBlog.Shared.Contracts.ArticleGraph;

/// <summary>Closed local graph vocabulary; link and embed remain distinct upstream facts.</summary>
public enum ArticleGraphEdgeKind : byte
{
    Link = 1,
    Embed = 2,
    Broken = 3,
    VisibilityRisk = 4
}

/// <summary>Graph scopes never implicitly include historical revisions.</summary>
public enum ArticleGraphScope : byte
{
    CurrentEditable = 1,
    Published = 2
}

/// <summary>Terminal states distinguish incomplete data from an empty complete graph.</summary>
public enum ArticleGraphStatus : byte
{
    Complete = 1,
    Truncated = 2,
    Unavailable = 3,
    Refused = 4,
    Stale = 5,
    Cancelled = 6
}

/// <summary>
/// Hard per-query fact-admission limits, applied before reading private facts. QueryMilliseconds
/// bounds accepting facts and requests cancellation; borrowed command/reader completion is awaited
/// and may exceed that window. It is not a hard real-time cleanup or response deadline.
/// </summary>
public sealed record ArticleGraphBudget(int Nodes, int Edges, int PayloadBytes, int IndexOperations, int QueryMilliseconds)
{
    public static ArticleGraphBudget Default { get; } = new(1000, 2000, 1_048_576, 4096, 250);
}

/// <summary>Metadata filters are projections, never graph node or relation producers.</summary>
public sealed record ArticleGraphFilters(IReadOnlyList<string> Categories, IReadOnlyList<string> Tags, IReadOnlyList<ArticleGraphEdgeKind> Kinds);

/// <summary>Exact authorization/source boundary; actor identity is supplied by the authenticated host.</summary>
public sealed record ArticleGraphIdentity(ArticleRelationActorContext Actor, string RootArticle, string RootRevision, string DocumentEpoch, string IndexGeneration);

/// <summary>Omitted depth means one; every supplied invalid depth is refused.</summary>
public sealed record ArticleGraphRequest(int SchemaVersion, ArticleGraphIdentity Identity, string SessionId, long Sequence, ArticleGraphScope Scope, int? RequestedDepth, bool ExplicitExpansion, ArticleGraphFilters Filters, ArticleGraphBudget Budget);

/// <summary>Only authorized stable articles may appear. There is no anonymous target representation.</summary>
public sealed record ArticleGraphNode(string ArticleIdentity, string RevisionIdentity, string Title, ArticleRelationLifecycleState Lifecycle);

/// <summary>Exact source reveal coordinate without private source text or title-based lookup.</summary>
public sealed record ArticleGraphSource(string ArticleIdentity, string RevisionIdentity, string DocumentEpoch, int Start, int End, string RecordDigest);

/// <summary>A bounded projection of one canonical relation, not an editable graph-owned relation.</summary>
public sealed record ArticleGraphEdge(string RelationIdentity, string SourceArticle, string? TargetArticle, ArticleGraphEdgeKind Kind, ArticleRelationResolutionStatus Resolution, ArticleGraphSource Source);

/// <summary>Usage counts cover authorized returned facts only; hidden totals are prohibited.</summary>
public sealed record ArticleGraphUsage(int Nodes, int Edges, int PayloadBytes, int IndexOperations);

/// <summary>The original relation owner returns this already permission-filtered bounded snapshot.</summary>
public sealed record ArticleGraphProjection(ArticleGraphIdentity Identity, int RequestedDepth, int EffectiveDepth, ArticleGraphStatus Status, string? Reason, IReadOnlyList<ArticleGraphNode> Nodes, IReadOnlyList<ArticleGraphEdge> Edges, ArticleGraphUsage Usage, string SourceDigest);

/// <summary>Graph terminal response binds request sequence and exact result identity; no positions exist here.</summary>
public sealed record ArticleGraphResult(int SchemaVersion, string SessionId, long Sequence, string RequestDigest, ArticleGraphProjection Projection, string ContentDigest);
