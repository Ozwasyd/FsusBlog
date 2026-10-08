using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Graph;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Publication;

namespace FsusBlog.Shared.Contracts.ArticleEmbeds.Relations;

/// <summary>
/// Pure contract-level projection from verified #2455 authoring resolutions and sealed #2456 publication
/// plans into relation edges, frozen dependency receipts, precise invalidation tickets and query receipts.
/// It never parses source, never scans rendered output, never reads a store or cache, and never rewrites
/// host or target content. Every entry point re-verifies its source artifact first, so an unverified or
/// tampered resolution/plan produces a rejection rather than an edge. Persistence belongs to the #1808
/// relation authority; this slice defines only the canonical edge, receipt and invalidation shapes.
/// </summary>
public static class ArticleEmbedRelationDeriver
{
    /// <summary>Derives authoring-scope current edges from a verified resolution tree.</summary>
    public static ArticleEmbedRelationDerivation DeriveFromAuthoring(
        IReadOnlyList<ArticleEmbedProviderRequest>? requests,
        ArticleEmbedAuthoritySnapshot? snapshot,
        ArticleEmbedResolutionBudgetLimits? budgets,
        ArticleEmbedAuthoringResolution? resolution)
    {
        ArticleEmbedAuthoringVerification verification =
            ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, budgets, resolution);
        if (!verification.Valid)
        {
            return Rejected("article_embed_relation_source_unverified");
        }
        if (resolution!.Status != ArticleEmbedAuthoringResolutionStatus.Completed)
        {
            return Rejected("article_embed_relation_resolution_rejected");
        }

        var factsByIdentity = snapshot!.Targets
            .GroupBy(static facts => facts.PortableArticleIdentity, StringComparer.Ordinal)
            .ToDictionary(static group => group.Key, static group => group.ToList(), StringComparer.Ordinal);
        var requestsById = requests!
            .ToDictionary(static request => request.RequestId, StringComparer.Ordinal);

        var edges = new List<ArticleEmbedRelationEdge>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (ArticleEmbedAuthoringEmbedResult result in resolution.Results)
        {
            if (!requestsById.TryGetValue(result.RequestId, out ArticleEmbedProviderRequest? request))
            {
                return Rejected("article_embed_relation_request_binding_missing");
            }
            AppendNode(
                edges,
                seen,
                factsByIdentity,
                snapshot.HostPortableArticleIdentity,
                snapshot.HostSourceRevision,
                request.Directive,
                result.Result.Status,
                request.Target,
                result.Result.Coordinate);
            AppendChildren(
                edges,
                seen,
                factsByIdentity,
                result.Result.Coordinate,
                result.Children);
        }

