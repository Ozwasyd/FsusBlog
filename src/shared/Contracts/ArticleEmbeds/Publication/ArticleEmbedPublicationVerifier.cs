using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;

namespace FsusBlog.Shared.Contracts.ArticleEmbeds.Publication;

/// <summary>
/// Independent publication-plan verifier. It re-derives the expected edge graph from the sealed authority snapshot
/// and the canonical requests, re-walks cycle/budget/memoization legitimacy, recomputes every edge, graph, receipt
/// and plan digest, and never calls the planner or trusts candidate-computed fields. Failures whose timing is not
/// reproducible (elapsed clock, mid-plan abort) are accepted only when they legitimately preempt the expected stage.
/// </summary>
public static class ArticleEmbedPublicationVerifier
{
    public static ArticleEmbedPublicationVerification Verify(
        IReadOnlyList<ArticleEmbedProviderRequest>? requests,
        ArticleEmbedPublicationAuthority? authority,
        ArticleEmbedResolutionBudgetLimits? budgets,
        ArticleEmbedPublicationPlan? candidate)
    {
        var reasons = new List<string>();
        if (candidate is null)
        {
            reasons.Add("plan_missing");
            return Finish(reasons);
        }

        ArticleEmbedValidationResult structure = ArticleEmbedPublicationContractValidator.Validate(candidate);
        if (!structure.IsValid)
        {
            reasons.Add(structure.ReasonCode!);
            return Finish(reasons);
        }

        ArticleEmbedValidationResult budgetCheck = ArticleEmbedAuthoringContractValidator.ValidateBudgets(budgets);
        ArticleEmbedValidationResult authorityCheck = ArticleEmbedPublicationContractValidator.Validate(authority);
        string? expectedRejection = !budgetCheck.IsValid
            ? budgetCheck.ReasonCode!
            : !authorityCheck.IsValid
                ? authorityCheck.ReasonCode!
                : !authority!.FrozenArtifactRetention
                    ? "frozen_artifact_retention_unavailable"
                    : requests is null
                        ? "article_embed_publication_requests_missing"
                        : requests.Count > budgets!.MaxExpandedNodes
                            ? "article_embed_publication_request_set_exceeds_budget"
                            : null;
        if (expectedRejection is not null)
        {
            if (candidate.Status != ArticleEmbedPublicationPlanStatus.Blocked
                || candidate.BlockedReasonCode != expectedRejection
                || candidate.Edges.Count != 0)
            {
                reasons.Add("blocked_plan_mismatch");
            }
            VerifyReceiptBinding(candidate.Receipt, authority, budgets, requests, reasons);
            VerifyDigests(candidate, reasons);
            return Finish(reasons);
        }

        VerifyReceiptBinding(candidate.Receipt, authority, budgets, requests, reasons);
        VerifyPlanShape(candidate, reasons);
        VerifyDigests(candidate, reasons);

        var context = new ExpectedContext(authority!, budgets!);
        var expectedEdges = new List<ExpectedEdge>(requests!.Count);
        foreach (ArticleEmbedProviderRequest request in requests)
        {
            ExpectEdge(
                context,
                request,
                authority!.HostPortableArticleIdentity,
                authority.HostCurrentRevision,
                request.Directive,
                request.Target,
                depth: 1,
                path: new HashSet<NodeKey> { new(authority.HostPortableArticleIdentity, ArticleEmbedTargetKind.Article, null, null) },
                topLevel: true,
                expectedEdges);
        }

        bool preempted = false;
        int index = 0;
        while (index < candidate.Edges.Count && index < expectedEdges.Count)
        {
            ExpectedEdge expected = expectedEdges[index];
            ArticleEmbedPublicationEdge actual = candidate.Edges[index];
            if (actual.OwnerPortableArticleIdentity != expected.OwnerIdentity
                || actual.OwnerRevision != expected.OwnerRevision
                || actual.Directive != expected.Directive
                || actual.Target != expected.Target
                || actual.Depth != expected.Depth)
            {
                reasons.Add($"edge_mismatch:{index}");
                index++;
                continue;
            }

            bool outcomeMatch = OutcomeMatches(actual, expected);
            if (!outcomeMatch && LegitimatePreemption(actual, expected))
            {
                preempted = true;
                if (expected.Status == ArticleEmbedPublicationEdgeStatus.Frozen)
                {
                    index = SkipExpectedSubtree(expectedEdges, index);
                }
                index++;
                continue;
            }
            if (!outcomeMatch)
            {
                reasons.Add($"edge_outcome_mismatch:{index}");
            }
            index++;
        }
        if (index < candidate.Edges.Count
            || (!preempted && candidate.Edges.Count != expectedEdges.Count)
            || (preempted && candidate.Edges.Count > expectedEdges.Count))
        {
            reasons.Add("edge_count_mismatch");
        }

        VerifyObserved(candidate, context.Meter, preempted, reasons);
        VerifyItems(candidate, requests, reasons);
        return Finish(reasons);
    }

