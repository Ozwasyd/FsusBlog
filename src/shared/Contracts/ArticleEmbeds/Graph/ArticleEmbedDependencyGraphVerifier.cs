using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;

using static FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring.ArticleEmbedAuthoringVerifier;

namespace FsusBlog.Shared.Contracts.ArticleEmbeds.Graph;

/// <summary>
/// Independent authoring-resolution verifier. It re-derives expected per-node outcomes from the sealed
/// authority snapshot, re-walks the recorded expansion tree for cycle/budget legitimacy, recomputes every
/// digest, and never calls the resolver or trusts candidate-computed fields.
/// </summary>
public static class ArticleEmbedDependencyGraphVerifier
{
    public static ArticleEmbedAuthoringVerification Verify(
        IReadOnlyList<ArticleEmbedProviderRequest>? requests,
        ArticleEmbedAuthoritySnapshot? snapshot,
        ArticleEmbedResolutionBudgetLimits? budgets,
        ArticleEmbedAuthoringResolution? candidate)
    {
        var reasons = new List<string>();
        if (candidate is null)
        {
            reasons.Add("resolution_missing");
            return Finish(reasons);
        }

        ArticleEmbedValidationResult structure = ArticleEmbedAuthoringContractValidator.Validate(candidate);
        if (!structure.IsValid)
        {
            reasons.Add(structure.ReasonCode!);
            return Finish(reasons);
        }

        ArticleEmbedValidationResult budgetCheck = ArticleEmbedAuthoringContractValidator.ValidateBudgets(budgets);
        ArticleEmbedValidationResult snapshotCheck = ArticleEmbedAuthoringContractValidator.Validate(snapshot);
        if (!budgetCheck.IsValid || !snapshotCheck.IsValid || requests is null
            || (budgets is not null && requests.Count > budgets.MaxExpandedNodes))
        {
            string expectedRejection = !budgetCheck.IsValid
                ? budgetCheck.ReasonCode!
                : !snapshotCheck.IsValid
                    ? snapshotCheck.ReasonCode!
                    : requests is null
                        ? "article_embed_authoring_requests_missing"
                        : "article_embed_authoring_request_set_exceeds_budget";
            if (candidate.Status != ArticleEmbedAuthoringResolutionStatus.Rejected
                || candidate.RejectedReasonCode != expectedRejection
                || candidate.Results.Count != 0)
            {
                reasons.Add("rejection_mismatch");
            }
            return Finish(reasons);
        }

        if (candidate.Status != ArticleEmbedAuthoringResolutionStatus.Completed)
        {
            reasons.Add("resolution_rejected_without_cause");
            return Finish(reasons);
        }

        var factsByIdentity = snapshot!.Targets
            .GroupBy(static facts => facts.PortableArticleIdentity, StringComparer.Ordinal)
            .ToDictionary(static group => group.Key, static group => group.ToList(), StringComparer.Ordinal);

        VerifyReceiptBinding(candidate.Receipt, snapshot, budgets!, requests!, reasons);

        if (candidate.Results.Count != requests!.Count || candidate.Receipt.Items.Count != requests.Count)
        {
            reasons.Add("result_count_mismatch");
            return Finish(reasons);
        }

        var seenMemoizable = new HashSet<NodeKey>();
        int observedNodes = 0;
        int observedDepth = 0;
        for (int index = 0; index < requests.Count; index++)
        {
            ArticleEmbedProviderRequest request = requests[index];
            ArticleEmbedAuthoringEmbedResult result = candidate.Results[index];
            ArticleEmbedAuthoringReceiptItem item = candidate.Receipt.Items[index];
            VerifyRequestResult(
                request,
                result,
                item,
                snapshot,
                factsByIdentity,
                budgets!,
                seenMemoizable,
                ref observedNodes,
                ref observedDepth,
                reasons);
            if (result.Result.Budgets.Nodes != observedNodes || result.Result.Budgets.Depth != observedDepth)
            {
                reasons.Add($"graph_result_observation_mismatch:{request.RequestId}");
            }
        }
        if (candidate.Receipt.Observed.Nodes != observedNodes)
        {
            reasons.Add("graph_node_observation_mismatch");
        }
        if (candidate.Receipt.Observed.Depth != observedDepth || candidate.Receipt.MaxObservedDepth != observedDepth)
        {
            reasons.Add("graph_depth_observation_mismatch");
        }

        return Finish(reasons);
    }

