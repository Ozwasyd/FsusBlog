using System.Collections.Immutable;

namespace FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;

/// <summary>Closed limits and identity for an ordinary, non-executing refresh candidate.</summary>
public static class ArticleEmbedRefreshPlanContract
{
    public const string Schema = "fsusblog.article-embed-refresh-plan.v1";
    public const int Version = 1;
    public const int MaxSelectedDirectives = 256;
    public const int MaxHostDependencies = ArticleEmbedResolutionBudgetLimits.ExpandedNodesBound;
}

/// <summary>Planning outcomes never imply a committed draft or an executable authorization.</summary>
public enum ArticleEmbedRefreshPlanStatus : byte
{
    Prepared = 1,
    NoChange = 2,
    Blocked = 3,
    Stale = 4,
    Cancelled = 5
}

/// <summary>
/// Exact current host draft coordinates supplied by its canonical owner. Server revision is the
/// draft CAS coordinate; source revision and digest are the existing embed provider coordinates.
/// This value is neither a read implementation nor evidence of permission to access the draft.
/// </summary>
public sealed record ArticleEmbedRefreshHostCoordinate(
    string PortableArticleIdentity,
    string DraftKey,
    long ServerRevision,
    ArticleEmbedDocumentIdentity Document,
    long SourceRevision,
    string SourceDigest);

/// <summary>
/// One recorded host dependency occurrence, obtained from the exact host draft by its owner.
/// Directive identity comes from that owner and the parser; it is never synthesized from Markdown.
/// </summary>
public sealed record ArticleEmbedRefreshHostDependency(
    string DirectiveIdentity,
    ArticleEmbedDirectiveProjection Directive,
    ArticleEmbedDependencyCoordinate RecordedCoordinate);

/// <summary>
/// Caller-observed current host facts. The complete bounded dependency roster is required, including
/// unselected occurrences. Its digest detects drift, not authenticity or completeness of a real read.
/// No production reader or authority is installed by these contracts.
/// </summary>
public sealed record ArticleEmbedRefreshHostFacts(
    ArticleEmbedRefreshHostCoordinate Host,
    ArticleEmbedActorContext Actor,
    ArticleEmbedPermissionStatus EditPermission,
    ImmutableArray<ArticleEmbedRefreshHostDependency> Dependencies);

/// <summary>
/// One explicitly selected occurrence and its exact old and desired coordinates. The provider request
/// must be the existing sealed authoring request for this directive, actor and host source.
/// </summary>
public sealed record ArticleEmbedRefreshSelection(
    string DirectiveIdentity,
    ArticleEmbedProviderRequest Request,
    ArticleEmbedDependencyCoordinate RecordedCoordinate,
    ArticleEmbedDependencyCoordinate DesiredCoordinate);

/// <summary>
/// Explicit bounded refresh input, bound to previously observed host and current-target facts.
/// Digests must come from the caller's trusted observation, never from a candidate being admitted.
/// There is no implicit all/latest selector, target lookup or source rewrite operation.
/// </summary>
public sealed record ArticleEmbedRefreshPlanRequest(
    string RequestId,
    ArticleEmbedActorContext Actor,
    ArticleEmbedRefreshHostCoordinate ExpectedHost,
    string ExpectedHostFactsDigest,
    long ExpectedAuthorityGeneration,
    string ExpectedAuthoritySnapshotDigest,
    ArticleEmbedResolutionBudgetLimits Budgets,
    ImmutableArray<ArticleEmbedRefreshSelection> Selections);

/// <summary>Frozen selected occurrence; carries coordinates and permission/lifecycle facts, never content.</summary>
public sealed record ArticleEmbedRefreshPlanItem(
    string DirectiveIdentity,
    string ProviderRequestId,
    string ProviderRequestDigest,
    ArticleEmbedDirectiveProjection Directive,
    ArticleEmbedDependencyCoordinate OldCoordinate,
    ArticleEmbedDependencyCoordinate NewCoordinate,
    long TargetSourceRevision,
    string TargetSourceDigest,
    ArticleEmbedVisibilityStatus Visibility,
    ArticleEmbedLifecycleStatus Lifecycle,
    ArticleEmbedPermissionStatus Permission,
    bool Changed);