    private static bool OutcomeMatches(ArticleEmbedPublicationEdge actual, ExpectedEdge expected)
    {
        if (actual.Status != expected.Status
            || actual.LatestObservedRevision != expected.LatestObservedRevision)
        {
            return false;
        }
        if (expected.Status == ArticleEmbedPublicationEdgeStatus.Frozen)
        {
            return actual.Coordinate is not null
                && actual.Coordinate.Target == expected.Target
                && actual.Coordinate.ResolvedRevision == expected.Facts!.ResolvedPublicRevision
                && actual.Coordinate.TargetVersionIdentity == expected.Facts.TargetVersionIdentity
                && actual.Coordinate.ProjectionIdentity == expected.Projection!.ProjectionIdentity
                && actual.Coordinate.ProjectionDigest == expected.Projection.ContentDigest
                && actual.Coordinate.DependencyDigest.Length > 0
                && actual.Error is null;
        }
        return actual.Coordinate is null
            && actual.Error is not null
            && actual.Error.Code == expected.Error!.Code
            && actual.Error.SafeReasonCode == expected.Error.SafeReasonCode;
    }

    /// <summary>
    /// Elapsed-clock and mid-plan abort outcomes are not reproducible by the verifier; they are legitimate only
    /// where the planner's check order could have produced them ahead of the expected outcome.
    /// </summary>
    private static bool LegitimatePreemption(ArticleEmbedPublicationEdge actual, ExpectedEdge expected)
    {
        if (actual.Status != ArticleEmbedPublicationEdgeStatus.Blocked
            || actual.Coordinate is not null
            || actual.LatestObservedRevision != 0
            || actual.Error is null)
        {
            return false;
        }
        string? expectedReason = expected.Error?.SafeReasonCode;
        if (actual.Error.Code == ArticleEmbedErrorCode.StaleSource
            && actual.Error.SafeReasonCode == "request_aborted")
        {
            // The abort check precedes binding, decode, budget, cycle, memo and fact stages; only the top-level
            // contract/scope validation and bypassed nested-invalid emission run earlier.
            return expectedReason is not "request_contract_invalid"
                and not "publication_scope_required"
                and not "nested_target_invalid";
        }
        if (actual.Error.Code == ArticleEmbedErrorCode.TimeExceeded
            && actual.Error.SafeReasonCode == "elapsed_exceeded")
        {
            // The elapsed check runs after request/binding/decode/node/depth checks and before cycle/memo/facts.
            return expected.Status == ArticleEmbedPublicationEdgeStatus.Frozen
                || expectedReason is "embed_cycle"
                    or "authority_messages_exceeded"
                    or "target_missing"
                    or "target_ambiguous"
                    or "authority_generation_drift"
                    or "site_mismatch"
                    or "permission_denied"
                    or "permission_unknown"
                    or "target_draft"
                    or "target_scheduled_not_public"
                    or "target_archived"
                    or "target_deleted"
                    or "lifecycle_unknown"
                    or "target_private"
                    or "visibility_unknown"
                    or "target_revision_incomplete"
                    or "source_bytes_exceeded"
                    or "heading_missing"
                    or "heading_duplicate"
                    or "block_missing"
                    or "block_duplicate";
        }
        return false;
    }

    /// <summary>Advances past the expected descendants of a frozen edge whose expansion was preempted.</summary>
    private static int SkipExpectedSubtree(IReadOnlyList<ExpectedEdge> edges, int index)
    {
        int depth = edges[index].Depth;
        int next = index + 1;
        while (next < edges.Count && edges[next].Depth > depth)
        {
            next++;
        }
        return next - 1;
    }

