using System.Collections.Immutable;

using FsusBlog.Shared.Contracts.ArticleEmbeds;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Publication;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Relations;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Versioned, content-free bridge from the sole embed pipeline into the sole relation index. Factories
/// reuse its independent verifiers, not a resolver, graph algorithm, parser or digest implementation.
/// Verification binds supplied artifacts; it does not establish observed live permission, persistence,
/// publication commit or runtime admission. The original source adapter retains those responsibilities.
/// </summary>
public sealed class ArticleRelationIndexEmbedAdmission
{
    public const int Version = 1;
    public const string Schema = "fsusblog.article-relation-index-embed-admission.v1";

    public int SchemaVersion => Version;
    public ArticleRelationIndexDependencyKind DependencyKind => ArticleRelationIndexDependencyKind.Embed;
    public long HostSourceSequence
    {
        get;
    }
    public long SourceGeneration
    {
        get;
    }
    public string? ProjectionReceiptDigest
    {
        get;
    }
    public ArticleEmbedRelationEdgeSet EdgeSet
    {
        get;
    }
    public ImmutableArray<ArticleEmbedDependencyCoordinate> Coordinates
    {
        get;
    }
    public ImmutableArray<ArticleEmbedDependencyReceipt> DependencyReceipts
    {
        get;
    }

    private ArticleRelationIndexEmbedAdmission(
        long hostSourceSequence,
        long sourceGeneration,
        string? projectionReceiptDigest,
        ArticleEmbedRelationDerivation derivation,
        ImmutableArray<ArticleEmbedDependencyCoordinate> coordinates)
    {
        Require(hostSourceSequence > 0 && sourceGeneration > 0, "article_relation_index_embed_generation_invalid");
        HostSourceSequence = hostSourceSequence;
        SourceGeneration = sourceGeneration;
        ProjectionReceiptDigest = projectionReceiptDigest;
        EdgeSet = derivation.EdgeSet! with
        {
            Edges = derivation.EdgeSet!.Edges.ToImmutableArray()
        };
        Coordinates = coordinates;
        DependencyReceipts = derivation.DependencyReceipts.ToImmutableArray();
    }

    /// <summary>
    /// Accepts the exact separate projection/expanded-graph/relation outputs of upstream 1194ee450.
    /// Original relation verification rechecks the graph; projection verification checks the first stage.
    /// </summary>
    public static ArticleRelationIndexEmbedAdmission FromAuthoring(
        long hostSourceSequence,
        long sourceGeneration,
        IReadOnlyList<ArticleEmbedProviderRequest>? requests,
        ArticleEmbedAuthoritySnapshot? snapshot,
        ArticleEmbedResolutionBudgetLimits? budgets,
        ArticleEmbedAuthoringResolution? projection,
        ArticleEmbedAuthoringResolution? graph,
        ArticleEmbedRelationDerivation? derivation,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        derivation = HoldDerivation(derivation);
        Require(ArticleEmbedAuthoringVerifier.Verify(requests, snapshot, budgets, projection).Valid
            && ArticleEmbedRelationVerifier.VerifyFromAuthoring(requests, snapshot, budgets, graph, derivation).Valid
            && derivation!.Accepted && derivation.EdgeSet?.Scope == ArticleEmbedEdgeScope.Authoring,
            "article_relation_index_embed_authoring_unverified");
        var coordinates = new Dictionary<(ArticleEmbedTargetIdentity Target, long Revision, string Digest), ArticleEmbedDependencyCoordinate>();
        var pending = new Stack<ArticleEmbedResolvedNode>();
        Require(graph!.Results.Count <= ArticleEmbedResolutionBudgetLimits.ExpandedNodesBound,
            "article_relation_index_embed_node_budget_exceeded");
        int visited = 0;
        foreach (ArticleEmbedAuthoringEmbedResult result in graph.Results.ToImmutableArray())
        {
            cancellationToken.ThrowIfCancellationRequested();
            Require(++visited <= ArticleEmbedResolutionBudgetLimits.ExpandedNodesBound,
                "article_relation_index_embed_node_budget_exceeded");
            Add(result.Result.Coordinate);
            PushChildren(result.Children);
        }
        while (pending.TryPop(out ArticleEmbedResolvedNode? node))
        {
            cancellationToken.ThrowIfCancellationRequested();
            Require(node is not null && ++visited <= ArticleEmbedResolutionBudgetLimits.ExpandedNodesBound,
                "article_relation_index_embed_node_budget_exceeded");
            Add(node!.Coordinate);
            PushChildren(node.Children);
        }
        var bound = ImmutableArray.CreateBuilder<ArticleEmbedDependencyCoordinate>();
        foreach (ArticleEmbedRelationEdge edge in derivation!.EdgeSet!.Edges)
        {
            cancellationToken.ThrowIfCancellationRequested();
            Require(coordinates.TryGetValue((edge.Target, edge.ResolvedRevision, edge.DependencyDigest), out ArticleEmbedDependencyCoordinate? coordinate),
                "article_relation_index_embed_coordinate_missing");
            bound.Add(coordinate!);
        }
        cancellationToken.ThrowIfCancellationRequested();
        return new(hostSourceSequence, sourceGeneration, projection!.Receipt.ReceiptDigest, derivation, bound.ToImmutable());

        void PushChildren(IReadOnlyList<ArticleEmbedResolvedNode> children)
        {
            Require(children.Count <= ArticleEmbedResolutionBudgetLimits.ExpandedNodesBound - visited - pending.Count,
                "article_relation_index_embed_node_budget_exceeded");
            foreach (ArticleEmbedResolvedNode child in children.ToImmutableArray())
            {
                cancellationToken.ThrowIfCancellationRequested();
                pending.Push(child);
            }
        }

        void Add(ArticleEmbedDependencyCoordinate? coordinate)
        {
            if (coordinate is null)
            {
                return;
            }
            Require(ArticleEmbedContractValidator.Validate(coordinate).IsValid,
                "article_relation_index_embed_coordinate_invalid");
            var key = (coordinate.Target, coordinate.ResolvedRevision, coordinate.DependencyDigest);
            Require(!coordinates.TryGetValue(key, out ArticleEmbedDependencyCoordinate? previous) || previous == coordinate,
                "article_relation_index_embed_coordinate_ambiguous");
            coordinates[key] = coordinate;
        }
    }