        return Accepted(SealSet(new ArticleEmbedRelationEdgeSet(
            ArticleEmbedRelationSchemas.EdgeSet,
            ArticleEmbedRelationSchemas.Version,
            snapshot.HostPortableArticleIdentity,
            snapshot.HostDocument,
            snapshot.HostSourceRevision,
            ArticleEmbedEdgeScope.Authoring,
            snapshot.AuthorityGeneration,
            snapshot.Actor,
            snapshot.Runtime,
            snapshot.MaterialLocale,
            snapshot.MaterialTheme,
            resolution.Receipt.ReceiptDigest,
            edges,
            string.Empty)));
    }

    /// <summary>
    /// Derives frozen publication edges plus one sealed dependency receipt per edge. A blocked plan yields
    /// a rejection: relation storage never sees a partial publication graph.
    /// </summary>
    public static ArticleEmbedRelationDerivation DeriveFromPlan(
        IReadOnlyList<ArticleEmbedProviderRequest>? requests,
        ArticleEmbedPublicationAuthority? authority,
        ArticleEmbedResolutionBudgetLimits? budgets,
        ArticleEmbedPublicationPlan? plan)
    {
        ArticleEmbedPublicationVerification verification =
            ArticleEmbedPublicationVerifier.Verify(requests, authority, budgets, plan);
        if (!verification.Valid)
        {
            return Rejected("article_embed_relation_source_unverified");
        }
        if (plan!.Status != ArticleEmbedPublicationPlanStatus.Sealed)
        {
            return Rejected("article_embed_relation_plan_blocked");
        }

        var factsByIdentity = authority!.Targets
            .GroupBy(static facts => facts.PortableArticleIdentity, StringComparer.Ordinal)
            .ToDictionary(static group => group.Key, static group => group.ToList(), StringComparer.Ordinal);

        var edges = new List<ArticleEmbedRelationEdge>(plan.Edges.Count);
        var receipts = new List<ArticleEmbedDependencyReceipt>(plan.Edges.Count);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (ArticleEmbedPublicationEdge edge in plan.Edges)
        {
            string identity = ArticleEmbedRelationDigest.ComputeEdgeIdentity(
                ArticleEmbedEdgeScope.FrozenPublication,
                edge.OwnerPortableArticleIdentity,
                edge.Directive!,
                edge.Target!);
            if (!seen.Add(identity))
            {
                continue;
            }
            factsByIdentity.TryGetValue(
                edge.Target!.PortableArticleIdentity,
                out List<ArticleEmbedPublicationTargetFacts>? records);
            ArticleEmbedPublicationTargetFacts? facts = records is { Count: 1 } ? records[0] : null;
            edges.Add(ArticleEmbedRelationContractValidator.Seal(new ArticleEmbedRelationEdge(
                ArticleEmbedRelationSchemas.Edge,
                ArticleEmbedRelationSchemas.Version,
                identity,
                ArticleEmbedEdgeScope.FrozenPublication,
                ArticleEmbedEdgeStatus.Frozen,
                edge.OwnerPortableArticleIdentity,
                edge.OwnerRevision,
                edge.Directive!,
                edge.Target,
                edge.Coordinate!.ResolvedRevision,
                edge.LatestObservedRevision,
                facts?.Visibility ?? ArticleEmbedVisibilityStatus.Public,
                facts?.Lifecycle ?? ArticleEmbedLifecycleStatus.Published,
                facts?.Permission ?? ArticleEmbedPermissionStatus.Allowed,
                edge.Coordinate.DependencyDigest,
                string.Empty)));
            receipts.Add(ArticleEmbedRelationContractValidator.Seal(new ArticleEmbedDependencyReceipt(
                ArticleEmbedRelationSchemas.DependencyReceipt,
                ArticleEmbedRelationSchemas.Version,
                identity,
                plan.PlanDigest,
                edge.EdgeDigest,
                edge.Coordinate,
                string.Empty)));
        }

        return Accepted(
            SealSet(new ArticleEmbedRelationEdgeSet(
                ArticleEmbedRelationSchemas.EdgeSet,
                ArticleEmbedRelationSchemas.Version,
                authority.HostPortableArticleIdentity,
                authority.HostDocument,
                authority.HostCurrentRevision,
                ArticleEmbedEdgeScope.FrozenPublication,
                authority.AuthorityGeneration,
                authority.Actor,
                authority.Runtime,
                authority.MaterialLocale,
                authority.MaterialTheme,
                plan.PlanDigest,
                edges,
                string.Empty)),
            receipts);
    }

    /// <summary>
    /// Recomputes every authoring-scope edge's status against a fresh authority snapshot and emits one
    /// precise invalidation ticket per edge whose status actually changed. Frozen edge sets are rejected:
    /// publication edges never reconcile. <paramref name="previousGeneration"/> is the store's high-water
    /// mark for this host+scope family; the emitted generation is exactly one higher. Ticket cache keys
    /// name the entry the edge was stored under, derived from the set's own recorded binding.
    /// </summary>
    public static ArticleEmbedRelationReconciliation Reconcile(
        ArticleEmbedRelationEdgeSet? edgeSet,
        ArticleEmbedAuthoritySnapshot? snapshot,
        long previousGeneration)
    {
        ArticleEmbedValidationResult setCheck = ArticleEmbedRelationContractValidator.Validate(edgeSet);
        if (!setCheck.IsValid)
        {
            return RejectedReconciliation(setCheck.ReasonCode!);
        }
        var set = edgeSet!;
        if (set.Scope != ArticleEmbedEdgeScope.Authoring)
        {
            return RejectedReconciliation("article_embed_relation_scope_frozen_immutable");
        }
        ArticleEmbedValidationResult snapshotCheck =
            ArticleEmbedAuthoringContractValidator.Validate(snapshot);
        if (!snapshotCheck.IsValid)
        {
            return RejectedReconciliation(snapshotCheck.ReasonCode!);
        }
        if (previousGeneration < 0)
        {
            return RejectedReconciliation("article_embed_relation_generation_invalid");
        }

        long generation = previousGeneration + 1;
        string cacheKeyDigest = ArticleEmbedRelationDigest.ComputeCacheKey(BuildCacheKey(set));
        var factsByIdentity = snapshot!.Targets
            .GroupBy(static facts => facts.PortableArticleIdentity, StringComparer.Ordinal)
            .ToDictionary(static group => group.Key, static group => group.ToList(), StringComparer.Ordinal);
        bool hostDrift = set.HostPortableArticleIdentity != snapshot.HostPortableArticleIdentity
            || set.HostDocument != snapshot.HostDocument
            || set.HostSourceRevision != snapshot.HostSourceRevision;
        bool contextDrift = set.Actor != snapshot.Actor
            || set.Runtime != snapshot.Runtime
            || set.MaterialLocale != snapshot.MaterialLocale
            || set.MaterialTheme != snapshot.MaterialTheme;

        var edges = new List<ArticleEmbedRelationEdge>(set.Edges.Count);
        var tickets = new List<ArticleEmbedInvalidationTicket>();
        foreach (ArticleEmbedRelationEdge edge in set.Edges)
        {
            ArticleEmbedEdgeStatus next = ExpectedStatus(
                edge,
                snapshot,
                factsByIdentity,
                hostDrift,
                contextDrift,
                out ArticleEmbedInvalidationReason reason);
            ArticleEmbedRelationEdge updated = ArticleEmbedRelationContractValidator.Seal(edge with
            {
                Status = next,
                LatestObservedRevision = LatestOf(edge, factsByIdentity)
            });
            edges.Add(updated);
            if (next != edge.Status)
            {
                tickets.Add(ArticleEmbedRelationContractValidator.Seal(new ArticleEmbedInvalidationTicket(
                    ArticleEmbedRelationSchemas.InvalidationTicket,
                    ArticleEmbedRelationSchemas.Version,
                    edge.EdgeIdentity,
                    edge.Status,
                    next,
                    reason,
                    cacheKeyDigest,
                    generation,
                    string.Empty)));
            }
        }

        return new ArticleEmbedRelationReconciliation(
            true,
            null,
            SealSet(set with
            {
                HostSourceRevision = snapshot.HostSourceRevision,
                HostDocument = snapshot.HostDocument,
                HostPortableArticleIdentity = snapshot.HostPortableArticleIdentity,
                AuthorityGeneration = snapshot.AuthorityGeneration,
                Edges = edges,
                SetDigest = string.Empty
            }),
            tickets,
            generation);
    }

    /// <summary>Bounded family cache key over an authoring authority snapshot.</summary>
    public static ArticleEmbedRelationCacheKey BuildCacheKey(
        ArticleEmbedAuthoritySnapshot snapshot,
        ArticleEmbedEdgeScope scope)
        => new(
            snapshot.HostDocument.Id,
            snapshot.HostDocument.Epoch,
            snapshot.HostSourceRevision,
            scope,
            snapshot.Runtime.ProviderId,
            snapshot.Runtime.ProviderVersion,
            snapshot.Runtime.RuntimeDigest,
            snapshot.Actor.PermissionContextDigest,
            snapshot.Actor.SiteIdentity,
            snapshot.MaterialLocale,
            snapshot.MaterialTheme);

    /// <summary>Bounded family cache key over a publication authority snapshot.</summary>
    public static ArticleEmbedRelationCacheKey BuildCacheKey(
        ArticleEmbedPublicationAuthority authority,
        ArticleEmbedEdgeScope scope)
        => new(
            authority.HostDocument.Id,
            authority.HostDocument.Epoch,
            authority.HostCurrentRevision,
            scope,
            authority.Runtime.ProviderId,
            authority.Runtime.ProviderVersion,
            authority.Runtime.RuntimeDigest,
            authority.Actor.PermissionContextDigest,
            authority.Actor.SiteIdentity,
            authority.MaterialLocale,
            authority.MaterialTheme);

    /// <summary>Bounded family cache key exactly as the stored edge set recorded it.</summary>
    public static ArticleEmbedRelationCacheKey BuildCacheKey(ArticleEmbedRelationEdgeSet edgeSet)
        => new(
            edgeSet.HostDocument.Id,
            edgeSet.HostDocument.Epoch,
            edgeSet.HostSourceRevision,
            edgeSet.Scope,
            edgeSet.Runtime.ProviderId,
            edgeSet.Runtime.ProviderVersion,
            edgeSet.Runtime.RuntimeDigest,
            edgeSet.Actor.PermissionContextDigest,
            edgeSet.Actor.SiteIdentity,
            edgeSet.MaterialLocale,
            edgeSet.MaterialTheme);

    /// <summary>
    /// Closed query over one edge set. A public-delivery query admits only a frozen-publication edge set;
    /// an authoring query admits only an authoring edge set. The caller's actor and runtime must equal the
    /// recorded derivation context, so a different principal can never read the set's receipt. Scope or
    /// context mismatches fail closed with a null receipt; no hidden-edge counts are ever emitted.
    /// </summary>
    public static ArticleEmbedRelationQueryReceipt? Query(
        ArticleEmbedRelationEdgeSet? edgeSet,
        ArticleEmbedRelationQueryKind kind,
        ArticleEmbedActorContext? actor,
        ArticleEmbedRuntimeContext? runtime)
    {
        if (edgeSet is null || !ArticleEmbedRelationContractValidator.Validate(edgeSet).IsValid)
        {
            return null;
        }
        ArticleEmbedEdgeScope requiredScope = kind == ArticleEmbedRelationQueryKind.PublicDelivery
            ? ArticleEmbedEdgeScope.FrozenPublication
            : ArticleEmbedEdgeScope.Authoring;
        if (edgeSet.Scope != requiredScope
            || actor is null
            || runtime is null
            || actor != edgeSet.Actor
            || runtime != edgeSet.Runtime)
        {
            return null;
        }

        var items = edgeSet.Edges
            .Select(static edge => new ArticleEmbedRelationQueryItem(
                edge.EdgeIdentity,
                edge.OwnerPortableArticleIdentity,
                edge.OwnerRevision,
                edge.Target,
                edge.ResolvedRevision,
                edge.LatestObservedRevision,
                edge.Status,
                edge.DependencyDigest,
                edge.EdgeDigest))
            .ToArray();
        return ArticleEmbedRelationContractValidator.Seal(new ArticleEmbedRelationQueryReceipt(
            ArticleEmbedRelationSchemas.QueryReceipt,
            ArticleEmbedRelationSchemas.Version,
            kind,
            edgeSet.SetDigest,
            edgeSet.HostPortableArticleIdentity,
            edgeSet.HostDocument,
            edgeSet.HostSourceRevision,
            actor,
            runtime,
            items.Length,
            items,
            string.Empty));
    }

    private static void AppendChildren(
        List<ArticleEmbedRelationEdge> edges,
        HashSet<string> seen,
        Dictionary<string, List<ArticleEmbedTargetFacts>> factsByIdentity,
        ArticleEmbedDependencyCoordinate? ownerCoordinate,
        IReadOnlyList<ArticleEmbedResolvedNode> children)
    {
        if (ownerCoordinate is null)
        {
            return;
        }
        foreach (ArticleEmbedResolvedNode node in children)
        {
            AppendNode(
                edges,
                seen,
                factsByIdentity,
                ownerCoordinate.Target.PortableArticleIdentity,
                ownerCoordinate.ResolvedRevision,
                node.Directive,
                node.Status,
                node.Target,
                node.Coordinate);
            AppendChildren(edges, seen, factsByIdentity, node.Coordinate, node.Children);
        }
    }

    private static void AppendNode(
        List<ArticleEmbedRelationEdge> edges,
        HashSet<string> seen,
        Dictionary<string, List<ArticleEmbedTargetFacts>> factsByIdentity,
        string ownerIdentity,
        long ownerRevision,
        ArticleEmbedDirectiveProjection? directive,
        ArticleEmbedProviderResultStatus status,
        ArticleEmbedTargetIdentity? target,
        ArticleEmbedDependencyCoordinate? coordinate)
    {
        if (status != ArticleEmbedProviderResultStatus.Resolved
            || coordinate is null
            || target is null
            || directive is null)
        {
            return;
        }
        factsByIdentity.TryGetValue(target.PortableArticleIdentity, out List<ArticleEmbedTargetFacts>? records);
        ArticleEmbedTargetFacts? facts = records is { Count: 1 } ? records[0] : null;
        long latest = facts?.LatestObservedRevision ?? coordinate.ResolvedRevision;
        string identity = ArticleEmbedRelationDigest.ComputeEdgeIdentity(
            ArticleEmbedEdgeScope.Authoring,
            ownerIdentity,
            directive,
            target);
        if (!seen.Add(identity))
        {
            return;
        }
        edges.Add(ArticleEmbedRelationContractValidator.Seal(new ArticleEmbedRelationEdge(
            ArticleEmbedRelationSchemas.Edge,
            ArticleEmbedRelationSchemas.Version,
            identity,
            ArticleEmbedEdgeScope.Authoring,
            latest > coordinate.ResolvedRevision
                ? ArticleEmbedEdgeStatus.UpdateAvailable
                : ArticleEmbedEdgeStatus.Current,
            ownerIdentity,
            ownerRevision,
            directive,
            target,
            coordinate.ResolvedRevision,
            latest,
            facts?.Visibility ?? ArticleEmbedVisibilityStatus.Unknown,
            facts?.Lifecycle ?? ArticleEmbedLifecycleStatus.Unknown,
            facts?.Permission ?? ArticleEmbedPermissionStatus.Unknown,
            coordinate.DependencyDigest,
            string.Empty)));
    }

    private static ArticleEmbedEdgeStatus ExpectedStatus(
        ArticleEmbedRelationEdge edge,
        ArticleEmbedAuthoritySnapshot snapshot,
        Dictionary<string, List<ArticleEmbedTargetFacts>> factsByIdentity,
        bool hostDrift,
        bool contextDrift,
        out ArticleEmbedInvalidationReason reason)
    {
        if (hostDrift || contextDrift)
        {
            reason = ArticleEmbedInvalidationReason.HostRevisionChanged;
            return ArticleEmbedEdgeStatus.Stale;
        }
        factsByIdentity.TryGetValue(edge.Target.PortableArticleIdentity, out List<ArticleEmbedTargetFacts>? records);
        if (records is null || records.Count != 1)
        {
            reason = ArticleEmbedInvalidationReason.TargetRemoved;
            return ArticleEmbedEdgeStatus.Broken;
        }
        ArticleEmbedTargetFacts facts = records[0];
        if (facts.AuthorityGeneration != snapshot.AuthorityGeneration)
        {
            reason = ArticleEmbedInvalidationReason.AuthorityGenerationChanged;
            return ArticleEmbedEdgeStatus.Stale;
        }
        if (facts.Permission is ArticleEmbedPermissionStatus.Denied or ArticleEmbedPermissionStatus.Unknown
            || facts.Lifecycle is ArticleEmbedLifecycleStatus.Archived
                or ArticleEmbedLifecycleStatus.Deleted
                or ArticleEmbedLifecycleStatus.Unknown
            || facts.Visibility == ArticleEmbedVisibilityStatus.Unknown)
        {
            reason = ArticleEmbedInvalidationReason.TargetNonPublic;
            return ArticleEmbedEdgeStatus.Broken;
        }
        if (facts.LatestObservedRevision > edge.ResolvedRevision)
        {
            reason = ArticleEmbedInvalidationReason.TargetUpdated;
            return ArticleEmbedEdgeStatus.UpdateAvailable;
        }
        reason = ArticleEmbedInvalidationReason.TargetUpdated;
        return ArticleEmbedEdgeStatus.Current;
    }

    private static long LatestOf(
        ArticleEmbedRelationEdge edge,
        Dictionary<string, List<ArticleEmbedTargetFacts>> factsByIdentity)
        => factsByIdentity.TryGetValue(edge.Target.PortableArticleIdentity, out List<ArticleEmbedTargetFacts>? records)
            && records is { Count: 1 }
                ? records[0].LatestObservedRevision
                : edge.ResolvedRevision;

    private static ArticleEmbedRelationEdgeSet SealSet(ArticleEmbedRelationEdgeSet edgeSet)
        => ArticleEmbedRelationContractValidator.Seal(edgeSet);

    private static ArticleEmbedRelationDerivation Accepted(
        ArticleEmbedRelationEdgeSet edgeSet,
        IReadOnlyList<ArticleEmbedDependencyReceipt>? receipts = null)
        => new(true, null, edgeSet, receipts ?? []);

    private static ArticleEmbedRelationDerivation Rejected(string reasonCode)
        => new(false, reasonCode, null, []);

    private static ArticleEmbedRelationReconciliation RejectedReconciliation(string reasonCode)
        => new(false, reasonCode, null, [], 0);
}