    private static void VerifyReceiptBinding(
        ArticleEmbedPublicationReceipt receipt,
        ArticleEmbedPublicationAuthority? authority,
        ArticleEmbedResolutionBudgetLimits? budgets,
        IReadOnlyList<ArticleEmbedProviderRequest>? requests,
        List<string> reasons)
    {
        if (receipt.Schema != ArticleEmbedPublicationSchemas.Receipt
            || receipt.SchemaVersion != ArticleEmbedPublicationSchemas.Version
            || receipt.HostPortableArticleIdentity != (authority?.HostPortableArticleIdentity ?? "rejected:unknown")
            || receipt.HostDocument != (authority?.HostDocument ?? receipt.HostDocument)
            || receipt.HostCurrentRevision != (authority?.HostCurrentRevision ?? 0)
            || receipt.HostSourceDigest != (authority?.HostSourceDigest ?? receipt.HostSourceDigest)
            || receipt.PublicationRequestId != (authority?.PublicationRequestId ?? "rejected:unknown")
            || receipt.ExpectedRevision != (authority?.ExpectedRevision ?? 0)
            || receipt.AuthorityGeneration != (authority?.AuthorityGeneration ?? 0)
            || receipt.AuthorityDigest != (authority?.AuthorityDigest ?? receipt.AuthorityDigest)
            || receipt.Actor != (authority?.Actor ?? receipt.Actor)
            || receipt.Runtime != (authority?.Runtime ?? receipt.Runtime)
            || receipt.MaterialLocale != authority?.MaterialLocale
            || receipt.MaterialTheme != authority?.MaterialTheme
            || (budgets is not null && receipt.Budgets != budgets)
            || receipt.RequestCount != (requests?.Count ?? 0)
            || receipt.FrozenEdgeCount < 0
            || receipt.BlockedEdgeCount < 0
            || receipt.MaxObservedDepth < 0
            || receipt.Observed.Depth < 0
            || receipt.Observed.Nodes < 0
            || receipt.Observed.Bytes < 0
            || receipt.Observed.ElapsedMilliseconds < 0)
        {
            reasons.Add("receipt_binding_invalid");
        }
    }

    private static void VerifyPlanShape(ArticleEmbedPublicationPlan plan, List<string> reasons)
    {
        int frozen = plan.Edges.Count(static edge => edge.Status == ArticleEmbedPublicationEdgeStatus.Frozen);
        int blocked = plan.Edges.Count - frozen;
        if (plan.Status != (blocked == 0
                ? ArticleEmbedPublicationPlanStatus.Sealed
                : ArticleEmbedPublicationPlanStatus.Blocked))
        {
            reasons.Add("plan_status_mismatch");
        }
        if (plan.Status == ArticleEmbedPublicationPlanStatus.Blocked
            && plan.BlockedReasonCode != plan.Edges
                .FirstOrDefault(static edge => edge.Status == ArticleEmbedPublicationEdgeStatus.Blocked)
                ?.Error?.SafeReasonCode)
        {
            reasons.Add("blocked_reason_mismatch");
        }
        if (plan.Receipt.FrozenEdgeCount != frozen || plan.Receipt.BlockedEdgeCount != blocked)
        {
            reasons.Add("receipt_edge_counts_mismatch");
        }
        if (plan.Receipt.MaxObservedDepth != plan.Receipt.Observed.Depth)
        {
            reasons.Add("receipt_depth_mismatch");
        }
    }

    /// <summary>Recomputes edge, graph, receipt and plan digests over the candidate's own fields.</summary>
    private static void VerifyDigests(ArticleEmbedPublicationPlan plan, List<string> reasons)
    {
        foreach (ArticleEmbedPublicationEdge edge in plan.Edges)
        {
            if (edge.EdgeDigest != ArticleEmbedPublicationContractValidator.Seal(edge).EdgeDigest)
            {
                reasons.Add("edge_digest_mismatch");
                return;
            }
        }
        if (plan.Receipt.GraphDigest != ArticleEmbedPublicationDigest.ComputeGraph(plan.Edges))
        {
            reasons.Add("graph_digest_mismatch");
        }
        string expectedReceiptDigest = ArticleEmbedPublicationDigest.ComputeReceipt(plan.Receipt with
        {
            ReceiptDigest = string.Empty
        });
        string expectedPlanDigest = ArticleEmbedPublicationDigest.ComputePlan(plan with
        {
            PlanDigest = string.Empty
        });
        if (expectedReceiptDigest != plan.Receipt.ReceiptDigest
            || expectedPlanDigest != plan.PlanDigest)
        {
            reasons.Add("plan_digest_mismatch");
        }
    }