/// <summary>
/// Flat preorder node in the selected current-target graph. ParentIndex is -1 for a selected root.
/// These implications cover only the explicit selection, not the unselected persisted host graph.
/// </summary>
public sealed record ArticleEmbedRefreshGraphNode(
    string ProviderRequestId,
    int ParentIndex,
    ArticleEmbedDirectiveProjection Directive,
    ArticleEmbedDependencyCoordinate Coordinate);

/// <summary>
/// Immutable in-memory candidate with no public constructor or mutation surface. A digest provides
/// structural binding only: this is not a persisted receipt, authorization, CAS result or commit plan.
/// All execution requires canonical host/target/permission/whole-graph revalidation and a new draft
/// revision transaction with idempotency, outbox and audit. Existing publications are outside its scope.
/// </summary>
public sealed class ArticleEmbedRefreshPlan
{
    internal ArticleEmbedRefreshPlan(
        ArticleEmbedRefreshPlanRequest request,
        ArticleEmbedAuthoritySnapshot snapshot,
        ArticleEmbedBudgetObservation observed,
        string graphDigest,
        string relationSetDigest,
        ImmutableArray<ArticleEmbedRefreshPlanItem> items,
        ImmutableArray<ArticleEmbedRefreshGraphNode> graph,
        string planDigest)
    {
        RequestId = request.RequestId;
        Actor = request.Actor;
        Host = request.ExpectedHost;
        HostFactsDigest = request.ExpectedHostFactsDigest;
        AuthorityGeneration = snapshot.AuthorityGeneration;
        AuthoritySnapshotDigest = snapshot.SnapshotDigest;
        Runtime = snapshot.Runtime;
        MaterialLocale = snapshot.MaterialLocale;
        MaterialTheme = snapshot.MaterialTheme;
        Budgets = request.Budgets;
        Observed = observed;
        GraphDigest = graphDigest;
        RelationSetDigest = relationSetDigest;
        Items = items;
        SelectedGraph = graph;
        PlanDigest = planDigest;
    }

    public string Schema => ArticleEmbedRefreshPlanContract.Schema;
    public int SchemaVersion => ArticleEmbedRefreshPlanContract.Version;
    public bool CanExecute => false;
    public string RequestId
    {
        get;
    }
    public ArticleEmbedActorContext Actor
    {
        get;
    }
    public ArticleEmbedRefreshHostCoordinate Host
    {
        get;
    }
    public string HostFactsDigest
    {
        get;
    }
    public long AuthorityGeneration
    {
        get;
    }
    public string AuthoritySnapshotDigest
    {
        get;
    }
    public ArticleEmbedRuntimeContext Runtime
    {
        get;
    }
    public string? MaterialLocale
    {
        get;
    }
    public string? MaterialTheme
    {
        get;
    }
    public ArticleEmbedResolutionBudgetLimits Budgets
    {
        get;
    }
    public ArticleEmbedBudgetObservation Observed
    {
        get;
    }
    public string GraphDigest
    {
        get;
    }
    public string RelationSetDigest
    {
        get;
    }
    public ImmutableArray<ArticleEmbedRefreshPlanItem> Items
    {
        get;
    }
    public ImmutableArray<ArticleEmbedRefreshGraphNode> SelectedGraph
    {
        get;
    }
    public string PlanDigest
    {
        get;
    }
}

/// <summary>Failed planning returns no partial plan and only closed non-sensitive reason codes.</summary>
public sealed record ArticleEmbedRefreshPlanningResult(
    ArticleEmbedRefreshPlanStatus Status,
    ArticleEmbedRefreshPlan? Plan,
    string? ReasonCode);