    private static void VerifyRequestResult(
        ArticleEmbedProviderRequest request,
        ArticleEmbedAuthoringEmbedResult result,
        ArticleEmbedAuthoringReceiptItem item,
        ArticleEmbedAuthoritySnapshot snapshot,
        Dictionary<string, List<ArticleEmbedTargetFacts>> factsByIdentity,
        ArticleEmbedResolutionBudgetLimits budgets,
        HashSet<NodeKey> seenMemoizable,
        ref int observedNodes,
        ref int observedDepth,
        List<string> reasons)
    {
        observedNodes++;
        observedDepth = Math.Max(observedDepth, 1);
        if (result.Result.Status == ArticleEmbedProviderResultStatus.Resolved && observedNodes > budgets.MaxExpandedNodes)
        {
            reasons.Add("resolved_node_beyond_node_budget");
        }
        if (result.RequestId != request.RequestId || item.RequestId != request.RequestId)
        {
            reasons.Add($"result_request_binding_mismatch:{request.RequestId}");
            return;
        }
        if (item.Target != request.Target)
        {
            reasons.Add($"receipt_target_mismatch:{request.RequestId}");
        }

        ArticleEmbedValidationResult requestCheck = ArticleEmbedContractValidator.Validate(request);
        if (!requestCheck.IsValid)
        {
            if (result.Result.Status != ArticleEmbedProviderResultStatus.Failed
                || result.Result.Error?.Code != ArticleEmbedErrorCode.InvalidTarget
                || result.Children.Count != 0
                || result.Eligibility != ArticleEmbedPublicationEligibility.AuthoringOnly
                || result.OpenSource is not null
                || result.UpdateAvailable)
            {
                reasons.Add($"invalid_request_not_failed:{request.RequestId}");
            }
            VerifyReceiptItem(result, item, null, reasons);
            return;
        }

        ArticleEmbedValidationResult resultCheck = ArticleEmbedContractValidator.Validate(result.Result, request);
        if (!resultCheck.IsValid)
        {
            reasons.Add($"provider_result_invalid:{request.RequestId}:{resultCheck.ReasonCode}");
        }

        NodeKey key = NodeKeyOf(request.Target);
        bool earlierMemoizable = seenMemoizable.Contains(key);
        if (item.CacheHit && !earlierMemoizable)
        {
            reasons.Add($"cache_hit_without_prior_resolution:{request.RequestId}");
        }
        if (!item.CacheHit
            && earlierMemoizable
            && (result.Result.Status == ArticleEmbedProviderResultStatus.Resolved
                || (result.Result.Error is not null && IsFactStable(result.Result.Error.Code))))
        {
            reasons.Add($"cache_miss_for_memoized_node:{request.RequestId}");
        }

        ArticleEmbedError? bindingFailure = ExpectBinding(request, snapshot);
        if (bindingFailure is not null)
        {
            if (result.Result.Status != ArticleEmbedProviderResultStatus.Failed
                || result.Result.Error?.Code != bindingFailure.Code
                || result.Result.Error.SafeReasonCode != bindingFailure.SafeReasonCode
                || result.Children.Count != 0
                || result.Eligibility != ArticleEmbedPublicationEligibility.AuthoringOnly)
            {
                reasons.Add($"binding_failure_mismatch:{request.RequestId}");
            }
            VerifyReceiptItem(result, item, null, reasons);
            return;
        }

        if (result.Result.Status == ArticleEmbedProviderResultStatus.Failed
            && result.Result.Error is not null
            && IsOrderSensitive(result.Result.Error.Code))
        {
            if (result.Result.Error.Code == ArticleEmbedErrorCode.Cycle
                && (request.Target.Kind != ArticleEmbedTargetKind.Article
                    || request.Target.PortableArticleIdentity != snapshot.HostPortableArticleIdentity))
            {
                reasons.Add($"root_cycle_without_host_ancestor:{request.RequestId}");
            }
            if (result.Result.Error.Code == ArticleEmbedErrorCode.DepthExceeded)
            {
                reasons.Add($"root_depth_failure_unjustified:{request.RequestId}");
            }
            if (result.Children.Count != 0
                || result.Eligibility != ArticleEmbedPublicationEligibility.AuthoringOnly
                || result.OpenSource is not null
                || result.UpdateAvailable)
            {
                reasons.Add($"budget_failure_shape_invalid:{request.RequestId}");
            }
            VerifyReceiptItem(result, item, null, reasons);
            return;
        }

        NodeExpectation expectation = ExpectGraph(request.Target, snapshot, factsByIdentity);
        if (expectation.Error is not null)
        {
            if (result.Result.Status != ArticleEmbedProviderResultStatus.Failed
                || result.Result.Error?.Code != expectation.Error.Code
                || result.Result.Error.SafeReasonCode != expectation.Error.SafeReasonCode)
            {
                reasons.Add($"expected_failure_mismatch:{request.RequestId}");
            }
            bool concealed = expectation.Error.Code is ArticleEmbedErrorCode.PermissionDenied
                or ArticleEmbedErrorCode.PermissionUnknown;
            ArticleEmbedPermissionStatus expectedPermission = expectation.Error.Code switch
            {
                ArticleEmbedErrorCode.PermissionDenied => ArticleEmbedPermissionStatus.Denied,
                ArticleEmbedErrorCode.PermissionUnknown => ArticleEmbedPermissionStatus.Unknown,
                _ => expectation.Facts?.Permission ?? ArticleEmbedPermissionStatus.Unknown
            };
            if (result.Result.Visibility != (concealed ? ArticleEmbedVisibilityStatus.Unknown
                    : expectation.Facts?.Visibility ?? ArticleEmbedVisibilityStatus.Unknown)
                || result.Result.Lifecycle != (concealed ? ArticleEmbedLifecycleStatus.Unknown
                    : expectation.Facts?.Lifecycle ?? ArticleEmbedLifecycleStatus.Unknown)
                || result.Result.Permission != expectedPermission)
            {
                reasons.Add($"failure_metadata_mismatch:{request.RequestId}");
            }
        }
        else
        {
            if (result.Result.Status != ArticleEmbedProviderResultStatus.Resolved
                || result.Result.Coordinate is null
                || result.Result.Coordinate.ResolvedRevision != expectation.Facts!.ResolvedRevision
                || result.Result.Coordinate.TargetVersionIdentity != expectation.Facts.TargetVersionIdentity
                || result.Result.Coordinate.ProjectionIdentity != expectation.Projection!.ProjectionIdentity
                || result.Result.Coordinate.ProjectionDigest != expectation.Projection.ContentDigest
                || result.Result.Projection != expectation.Projection
                || result.Result.Visibility != expectation.Facts.Visibility
                || result.Result.Lifecycle != expectation.Facts.Lifecycle
                || result.Result.Permission != expectation.Facts.Permission)
            {
                reasons.Add($"resolved_coordinate_mismatch:{request.RequestId}");
            }
            else
            {
                string expectedAttribution = ArticleEmbedContractDigest.ComputeAttribution(
                    expectation.Facts.PortableArticleIdentity,
                    expectation.Facts.ResolvedRevision,
                    expectation.Facts.AttributionDisplayText);
                if (result.Result.Attribution is null
                    || result.Result.Attribution.DisplayText != expectation.Facts.AttributionDisplayText
                    || result.Result.Attribution.AttributionDigest != expectedAttribution)
                {
                    reasons.Add($"attribution_mismatch:{request.RequestId}");
                }
            }
        }

        ArticleEmbedPublicationEligibility expectedEligibility =
            expectation.Error is null
                && expectation.Facts!.Visibility == ArticleEmbedVisibilityStatus.Public
                && expectation.Facts.Lifecycle == ArticleEmbedLifecycleStatus.Published
                    ? ArticleEmbedPublicationEligibility.PublicationEligible
                    : ArticleEmbedPublicationEligibility.AuthoringOnly;
        if (result.Eligibility != expectedEligibility)
        {
            reasons.Add($"eligibility_mismatch:{request.RequestId}");
        }

        bool expectedUpdate = expectation.Error is null
            && expectation.Facts!.LatestObservedRevision > expectation.Facts.ResolvedRevision;
        if (result.UpdateAvailable != expectedUpdate)
        {
            reasons.Add($"update_available_mismatch:{request.RequestId}");
        }

        bool expectIntent = expectation.Error is null;
        if ((result.OpenSource is not null) != expectIntent
            || (expectIntent
                && (result.OpenSource!.IntentKind != ArticleEmbedAuthoringSchemas.OpenSourceIntentKind
                    || result.OpenSource.Target != request.Target
                    || result.OpenSource.ResolvedRevision != expectation.Facts!.ResolvedRevision)))
        {
            reasons.Add($"open_source_intent_mismatch:{request.RequestId}");
        }

        VerifyReceiptItem(result, item, expectation.Error is null ? expectation.Facts!.ResolvedRevision : null, reasons);
        bool subtreeClean = VerifyChildren(
            result.Children,
            expectation.Error is null ? expectation.Facts : null,
            snapshot,
            factsByIdentity,
            depth: 2,
            path: new HashSet<NodeKey>
            {
                new(snapshot.HostPortableArticleIdentity, ArticleEmbedTargetKind.Article, null, null),
                key
            },
            budgets,
            seenMemoizable,
            ref observedNodes,
            ref observedDepth,
            reasons);

        if (expectation.Error is null
            ? subtreeClean
            : IsFactStable(expectation.Error.Code))
        {
            seenMemoizable.Add(key);
        }
    }