    /// <summary>Observed meters that stay exact under preemption are checked always; byte totals are not.</summary>
    private static void VerifyObserved(
        ArticleEmbedPublicationPlan plan,
        ExpectedMeter meter,
        bool preempted,
        List<string> reasons)
    {
        if (plan.Receipt.Observed.Nodes != plan.Edges.Count)
        {
            reasons.Add("observed_nodes_mismatch");
        }
        int maxDepth = plan.Edges.Count == 0 ? 0 : plan.Edges.Max(static edge => edge.Depth);
        if (plan.Receipt.Observed.Depth != maxDepth)
        {
            reasons.Add("observed_depth_mismatch");
        }
        if (!preempted && plan.Receipt.Observed.Bytes != meter.Bytes)
        {
            reasons.Add("observed_bytes_mismatch");
        }
    }

    /// <summary>
    /// Every request emits exactly one depth-1 edge, so depth-1 edges partition the flat list; receipt items are
    /// re-derived from the request list and the candidate's own edge ranges without trusting stored counts.
    /// </summary>
    private static void VerifyItems(
        ArticleEmbedPublicationPlan plan,
        IReadOnlyList<ArticleEmbedProviderRequest> requests,
        List<string> reasons)
    {
        var topIndexes = new List<int>(requests.Count);
        for (int edgeIndex = 0; edgeIndex < plan.Edges.Count; edgeIndex++)
        {
            if (plan.Edges[edgeIndex].Depth == 1)
            {
                topIndexes.Add(edgeIndex);
            }
        }
        if (topIndexes.Count != requests.Count || plan.Receipt.Items.Count != requests.Count)
        {
            reasons.Add("receipt_item_count_mismatch");
            return;
        }
        for (int itemIndex = 0; itemIndex < requests.Count; itemIndex++)
        {
            int start = topIndexes[itemIndex];
            int end = itemIndex + 1 < topIndexes.Count ? topIndexes[itemIndex + 1] : plan.Edges.Count;
            ArticleEmbedPublicationEdge top = plan.Edges[start];
            ArticleEmbedPublicationReceiptItem item = plan.Receipt.Items[itemIndex];
            int blockedDescendants = 0;
            for (int edgeIndex = start + 1; edgeIndex < end; edgeIndex++)
            {
                if (plan.Edges[edgeIndex].Status == ArticleEmbedPublicationEdgeStatus.Blocked)
                {
                    blockedDescendants++;
                }
            }
            if (item.RequestId != requests[itemIndex].RequestId
                || item.Target != requests[itemIndex].Target
                || item.Status != top.Status
                || item.ErrorCode != top.Error?.Code
                || item.ResolvedRevision != top.Coordinate?.ResolvedRevision
                || item.DescendantEdgeCount != end - start - 1
                || item.BlockedDescendantCount != blockedDescendants
                || item.EdgeDigest != top.EdgeDigest)
            {
                reasons.Add($"receipt_item_mismatch:{itemIndex}");
            }
        }
    }

