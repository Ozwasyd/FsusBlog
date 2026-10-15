using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Graph;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Publication;

namespace FsusBlog.Shared.Contracts.ArticleEmbeds.Relations;

/// <summary>
/// Independent verifier for relation artifacts. It re-verifies the source resolution or plan, re-derives the
/// expected edge list without calling the deriver, recomputes every digest, and checks reconciliation tickets
/// name only edges whose status truly changed. It never trusts candidate-computed fields.
/// </summary>
public static class ArticleEmbedRelationVerifier
{
    /// <summary>Verifies an authoring derivation: re-verifies the resolution, then re-walks the tree.</summary>
    public static ArticleEmbedRelationVerification VerifyFromAuthoring(
        IReadOnlyList<ArticleEmbedProviderRequest>? requests,
        ArticleEmbedAuthoritySnapshot? snapshot,
        ArticleEmbedResolutionBudgetLimits? budgets,
        ArticleEmbedAuthoringResolution? resolution,
        ArticleEmbedRelationDerivation? candidate)
        => VerifyAuthoringCore(requests, snapshot, resolution, candidate,
            ArticleEmbedAuthoringVerifier.Verify(requests, snapshot, budgets, resolution));

    /// <summary>Verifies relation edges under the explicit graph contract, with no recursive-verifier fallback.</summary>
    public static ArticleEmbedRelationVerification VerifyFromGraph(
        IReadOnlyList<ArticleEmbedProviderRequest>? requests,
        ArticleEmbedAuthoritySnapshot? snapshot,
        ArticleEmbedResolutionBudgetLimits? budgets,
        ArticleEmbedAuthoringResolution? resolution,
        ArticleEmbedRelationDerivation? candidate)
        => VerifyAuthoringCore(requests, snapshot, resolution, candidate,
            ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, budgets, resolution));

    private static ArticleEmbedRelationVerification VerifyAuthoringCore(
        IReadOnlyList<ArticleEmbedProviderRequest>? requests,
        ArticleEmbedAuthoritySnapshot? snapshot,
        ArticleEmbedAuthoringResolution? resolution,
        ArticleEmbedRelationDerivation? candidate,
        ArticleEmbedAuthoringVerification sourceCheck)
    {
        var reasons = new List<string>();
        bool expectAccept = sourceCheck.Valid
            && resolution is not null
            && resolution.Status == ArticleEmbedAuthoringResolutionStatus.Completed;
        if (candidate is null)
        {
            reasons.Add("derivation_missing");
            return Finish(reasons);
        }
        if (candidate.Accepted != expectAccept)
        {
            reasons.Add("derivation_acceptance_mismatch");
            return Finish(reasons);
        }
        if (!expectAccept)
        {
            if (candidate.EdgeSet is not null
                || candidate.RejectedReasonCode is null
                || candidate.DependencyReceipts.Count != 0)
            {
                reasons.Add("rejected_derivation_carries_edges");
            }
            return Finish(reasons);
        }
        if (candidate.EdgeSet is null || candidate.DependencyReceipts.Count != 0)
        {
            reasons.Add("derivation_shape_invalid");
            return Finish(reasons);
        }
        ArticleEmbedValidationResult setCheck =
            ArticleEmbedRelationContractValidator.Validate(candidate.EdgeSet);
        if (!setCheck.IsValid)
        {
            reasons.Add(setCheck.ReasonCode!);
            return Finish(reasons);
        }

        var factsByIdentity = snapshot!.Targets
            .GroupBy(static facts => facts.PortableArticleIdentity, StringComparer.Ordinal)
            .ToDictionary(static group => group.Key, static group => group.ToList(), StringComparer.Ordinal);
        var requestsById = requests!
            .ToDictionary(static request => request.RequestId, StringComparer.Ordinal);

        var expected = new List<ExpectedEdge>();
        var seen = new HashSet<string>(StringComparer.Ordinal);
        foreach (ArticleEmbedAuthoringEmbedResult result in resolution!.Results)
        {
            if (!requestsById.TryGetValue(result.RequestId, out ArticleEmbedProviderRequest? request))
            {
                reasons.Add("request_binding_missing");
                return Finish(reasons);
            }
            ExpectNode(
                expected,
                seen,
                factsByIdentity,
                snapshot.HostPortableArticleIdentity,
                snapshot.HostSourceRevision,
                request.Directive,
                result.Result.Status,
                request.Target,
                result.Result.Coordinate);
            ExpectChildren(
                expected,
                seen,
                factsByIdentity,
                result.Result.Coordinate,
                result.Children);
        }
        CompareEdgeSet(
            candidate.EdgeSet,
            expected,
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
            reasons);
        return Finish(reasons);
    }

    /// <summary>Verifies a frozen derivation: re-verifies the plan, then re-projects every frozen edge.</summary>
    public static ArticleEmbedRelationVerification VerifyFromPlan(
        IReadOnlyList<ArticleEmbedProviderRequest>? requests,
        ArticleEmbedPublicationAuthority? authority,
        ArticleEmbedResolutionBudgetLimits? budgets,
        ArticleEmbedPublicationPlan? plan,
        ArticleEmbedRelationDerivation? candidate)
    {
        var reasons = new List<string>();
        ArticleEmbedPublicationVerification sourceCheck =
            ArticleEmbedPublicationVerifier.Verify(requests, authority, budgets, plan);
        bool expectAccept = sourceCheck.Valid
            && plan is not null
            && plan.Status == ArticleEmbedPublicationPlanStatus.Sealed;
        if (candidate is null)
        {
            reasons.Add("derivation_missing");
            return Finish(reasons);
        }
        if (candidate.Accepted != expectAccept)
        {
            reasons.Add("derivation_acceptance_mismatch");
            return Finish(reasons);
        }
        if (!expectAccept)
        {
            if (candidate.EdgeSet is not null
                || candidate.RejectedReasonCode is null
                || candidate.DependencyReceipts.Count != 0)
            {
                reasons.Add("rejected_derivation_carries_edges");
            }
            return Finish(reasons);
        }
        if (candidate.EdgeSet is null)
        {
            reasons.Add("derivation_shape_invalid");
            return Finish(reasons);
        }
        ArticleEmbedValidationResult setCheck =
            ArticleEmbedRelationContractValidator.Validate(candidate.EdgeSet);
        if (!setCheck.IsValid)
        {
            reasons.Add(setCheck.ReasonCode!);
            return Finish(reasons);
        }

        var factsByIdentity = authority!.Targets
            .GroupBy(static facts => facts.PortableArticleIdentity, StringComparer.Ordinal)
            .ToDictionary(static group => group.Key, static group => group.ToList(), StringComparer.Ordinal);

        var expected = new List<ExpectedEdge>(plan!.Edges.Count);
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var frozenEdges = new List<ArticleEmbedPublicationEdge>(plan.Edges.Count);
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
            expected.Add(new ExpectedEdge(
                identity,
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
                edge.Coordinate.DependencyDigest));
            frozenEdges.Add(edge);
        }

        CompareEdgeSet(
            candidate.EdgeSet,
            expected,
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
            reasons);

        if (candidate.DependencyReceipts.Count != frozenEdges.Count)
        {
            reasons.Add("dependency_receipt_count_mismatch");
        }
        else
        {
            for (int index = 0; index < frozenEdges.Count; index++)
            {
                ArticleEmbedDependencyReceipt receipt = candidate.DependencyReceipts[index];
                ArticleEmbedPublicationEdge edge = frozenEdges[index];
                if (ArticleEmbedRelationContractValidator.Validate(receipt) is { IsValid: false }
                    || receipt.EdgeIdentity != expected[index].Identity
                    || receipt.PlanDigest != plan.PlanDigest
                    || receipt.PublicationEdgeDigest != edge.EdgeDigest
                    || receipt.Coordinate != edge.Coordinate)
                {
                    reasons.Add($"dependency_receipt_mismatch:{index}");
                }
            }
        }
        return Finish(reasons);
    }

    /// <summary>
    /// Verifies a reconciliation: recomputes each edge's expected next status independently, requires tickets
    /// exactly on the changed edges, a monotone generation and a re-sealed updated set.
    /// </summary>
    public static ArticleEmbedRelationVerification VerifyReconciliation(
        ArticleEmbedRelationEdgeSet? previousSet,
        ArticleEmbedAuthoritySnapshot? snapshot,
        long previousGeneration,
        ArticleEmbedRelationReconciliation? candidate)
    {
        var reasons = new List<string>();
        bool setValid = previousSet is not null
            && ArticleEmbedRelationContractValidator.Validate(previousSet).IsValid;
        bool snapshotValid = snapshot is not null
            && ArticleEmbedAuthoringContractValidator.Validate(snapshot).IsValid;
        bool scopeOk = setValid && previousSet!.Scope == ArticleEmbedEdgeScope.Authoring;
        bool generationOk = previousGeneration >= 0;
        bool expectAccept = setValid && snapshotValid && scopeOk && generationOk;
        if (candidate is null)
        {
            reasons.Add("reconciliation_missing");
            return Finish(reasons);
        }
        if (candidate.Accepted != expectAccept)
        {
            reasons.Add("reconciliation_acceptance_mismatch");
            return Finish(reasons);
        }
        if (!expectAccept)
        {
            if (candidate.EdgeSet is not null
                || candidate.RejectedReasonCode is null
                || candidate.Tickets.Count != 0
                || candidate.ReconcileGeneration != 0)
            {
                reasons.Add("rejected_reconciliation_carries_state");
            }
            return Finish(reasons);
        }
        if (candidate.EdgeSet is null
            || candidate.ReconcileGeneration != previousGeneration + 1)
        {
            reasons.Add("reconciliation_shape_invalid");
            return Finish(reasons);
        }
        if (ArticleEmbedRelationContractValidator.Validate(candidate.EdgeSet) is { IsValid: false } check)
        {
            reasons.Add(check.ReasonCode!);
            return Finish(reasons);
        }

        var factsByIdentity = snapshot!.Targets
            .GroupBy(static facts => facts.PortableArticleIdentity, StringComparer.Ordinal)
            .ToDictionary(static group => group.Key, static group => group.ToList(), StringComparer.Ordinal);
        bool hostDrift = previousSet!.HostPortableArticleIdentity != snapshot.HostPortableArticleIdentity
            || previousSet.HostDocument != snapshot.HostDocument
            || previousSet.HostSourceRevision != snapshot.HostSourceRevision;
        bool contextDrift = previousSet.Actor != snapshot.Actor
            || previousSet.Runtime != snapshot.Runtime
            || previousSet.MaterialLocale != snapshot.MaterialLocale
            || previousSet.MaterialTheme != snapshot.MaterialTheme;
        string cacheKeyDigest = ArticleEmbedRelationDigest.ComputeCacheKey(
            ArticleEmbedRelationDeriver.BuildCacheKey(previousSet));

        if (candidate.EdgeSet.Edges.Count != previousSet.Edges.Count)
        {
            reasons.Add("reconciled_edge_count_mismatch");
            return Finish(reasons);
        }
        var expectedTickets = new List<(string Identity, ArticleEmbedEdgeStatus From, ArticleEmbedEdgeStatus To, ArticleEmbedInvalidationReason Reason)>();
        for (int index = 0; index < previousSet.Edges.Count; index++)
        {
            ArticleEmbedRelationEdge before = previousSet.Edges[index];
            ArticleEmbedRelationEdge after = candidate.EdgeSet.Edges[index];
            ArticleEmbedEdgeStatus next = ExpectedStatus(
                before,
                snapshot,
                factsByIdentity,
                hostDrift,
                contextDrift,
                out ArticleEmbedInvalidationReason reason);
            if (after.EdgeIdentity != before.EdgeIdentity
                || after.Status != next
                || after.LatestObservedRevision != LatestOf(before, factsByIdentity)
                || after != before with
                {
                    Status = next,
                    LatestObservedRevision = LatestOf(before, factsByIdentity),
                    EdgeDigest = after.EdgeDigest
                })
            {
                reasons.Add($"reconciled_edge_mismatch:{index}");
            }
            if (next != before.Status)
            {
                expectedTickets.Add((before.EdgeIdentity, before.Status, next, reason));
            }
        }
        if (candidate.Tickets.Count != expectedTickets.Count)
        {
            reasons.Add("ticket_count_mismatch");
        }
        else
        {
            for (int index = 0; index < expectedTickets.Count; index++)
            {
                ArticleEmbedInvalidationTicket ticket = candidate.Tickets[index];
                var expected = expectedTickets[index];
                if (ArticleEmbedRelationContractValidator.Validate(ticket) is { IsValid: false }
                    || ticket.EdgeIdentity != expected.Identity
                    || ticket.FromStatus != expected.From
                    || ticket.ToStatus != expected.To
                    || ticket.Reason != expected.Reason
                    || ticket.CacheKeyDigest != cacheKeyDigest
                    || ticket.ReconcileGeneration != previousGeneration + 1)
                {
                    reasons.Add($"ticket_mismatch:{index}");
                }
            }
        }
        if (candidate.EdgeSet.HostSourceRevision != snapshot.HostSourceRevision
            || candidate.EdgeSet.HostDocument != snapshot.HostDocument
            || candidate.EdgeSet.AuthorityGeneration != snapshot.AuthorityGeneration)
        {
            reasons.Add("reconciled_set_binding_mismatch");
        }
        return Finish(reasons);
    }

    /// <summary>Verifies a query receipt against the stored edge set and the caller context.</summary>
    public static ArticleEmbedRelationVerification VerifyQuery(
        ArticleEmbedRelationEdgeSet? edgeSet,
        ArticleEmbedRelationQueryKind kind,
        ArticleEmbedActorContext? actor,
        ArticleEmbedRuntimeContext? runtime,
        ArticleEmbedRelationQueryReceipt? candidate)
    {
        var reasons = new List<string>();
        bool setValid = edgeSet is not null
            && ArticleEmbedRelationContractValidator.Validate(edgeSet).IsValid;
        ArticleEmbedEdgeScope requiredScope = kind == ArticleEmbedRelationQueryKind.PublicDelivery
            ? ArticleEmbedEdgeScope.FrozenPublication
            : ArticleEmbedEdgeScope.Authoring;
        bool expectReceipt = setValid
            && edgeSet!.Scope == requiredScope
            && actor is not null
            && runtime is not null
            && actor == edgeSet.Actor
            && runtime == edgeSet.Runtime;
        if (candidate is null)
        {
            if (expectReceipt)
            {
                reasons.Add("query_receipt_missing");
            }
            return Finish(reasons);
        }
        if (!expectReceipt)
        {
            reasons.Add("query_receipt_unexpected");
            return Finish(reasons);
        }
        if (ArticleEmbedRelationContractValidator.Validate(candidate) is { IsValid: false } check)
        {
            reasons.Add(check.ReasonCode!);
            return Finish(reasons);
        }
        var set = edgeSet!;
        if (candidate!.Kind != kind
            || candidate.SetDigest != set.SetDigest
            || candidate.HostPortableArticleIdentity != set.HostPortableArticleIdentity
            || candidate.HostDocument != set.HostDocument
            || candidate.HostSourceRevision != set.HostSourceRevision
            || candidate.Actor != set.Actor
            || candidate.Runtime != set.Runtime)
        {
            reasons.Add("query_receipt_binding_mismatch");
        }
        if (candidate.Items.Count != set.Edges.Count)
        {
            reasons.Add("query_item_count_mismatch");
            return Finish(reasons);
        }
        for (int index = 0; index < set.Edges.Count; index++)
        {
            ArticleEmbedRelationEdge edge = set.Edges[index];
            ArticleEmbedRelationQueryItem item = candidate.Items[index];
            if (item.EdgeIdentity != edge.EdgeIdentity
                || item.OwnerPortableArticleIdentity != edge.OwnerPortableArticleIdentity
                || item.OwnerRevision != edge.OwnerRevision
                || item.Target != edge.Target
                || item.ResolvedRevision != edge.ResolvedRevision
                || item.LatestObservedRevision != edge.LatestObservedRevision
                || item.Status != edge.Status
                || item.DependencyDigest != edge.DependencyDigest
                || item.EdgeDigest != edge.EdgeDigest)
            {
                reasons.Add($"query_item_mismatch:{index}");
            }
        }
        return Finish(reasons);
    }

    private static void ExpectChildren(
        List<ExpectedEdge> expected,
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
            ExpectNode(
                expected,
                seen,
                factsByIdentity,
                ownerCoordinate.Target.PortableArticleIdentity,
                ownerCoordinate.ResolvedRevision,
                node.Directive,
                node.Status,
                node.Target,
                node.Coordinate);
            ExpectChildren(expected, seen, factsByIdentity, node.Coordinate, node.Children);
        }
    }

    private static void ExpectNode(
        List<ExpectedEdge> expected,
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
        expected.Add(new ExpectedEdge(
            identity,
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
            coordinate.DependencyDigest));
    }

    private static void CompareEdgeSet(
        ArticleEmbedRelationEdgeSet candidate,
        List<ExpectedEdge> expected,
        string hostIdentity,
        ArticleEmbedDocumentIdentity hostDocument,
        long hostRevision,
        ArticleEmbedEdgeScope scope,
        long generation,
        ArticleEmbedActorContext actor,
        ArticleEmbedRuntimeContext runtime,
        string? locale,
        string? theme,
        string sourceDigest,
        List<string> reasons)
    {
        if (candidate.HostPortableArticleIdentity != hostIdentity
            || candidate.HostDocument != hostDocument
            || candidate.HostSourceRevision != hostRevision
            || candidate.Scope != scope
            || candidate.AuthorityGeneration != generation
            || candidate.Actor != actor
            || candidate.Runtime != runtime
            || candidate.MaterialLocale != locale
            || candidate.MaterialTheme != theme
            || candidate.SourceArtifactDigest != sourceDigest)
        {
            reasons.Add("edge_set_binding_mismatch");
        }
        if (candidate.Edges.Count != expected.Count)
        {
            reasons.Add("edge_count_mismatch");
            return;
        }
        for (int index = 0; index < expected.Count; index++)
        {
            ArticleEmbedRelationEdge actual = candidate.Edges[index];
            ExpectedEdge exp = expected[index];
            if (actual.EdgeIdentity != exp.Identity
                || actual.Status != exp.Status
                || actual.OwnerPortableArticleIdentity != exp.OwnerIdentity
                || actual.OwnerRevision != exp.OwnerRevision
                || actual.Directive != exp.Directive
                || actual.Target != exp.Target
                || actual.ResolvedRevision != exp.ResolvedRevision
                || actual.LatestObservedRevision != exp.LatestObservedRevision
                || actual.Visibility != exp.Visibility
                || actual.Lifecycle != exp.Lifecycle
                || actual.Permission != exp.Permission
                || actual.DependencyDigest != exp.DependencyDigest)
            {
                reasons.Add($"edge_mismatch:{index}");
            }
        }
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

    private static ArticleEmbedRelationVerification Finish(List<string> reasons)
    {
        var verification = new ArticleEmbedRelationVerification(reasons.Count == 0, reasons, string.Empty);
        return verification with
        {
            VerificationDigest = ArticleEmbedContractDigest.Compute(writer =>
            {
                writer.Add(verification.Valid);
                writer.Add(verification.ReasonCodes.Count);
                foreach (string reason in verification.ReasonCodes)
                {
                    writer.Add(reason);
                }
            })
        };
    }

    private sealed record ExpectedEdge(
        string Identity,
        ArticleEmbedEdgeStatus Status,
        string OwnerIdentity,
        long OwnerRevision,
        ArticleEmbedDirectiveProjection Directive,
        ArticleEmbedTargetIdentity Target,
        long ResolvedRevision,
        long LatestObservedRevision,
        ArticleEmbedVisibilityStatus Visibility,
        ArticleEmbedLifecycleStatus Lifecycle,
        ArticleEmbedPermissionStatus Permission,
        string DependencyDigest);
}