    /// <summary>
    /// Returns false when any descendant carries a path-dependent failure (cycle/budget/abort). Nodes whose
    /// outcome is path-independent join <paramref name="seenMemoizable"/> exactly as the resolver memoizes them,
    /// whether they were expanded top-level, nested, or replayed from the shared memo.
    /// </summary>
    private static bool VerifyChildren(
        IReadOnlyList<ArticleEmbedResolvedNode> children,
        ArticleEmbedTargetFacts? parentFacts,
        ArticleEmbedAuthoritySnapshot snapshot,
        Dictionary<string, List<ArticleEmbedTargetFacts>> factsByIdentity,
        int depth,
        HashSet<NodeKey> path,
        ArticleEmbedResolutionBudgetLimits budgets,
        HashSet<NodeKey> seenMemoizable,
        ref int observedNodes,
        ref int observedDepth,
        List<string> reasons)
    {
        if (parentFacts is null)
        {
            if (children.Count != 0)
            {
                reasons.Add("unexpected_children_on_failed_node");
            }
            return children.Count == 0;
        }

        ArticleEmbedDirectiveProjection[] expectedDirectives = parentFacts.NestedDirectives
            .OrderBy(static directive => directive.RawRange.Start)
            .ThenBy(static directive => directive.RawRange.End)
            .ThenBy(static directive => directive.TargetToken, StringComparer.Ordinal)
            .ToArray();
        if (children.Count != expectedDirectives.Length)
        {
            reasons.Add("child_count_mismatch");
            return false;
        }

        bool clean = true;
        for (int index = 0; index < children.Count; index++)
        {
            ArticleEmbedResolvedNode child = children[index];
            observedNodes++;
            observedDepth = Math.Max(observedDepth, depth);
            if (child.Status == ArticleEmbedProviderResultStatus.Resolved)
            {
                if (observedNodes > budgets.MaxExpandedNodes)
                {
                    reasons.Add("resolved_node_beyond_node_budget");
                    clean = false;
                }
                if (depth > budgets.MaxDepth)
                {
                    reasons.Add("resolved_node_beyond_depth_budget");
                    clean = false;
                }
            }
            ArticleEmbedDirectiveProjection directive = expectedDirectives[index];
            if (child.Directive != directive)
            {
                reasons.Add($"child_directive_mismatch:{directive.RawRange.Start}");
                clean = false;
                continue;
            }

            ArticleEmbedTargetIdentity? decoded = null;
            bool decodable = Enum.IsDefined(directive.Mode)
                && ArticleEmbedTargetCodec.TryDecode(directive.TargetToken, directive.Mode, out decoded).IsValid
                && decoded is not null;
            if (!decodable)
            {
                if (child.Status != ArticleEmbedProviderResultStatus.Failed
                    || child.Error?.Code != ArticleEmbedErrorCode.InvalidTarget
                    || child.Target is not null
                    || child.Children.Count != 0)
                {
                    reasons.Add("nested_invalid_not_failed");
                }
                continue;
            }
            if (child.Target != decoded)
            {
                reasons.Add("nested_target_mismatch");
                clean = false;
                continue;
            }

            NodeKey key = NodeKeyOf(decoded!);
            if (child.Status == ArticleEmbedProviderResultStatus.Failed)
            {
                if (child.Error is null || child.Children.Count != 0)
                {
                    reasons.Add("nested_failure_shape_invalid");
                    clean = false;
                    continue;
                }
                VerifyChildFailure(child, key, depth, path, snapshot, factsByIdentity, budgets, reasons);
                if (!IsFactStable(child.Error.Code))
                {
                    clean = false;
                }
                else
                {
                    seenMemoizable.Add(key);
                }
                continue;
            }
            if (child.Status != ArticleEmbedProviderResultStatus.Resolved)
            {
                reasons.Add("nested_status_unknown");
                clean = false;
                continue;
            }
            if (path.Contains(key))
            {
                reasons.Add("resolved_node_on_cycle_path");
                clean = false;
                continue;
            }

            NodeExpectation expectation = ExpectGraph(decoded!, snapshot, factsByIdentity);
            // A nested coordinate must bind the selected projection as exactly as a root coordinate.
            if (expectation.Error is not null
                || !ArticleEmbedContractValidator.Validate(child.Coordinate).IsValid
                || child.Coordinate!.ResolvedRevision != expectation.Facts!.ResolvedRevision
                || child.Coordinate.TargetVersionIdentity != expectation.Facts.TargetVersionIdentity
                || child.Coordinate.ProjectionIdentity != expectation.Projection!.ProjectionIdentity
                || child.Coordinate.ProjectionDigest != expectation.Projection.ContentDigest
                || child.Coordinate.Target != decoded)
            {
                reasons.Add("nested_coordinate_mismatch");
                clean = false;
                continue;
            }
            path.Add(key);
            bool childClean = VerifyChildren(
                child.Children,
                expectation.Facts,
                snapshot,
                factsByIdentity,
                depth + 1,
                path,
                budgets,
                seenMemoizable,
                ref observedNodes,
                ref observedDepth,
                reasons);
            path.Remove(key);
            clean &= childClean;
            if (childClean)
            {
                seenMemoizable.Add(key);
            }
        }
        return clean;
    }