    private static ExpectedOutcome ExpectEdge(
        ExpectedContext context,
        ArticleEmbedProviderRequest? request,
        string ownerIdentity,
        long ownerRevision,
        ArticleEmbedDirectiveProjection? directive,
        ArticleEmbedTargetIdentity? target,
        int depth,
        HashSet<NodeKey> path,
        bool topLevel,
        List<ExpectedEdge> edges)
    {
        context.Meter.ObserveNode();
        context.Meter.ObserveDepth(depth);

        ArticleEmbedError? failure = null;
        if (request is not null)
        {
            if (topLevel)
            {
                ArticleEmbedValidationResult requestCheck = ArticleEmbedContractValidator.Validate(request);
                if (!requestCheck.IsValid)
                {
                    failure = new ArticleEmbedError(ArticleEmbedErrorCode.InvalidTarget, "request_contract_invalid");
                }
                else if (request.RequestedScope != ArticleEmbedRequestedScope.PublicationPlan)
                {
                    failure = new ArticleEmbedError(ArticleEmbedErrorCode.InvalidTarget, "publication_scope_required");
                }
            }
            if (failure is null && request.AbortSignal.IsCancellationRequested)
            {
                failure = new ArticleEmbedError(ArticleEmbedErrorCode.StaleSource, "request_aborted");
            }
            if (failure is null && topLevel)
            {
                failure = ExpectBinding(request, context.Authority);
            }
        }
        if (failure is null && directive is null)
        {
            failure = new ArticleEmbedError(ArticleEmbedErrorCode.InvalidTarget, "directive_missing");
        }
        if (failure is null && target is null)
        {
            failure = new ArticleEmbedError(ArticleEmbedErrorCode.InvalidTarget, "target_missing_identity");
        }
        if (failure is null && directive is not null && target is not null)
        {
            ArticleEmbedTargetIdentity? decoded = null;
            if (!Enum.IsDefined(directive.Mode)
                || !ArticleEmbedTargetCodec.TryDecode(directive.TargetToken, directive.Mode, out decoded).IsValid
                || decoded is null
                || decoded != target)
            {
                failure = new ArticleEmbedError(ArticleEmbedErrorCode.InvalidTarget, "directive_target_mismatch");
            }
        }
        if (failure is not null)
        {
            return EmitBlocked(edges, ownerIdentity, ownerRevision, directive, target, depth, failure);
        }

        if (context.Meter.Nodes > context.Budgets.MaxExpandedNodes)
        {
            return EmitBlocked(edges, ownerIdentity, ownerRevision, directive, target, depth,
                new ArticleEmbedError(ArticleEmbedErrorCode.SizeExceeded, "expanded_nodes_exceeded"));
        }
        if (depth > context.Budgets.MaxDepth)
        {
            return EmitBlocked(edges, ownerIdentity, ownerRevision, directive, target, depth,
                new ArticleEmbedError(ArticleEmbedErrorCode.DepthExceeded, "depth_exceeded"));
        }

        var key = new NodeKey(target!.PortableArticleIdentity, target.Kind, target.HeadingIdentity, target.BlockAnchor);
        if (path.Contains(key))
        {
            return EmitBlocked(edges, ownerIdentity, ownerRevision, directive, target, depth,
                new ArticleEmbedError(ArticleEmbedErrorCode.Cycle, "embed_cycle"));
        }
        if (context.Memo.TryGetValue(key, out ExpectedOutcome? cached))
        {
            return Emit(edges, ownerIdentity, ownerRevision, directive!, target, depth, cached);
        }

        context.Meter.ObserveMessage();
        if (context.Meter.Messages > context.Budgets.MaxAuthorityMessages)
        {
            return EmitBlocked(edges, ownerIdentity, ownerRevision, directive, target, depth,
                new ArticleEmbedError(ArticleEmbedErrorCode.SizeExceeded, "authority_messages_exceeded"));
        }

        context.FactsByIdentity.TryGetValue(
            target.PortableArticleIdentity,
            out List<ArticleEmbedPublicationTargetFacts>? records);
        if (records is null || records.Count == 0)
        {
            return EmitMemoized(edges, context, ownerIdentity, ownerRevision, directive!, target, depth, key,
                ExpectedOutcome.Blocked(new ArticleEmbedError(ArticleEmbedErrorCode.Missing, "target_missing")));
        }
        if (records.Count > 1)
        {
            return EmitMemoized(edges, context, ownerIdentity, ownerRevision, directive!, target, depth, key,
                ExpectedOutcome.Blocked(new ArticleEmbedError(ArticleEmbedErrorCode.Ambiguous, "target_ambiguous")));
        }

        ArticleEmbedPublicationTargetFacts facts = records[0];
        ArticleEmbedError? factFailure = ExpectedFailure(facts, context.Authority);
        if (factFailure is not null)
        {
            return EmitMemoized(edges, context, ownerIdentity, ownerRevision, directive!, target, depth, key,
                ExpectedOutcome.Blocked(factFailure));
        }

        context.Meter.ObserveBytes(facts.SourceByteCount);
        if (context.Meter.Bytes > context.Budgets.MaxSourceBytes)
        {
            return EmitBlocked(edges, ownerIdentity, ownerRevision, directive, target, depth,
                new ArticleEmbedError(ArticleEmbedErrorCode.SizeExceeded, "source_bytes_exceeded"));
        }

        ArticleEmbedSafeProjectionReference? projection = ExpectedProjection(facts, target, out ArticleEmbedError? coordinateError);
        if (projection is null)
        {
            return EmitMemoized(edges, context, ownerIdentity, ownerRevision, directive!, target, depth, key,
                ExpectedOutcome.Blocked(coordinateError!));
        }

        var coordinate = new ArticleEmbedDependencyCoordinate(
            ArticleEmbedSchemas.DependencyCoordinate,
            ArticleEmbedSchemas.Version,
            target,
            facts.ResolvedPublicRevision,
            facts.TargetVersionIdentity,
            projection.ProjectionIdentity,
            projection.ContentDigest,
            string.Empty);
        coordinate = ArticleEmbedContractValidator.Seal(coordinate);

        var resolved = new ExpectedOutcome(
            ArticleEmbedPublicationEdgeStatus.Frozen,
            coordinate,
            null,
            facts,
            projection);

        ExpectedOutcome emitted = Emit(edges, ownerIdentity, ownerRevision, directive!, target, depth, resolved);

        path.Add(key);
        bool pathSensitive = false;
        foreach (ArticleEmbedDirectiveProjection nested in OrderedNested(facts))
        {
            ArticleEmbedTargetIdentity? nestedTarget = null;
            if (!Enum.IsDefined(nested.Mode)
                || !ArticleEmbedTargetCodec.TryDecode(nested.TargetToken, nested.Mode, out nestedTarget).IsValid
                || nestedTarget is null)
            {
                context.Meter.ObserveNode();
                context.Meter.ObserveDepth(depth + 1);
                EmitBlocked(
                    edges,
                    facts.PortableArticleIdentity,
                    facts.ResolvedPublicRevision,
                    nested,
                    null,
                    depth + 1,
                    new ArticleEmbedError(ArticleEmbedErrorCode.InvalidTarget, "nested_target_invalid"));
                continue;
            }
            ExpectedOutcome child = ExpectEdge(
                context,
                request,
                facts.PortableArticleIdentity,
                facts.ResolvedPublicRevision,
                nested,
                nestedTarget,
                depth + 1,
                path,
                topLevel: false,
                edges);
            pathSensitive |= child.PathSensitive;
        }
        path.Remove(key);
        if (!pathSensitive)
        {
            context.Memo[key] = resolved;
        }
        return emitted with
        {
            PathSensitive = pathSensitive
        };
    }