    /// <summary>Retains the verified sealed plan and exact dependency receipts; blocked plans are refused.</summary>
    public static ArticleRelationIndexEmbedAdmission FromPublication(
        long hostSourceSequence,
        long sourceGeneration,
        IReadOnlyList<ArticleEmbedProviderRequest>? requests,
        ArticleEmbedPublicationAuthority? authority,
        ArticleEmbedResolutionBudgetLimits? budgets,
        ArticleEmbedPublicationPlan? plan,
        ArticleEmbedRelationDerivation? derivation,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        derivation = HoldDerivation(derivation);
        Require(ArticleEmbedRelationVerifier.VerifyFromPlan(requests, authority, budgets, plan, derivation).Valid
            && derivation!.Accepted && derivation.EdgeSet?.Scope == ArticleEmbedEdgeScope.FrozenPublication,
            "article_relation_index_embed_publication_unverified");
        Dictionary<string, ArticleEmbedDependencyReceipt> receipts = derivation!.DependencyReceipts
            .ToDictionary(static receipt => receipt.EdgeIdentity, StringComparer.Ordinal);
        ImmutableArray<ArticleEmbedDependencyCoordinate> coordinates = derivation.EdgeSet!.Edges
            .Select(edge => receipts[edge.EdgeIdentity].Coordinate).ToImmutableArray();
        cancellationToken.ThrowIfCancellationRequested();
        return new(hostSourceSequence, sourceGeneration, null, derivation, coordinates);
    }

    private static ArticleEmbedRelationDerivation? HoldDerivation(ArticleEmbedRelationDerivation? derivation)
    {
        if (derivation?.EdgeSet?.Edges is null || derivation.DependencyReceipts is null)
        {
            return derivation;
        }
        Require(derivation.EdgeSet.Edges.Count <= ArticleEmbedResolutionBudgetLimits.ExpandedNodesBound
            && derivation.DependencyReceipts.Count <= ArticleEmbedResolutionBudgetLimits.ExpandedNodesBound,
            "article_relation_index_embed_edge_budget_exceeded");
        return derivation with
        {
            EdgeSet = derivation.EdgeSet with
            {
                Edges = derivation.EdgeSet.Edges.ToImmutableArray()
            },
            DependencyReceipts = derivation.DependencyReceipts.ToImmutableArray()
        };
    }

    internal bool SameBinding(ArticleRelationIndexEmbedAdmission other)
        => HostSourceSequence == other.HostSourceSequence && SourceGeneration == other.SourceGeneration
            && ProjectionReceiptDigest == other.ProjectionReceiptDigest && EdgeSet.SetDigest == other.EdgeSet.SetDigest
            && Coordinates.SequenceEqual(other.Coordinates)
            && DependencyReceipts.Select(static receipt => receipt.ReceiptDigest)
                .SequenceEqual(other.DependencyReceipts.Select(static receipt => receipt.ReceiptDigest));

    private static void Require(bool condition, string reasonCode)
    {
        if (!condition)
        {
            throw new ArticleRelationIndexException(reasonCode);
        }
    }
}