    private static void VerifyChildFailure(
        ArticleEmbedResolvedNode child,
        NodeKey key,
        int depth,
        HashSet<NodeKey> path,
        ArticleEmbedAuthoritySnapshot snapshot,
        Dictionary<string, List<ArticleEmbedTargetFacts>> factsByIdentity,
        ArticleEmbedResolutionBudgetLimits budgets,
        List<string> reasons)
    {
        switch (child.Error!.Code)
        {
            case ArticleEmbedErrorCode.Cycle:
                if (!path.Contains(key))
                {
                    reasons.Add("cycle_without_ancestor");
                }
                return;
            case ArticleEmbedErrorCode.DepthExceeded:
                if (depth <= budgets.MaxDepth)
                {
                    reasons.Add("depth_failure_unjustified");
                }
                return;
            case ArticleEmbedErrorCode.SizeExceeded:
            case ArticleEmbedErrorCode.TimeExceeded:
            case ArticleEmbedErrorCode.StaleSource:
                return;
            default:
                break;
        }

        factsByIdentity.TryGetValue(key.PortableArticleIdentity, out List<ArticleEmbedTargetFacts>? records);
        if (records is null || records.Count == 0)
        {
            if (child.Error.Code != ArticleEmbedErrorCode.Missing)
            {
                reasons.Add("missing_target_misclassified");
            }
            return;
        }
        if (records.Count > 1)
        {
            if (child.Error.Code != ArticleEmbedErrorCode.Ambiguous)
            {
                reasons.Add("ambiguous_target_misclassified");
            }
            return;
        }

        ArticleEmbedError? expected = ExpectedGraphFailure(records[0], snapshot, child.Target!);
        if (expected?.Code != child.Error.Code || expected.SafeReasonCode != child.Error.SafeReasonCode)
        {
            reasons.Add("nested_failure_misclassified");
        }
    }

    private static ArticleEmbedError? ExpectedGraphFailure(
        ArticleEmbedTargetFacts facts, ArticleEmbedAuthoritySnapshot snapshot, ArticleEmbedTargetIdentity target)
    {
        ArticleEmbedError? source = ExpectedProjectionFailure(facts, snapshot, target);
        return source ?? (target.Kind != ArticleEmbedTargetKind.Article && facts.NestedDirectives.Count != 0
            ? new ArticleEmbedError(ArticleEmbedErrorCode.InvalidTarget, "projection_dependencies_unbound") : null);
    }

    private static NodeExpectation ExpectGraph(
        ArticleEmbedTargetIdentity target, ArticleEmbedAuthoritySnapshot snapshot,
        Dictionary<string, List<ArticleEmbedTargetFacts>> factsByIdentity)
    {
        NodeExpectation source = ExpectProjection(target, snapshot, factsByIdentity);
        if (source.Error is not null)
        {
            return source;
        }
        ArticleEmbedError? failure = ExpectedGraphFailure(source.Facts!, snapshot, target);
        return failure is null ? source : new NodeExpectation(failure, source.Facts, null);
    }
}