    private static ExpectedOutcome Emit(
        List<ExpectedEdge> edges,
        string ownerIdentity,
        long ownerRevision,
        ArticleEmbedDirectiveProjection? directive,
        ArticleEmbedTargetIdentity? target,
        int depth,
        ExpectedOutcome outcome)
    {
        edges.Add(new ExpectedEdge(
            ownerIdentity,
            ownerRevision,
            directive,
            target,
            outcome.Status,
            outcome.Coordinate,
            outcome.Error,
            depth,
            outcome.Facts?.LatestObservedRevision ?? 0,
            outcome.Facts,
            outcome.Projection));
        return outcome;
    }

    private static ExpectedOutcome EmitBlocked(
        List<ExpectedEdge> edges,
        string ownerIdentity,
        long ownerRevision,
        ArticleEmbedDirectiveProjection? directive,
        ArticleEmbedTargetIdentity? target,
        int depth,
        ArticleEmbedError error)
        => Emit(edges, ownerIdentity, ownerRevision, directive, target, depth, ExpectedOutcome.Blocked(error)) with
        {
            PathSensitive = PathSensitiveCode(error.Code)
        };

    private static ExpectedOutcome EmitMemoized(
        List<ExpectedEdge> edges,
        ExpectedContext context,
        string ownerIdentity,
        long ownerRevision,
        ArticleEmbedDirectiveProjection directive,
        ArticleEmbedTargetIdentity target,
        int depth,
        NodeKey key,
        ExpectedOutcome outcome)
    {
        context.Memo[key] = outcome;
        return Emit(edges, ownerIdentity, ownerRevision, directive, target, depth, outcome);
    }

    /// <summary>Failures whose occurrence depends on expansion path or wall-clock meters; mirrors the planner.</summary>
    private static bool PathSensitiveCode(ArticleEmbedErrorCode code)
        => code is ArticleEmbedErrorCode.Cycle
            or ArticleEmbedErrorCode.DepthExceeded
            or ArticleEmbedErrorCode.SizeExceeded
            or ArticleEmbedErrorCode.TimeExceeded
            or ArticleEmbedErrorCode.StaleSource;

    private static IReadOnlyList<ArticleEmbedDirectiveProjection> OrderedNested(ArticleEmbedPublicationTargetFacts facts)
        => facts.NestedDirectives
            .OrderBy(static directive => directive.RawRange.Start)
            .ThenBy(static directive => directive.RawRange.End)
            .ThenBy(static directive => directive.TargetToken, StringComparer.Ordinal)
            .ToArray();

    /// <summary>Re-derives the publication-side fact failure independently of the planner.</summary>
    private static ArticleEmbedError? ExpectedFailure(
        ArticleEmbedPublicationTargetFacts facts,
        ArticleEmbedPublicationAuthority authority)
    {
        if (facts.AuthorityGeneration != authority.AuthorityGeneration)
        {
            return new ArticleEmbedError(ArticleEmbedErrorCode.StaleTarget, "authority_generation_drift");
        }
        if (facts.SiteIdentity != authority.Actor.SiteIdentity)
        {
            return new ArticleEmbedError(ArticleEmbedErrorCode.PermissionUnknown, "site_mismatch");
        }
        if (facts.Permission == ArticleEmbedPermissionStatus.Denied)
        {
            return new ArticleEmbedError(ArticleEmbedErrorCode.PermissionDenied, "permission_denied");
        }
        if (facts.Permission == ArticleEmbedPermissionStatus.Unknown)
        {
            return new ArticleEmbedError(ArticleEmbedErrorCode.PermissionUnknown, "permission_unknown");
        }
        if (facts.Lifecycle == ArticleEmbedLifecycleStatus.Draft)
        {
            return new ArticleEmbedError(ArticleEmbedErrorCode.Draft, "target_draft");
        }
        if (facts.Lifecycle == ArticleEmbedLifecycleStatus.Scheduled)
        {
            return new ArticleEmbedError(ArticleEmbedErrorCode.Unpublished, "target_scheduled_not_public");
        }
        if (facts.Lifecycle == ArticleEmbedLifecycleStatus.Archived)
        {
            return new ArticleEmbedError(ArticleEmbedErrorCode.Archived, "target_archived");
        }
        if (facts.Lifecycle == ArticleEmbedLifecycleStatus.Deleted)
        {
            return new ArticleEmbedError(ArticleEmbedErrorCode.Deleted, "target_deleted");
        }
        if (facts.Lifecycle == ArticleEmbedLifecycleStatus.Unknown)
        {
            return new ArticleEmbedError(ArticleEmbedErrorCode.Unpublished, "lifecycle_unknown");
        }
        if (facts.Visibility == ArticleEmbedVisibilityStatus.Private)
        {
            return new ArticleEmbedError(ArticleEmbedErrorCode.Private, "target_private");
        }
        if (facts.Visibility == ArticleEmbedVisibilityStatus.Unknown)
        {
            return new ArticleEmbedError(ArticleEmbedErrorCode.Unpublished, "visibility_unknown");
        }
        if (!facts.RevisionPackageComplete)
        {
            return new ArticleEmbedError(ArticleEmbedErrorCode.Missing, "target_revision_incomplete");
        }
        return null;
    }

    private static ArticleEmbedSafeProjectionReference? ExpectedProjection(
        ArticleEmbedPublicationTargetFacts facts,
        ArticleEmbedTargetIdentity target,
        out ArticleEmbedError? error)
    {
        error = null;
        switch (target.Kind)
        {
            case ArticleEmbedTargetKind.Article:
                return facts.BodyProjection;
            case ArticleEmbedTargetKind.Heading:
                {
                    int matches = facts.Headings.Count(heading => heading.HeadingIdentity == target.HeadingIdentity);
                    if (matches == 0)
                    {
                        error = new ArticleEmbedError(ArticleEmbedErrorCode.HeadingMissing, "heading_missing");
                        return null;
                    }
                    if (matches > 1)
                    {
                        error = new ArticleEmbedError(ArticleEmbedErrorCode.HeadingDuplicate, "heading_duplicate");
                        return null;
                    }
                    return facts.Headings.Single(heading => heading.HeadingIdentity == target.HeadingIdentity).SubtreeProjection;
                }
            case ArticleEmbedTargetKind.Block:
                {
                    int matches = facts.Blocks.Count(block => block.BlockAnchor == target.BlockAnchor);
                    if (matches == 0)
                    {
                        error = new ArticleEmbedError(ArticleEmbedErrorCode.BlockMissing, "block_missing");
                        return null;
                    }
                    if (matches > 1)
                    {
                        error = new ArticleEmbedError(ArticleEmbedErrorCode.BlockDuplicate, "block_duplicate");
                        return null;
                    }
                    return facts.Blocks.Single(block => block.BlockAnchor == target.BlockAnchor).BlockProjection;
                }
            default:
                error = new ArticleEmbedError(ArticleEmbedErrorCode.InvalidTarget, "target_invalid");
                return null;
        }
    }

    private static ArticleEmbedError? ExpectBinding(
        ArticleEmbedProviderRequest request,
        ArticleEmbedPublicationAuthority authority)
    {
        if (request.HostPortableArticleIdentity != authority.HostPortableArticleIdentity
            || request.HostDocument != authority.HostDocument
            || request.SourceRevision != authority.HostCurrentRevision
            || request.ContentDigest != authority.HostSourceDigest)
        {
            return new ArticleEmbedError(ArticleEmbedErrorCode.StaleSource, "host_source_drift");
        }
        if (request.Actor != authority.Actor)
        {
            return new ArticleEmbedError(ArticleEmbedErrorCode.StaleSource, "permission_context_drift");
        }
        if (request.Runtime != authority.Runtime)
        {
            return new ArticleEmbedError(ArticleEmbedErrorCode.StaleRuntime, "runtime_drift");
        }
        return null;
    }

    private static ArticleEmbedPublicationVerification Finish(List<string> reasons)
    {
        var verification = new ArticleEmbedPublicationVerification(reasons.Count == 0, reasons, string.Empty);
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

    private sealed record NodeKey(
        string PortableArticleIdentity,
        ArticleEmbedTargetKind Kind,
        string? HeadingIdentity,
        string? BlockAnchor);

    private sealed record ExpectedEdge(
        string OwnerIdentity,
        long OwnerRevision,
        ArticleEmbedDirectiveProjection? Directive,
        ArticleEmbedTargetIdentity? Target,
        ArticleEmbedPublicationEdgeStatus Status,
        ArticleEmbedDependencyCoordinate? Coordinate,
        ArticleEmbedError? Error,
        int Depth,
        long LatestObservedRevision,
        ArticleEmbedPublicationTargetFacts? Facts,
        ArticleEmbedSafeProjectionReference? Projection);

    private sealed record ExpectedOutcome(
        ArticleEmbedPublicationEdgeStatus Status,
        ArticleEmbedDependencyCoordinate? Coordinate,
        ArticleEmbedError? Error,
        ArticleEmbedPublicationTargetFacts? Facts,
        ArticleEmbedSafeProjectionReference? Projection,
        bool PathSensitive = false)
    {
        public static ExpectedOutcome Blocked(ArticleEmbedError error)
            => new(ArticleEmbedPublicationEdgeStatus.Blocked, null, error, null, null);
    }

    private sealed class ExpectedContext
    {
        public ExpectedContext(ArticleEmbedPublicationAuthority authority, ArticleEmbedResolutionBudgetLimits budgets)
        {
            Authority = authority;
            Budgets = budgets;
            FactsByIdentity = authority.Targets
                .GroupBy(static facts => facts.PortableArticleIdentity, StringComparer.Ordinal)
                .ToDictionary(static group => group.Key, static group => group.ToList(), StringComparer.Ordinal);
        }

        public ArticleEmbedPublicationAuthority Authority
        {
            get;
        }
        public ArticleEmbedResolutionBudgetLimits Budgets
        {
            get;
        }
        public Dictionary<string, List<ArticleEmbedPublicationTargetFacts>> FactsByIdentity
        {
            get;
        }
        public Dictionary<NodeKey, ExpectedOutcome> Memo { get; } = new();
        public ExpectedMeter Meter { get; } = new();
    }

    private sealed class ExpectedMeter
    {
        public int Nodes
        {
            get; private set;
        }
        public int Messages
        {
            get; private set;
        }
        public long Bytes
        {
            get; private set;
        }
        public int MaxDepth
        {
            get; private set;
        }

        public void ObserveNode() => Nodes++;
        public void ObserveMessage() => Messages++;
        public void ObserveBytes(long bytes) => Bytes += bytes;

        public void ObserveDepth(int depth)
        {
            if (depth > MaxDepth)
            {
                MaxDepth = depth;
            }
        }
    }
}
