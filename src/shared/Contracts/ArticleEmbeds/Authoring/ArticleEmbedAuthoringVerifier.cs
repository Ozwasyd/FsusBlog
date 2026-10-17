namespace FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;

/// <summary>
/// Independent authoring-resolution verifier. It re-derives expected per-node outcomes from the sealed
/// authority snapshot, re-walks the recorded expansion tree for cycle/budget legitimacy, recomputes every
/// digest, and never calls the resolver or trusts candidate-computed fields.
/// </summary>
public static partial class ArticleEmbedAuthoringVerifier
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
                reasons);
        }

        return Finish(reasons);
    }

    internal static void VerifyReceiptBinding(
        ArticleEmbedAuthoringReceipt receipt,
        ArticleEmbedAuthoritySnapshot snapshot,
        ArticleEmbedResolutionBudgetLimits budgets,
        IReadOnlyList<ArticleEmbedProviderRequest> requests,
        List<string> reasons)
    {
        if (receipt.Schema != ArticleEmbedAuthoringSchemas.Receipt
            || receipt.SchemaVersion != ArticleEmbedAuthoringSchemas.Version
            || receipt.HostPortableArticleIdentity != snapshot.HostPortableArticleIdentity
            || receipt.HostDocument != snapshot.HostDocument
            || receipt.HostSourceRevision != snapshot.HostSourceRevision
            || receipt.AuthorityGeneration != snapshot.AuthorityGeneration
            || receipt.SnapshotDigest != snapshot.SnapshotDigest
            || receipt.Actor != snapshot.Actor
            || receipt.Runtime != snapshot.Runtime
            || receipt.MaterialLocale != snapshot.MaterialLocale
            || receipt.MaterialTheme != snapshot.MaterialTheme
            || receipt.Budgets != budgets
            || receipt.RequestCount != requests.Count
            || receipt.ResolvedCount < 0
            || receipt.FailedCount < 0
            || receipt.ResolvedCount + receipt.FailedCount != requests.Count
            || receipt.CacheHitCount < 0
            || receipt.CacheHitCount > requests.Count
            || receipt.Observed.Depth < 0
            || receipt.Observed.Nodes < 0
            || receipt.Observed.Bytes < 0
            || receipt.Observed.ElapsedMilliseconds < 0
            || receipt.MaxObservedDepth < 0)
        {
            reasons.Add("receipt_binding_invalid");
        }
    }

    private static void VerifyRequestResult(
        ArticleEmbedProviderRequest request,
        ArticleEmbedAuthoringEmbedResult result,
        ArticleEmbedAuthoringReceiptItem item,
        ArticleEmbedAuthoritySnapshot snapshot,
        Dictionary<string, List<ArticleEmbedTargetFacts>> factsByIdentity,
        ArticleEmbedResolutionBudgetLimits budgets,
        HashSet<NodeKey> seenMemoizable,
        List<string> reasons)
    {
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

        NodeExpectation expectation = Expect(request.Target, snapshot, factsByIdentity);
        if (expectation.Error is not null)
        {
            if (result.Result.Status != ArticleEmbedProviderResultStatus.Failed
                || result.Result.Error?.Code != expectation.Error.Code
                || result.Result.Error.SafeReasonCode != expectation.Error.SafeReasonCode)
            {
                reasons.Add($"expected_failure_mismatch:{request.RequestId}");
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

            factsByIdentity.TryGetValue(decoded!.PortableArticleIdentity, out List<ArticleEmbedTargetFacts>? records);
            ArticleEmbedTargetFacts? facts = records is { Count: 1 } ? records[0] : null;
            ArticleEmbedErrorCode? expectedFailure = facts is null
                ? ArticleEmbedErrorCode.Missing
                : ExpectedFailure(facts, snapshot, decoded!)?.Code;
            if (facts is null || expectedFailure is not null || child.Coordinate is null
                || child.Coordinate.ResolvedRevision != facts!.ResolvedRevision
                || child.Coordinate.Target != decoded)
            {
                reasons.Add("nested_coordinate_mismatch");
                clean = false;
                continue;
            }
            path.Add(key);
            bool childClean = VerifyChildren(
                child.Children,
                facts,
                snapshot,
                factsByIdentity,
                depth + 1,
                path,
                budgets,
                seenMemoizable,
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

        ArticleEmbedError? expected = ExpectedFailure(records[0], snapshot, child.Target!);
        if (expected?.Code != child.Error.Code || expected.SafeReasonCode != child.Error.SafeReasonCode)
        {
            reasons.Add("nested_failure_misclassified");
        }
    }

    /// <summary>Re-derives the fact-level failure a target must produce, or null when resolution proceeds.</summary>
    private static ArticleEmbedError? ExpectedFailure(
        ArticleEmbedTargetFacts facts,
        ArticleEmbedAuthoritySnapshot snapshot,
        ArticleEmbedTargetIdentity target)
    {
        if (facts.AuthorityGeneration != snapshot.AuthorityGeneration)
        {
            return new ArticleEmbedError(ArticleEmbedErrorCode.StaleTarget, "authority_generation_drift");
        }
        if (facts.SiteIdentity != snapshot.Actor.SiteIdentity)
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
        if (facts.Visibility == ArticleEmbedVisibilityStatus.Unknown)
        {
            return new ArticleEmbedError(ArticleEmbedErrorCode.Unpublished, "visibility_unknown");
        }
        return target.Kind switch
        {
            ArticleEmbedTargetKind.Heading => CoordinateFailure(
                facts.Headings.Count(heading => heading.HeadingIdentity == target.HeadingIdentity),
                ArticleEmbedErrorCode.HeadingMissing,
                ArticleEmbedErrorCode.HeadingDuplicate),
            ArticleEmbedTargetKind.Block => CoordinateFailure(
                facts.Blocks.Count(block => block.BlockAnchor == target.BlockAnchor),
                ArticleEmbedErrorCode.BlockMissing,
                ArticleEmbedErrorCode.BlockDuplicate),
            _ => null
        };
    }

    internal static ArticleEmbedError? CoordinateFailure(
        int matches,
        ArticleEmbedErrorCode missing,
        ArticleEmbedErrorCode duplicate)
        => matches == 0
            ? new ArticleEmbedError(missing, missing == ArticleEmbedErrorCode.HeadingMissing ? "heading_missing" : "block_missing")
            : matches > 1
                ? new ArticleEmbedError(
                    duplicate,
                    duplicate == ArticleEmbedErrorCode.HeadingDuplicate ? "heading_duplicate" : "block_duplicate")
                : null;

    internal static void VerifyReceiptItem(
        ArticleEmbedAuthoringEmbedResult result,
        ArticleEmbedAuthoringReceiptItem item,
        long? expectedRevision,
        List<string> reasons)
    {
        if (item.Status != result.Result.Status
            || item.ErrorCode != result.Result.Error?.Code
            || item.Visibility != result.Result.Visibility
            || item.Lifecycle != result.Result.Lifecycle
            || item.Permission != result.Result.Permission
            || item.Eligibility != result.Eligibility
            || item.ChildCount != result.Children.Count
            || item.ResultDigest != result.Result.ResultDigest
            || item.ResolvedRevision != expectedRevision)
        {
            reasons.Add("receipt_item_mismatch");
        }
    }

    /// <summary>Re-derives the request-level binding failure, in the resolver's exact check order.</summary>
    internal static ArticleEmbedError? ExpectBinding(
        ArticleEmbedProviderRequest request,
        ArticleEmbedAuthoritySnapshot snapshot)
    {
        if (request.RequestedScope != ArticleEmbedRequestedScope.Authoring)
        {
            return new ArticleEmbedError(ArticleEmbedErrorCode.InvalidTarget, "authoring_scope_required");
        }
        if (request.AbortSignal.IsCancellationRequested)
        {
            return new ArticleEmbedError(ArticleEmbedErrorCode.StaleSource, "request_aborted");
        }
        if (request.HostPortableArticleIdentity != snapshot.HostPortableArticleIdentity
            || request.HostDocument != snapshot.HostDocument
            || request.SourceRevision != snapshot.HostSourceRevision
            || request.ContentDigest != snapshot.HostSourceDigest)
        {
            return new ArticleEmbedError(ArticleEmbedErrorCode.StaleSource, "host_source_drift");
        }
        if (request.Actor != snapshot.Actor)
        {
            return new ArticleEmbedError(ArticleEmbedErrorCode.StaleSource, "permission_context_drift");
        }
        if (request.Runtime != snapshot.Runtime)
        {
            return new ArticleEmbedError(ArticleEmbedErrorCode.StaleRuntime, "runtime_drift");
        }
        return null;
    }

    internal static bool IsFactStable(ArticleEmbedErrorCode code)
        => !IsOrderSensitive(code) && code is not ArticleEmbedErrorCode.StaleRuntime;

    /// <summary>Failures the shared meter or expansion path can legitimately preempt a fact outcome with.</summary>
    internal static bool IsOrderSensitive(ArticleEmbedErrorCode code)
        => code is ArticleEmbedErrorCode.Cycle
            or ArticleEmbedErrorCode.DepthExceeded
            or ArticleEmbedErrorCode.SizeExceeded
            or ArticleEmbedErrorCode.TimeExceeded
            or ArticleEmbedErrorCode.StaleSource;

    internal static NodeKey NodeKeyOf(ArticleEmbedTargetIdentity target)
        => new(target.PortableArticleIdentity, target.Kind, target.HeadingIdentity, target.BlockAnchor);

    private static NodeExpectation Expect(
        ArticleEmbedTargetIdentity target,
        ArticleEmbedAuthoritySnapshot snapshot,
        Dictionary<string, List<ArticleEmbedTargetFacts>> factsByIdentity)
    {
        factsByIdentity.TryGetValue(target.PortableArticleIdentity, out List<ArticleEmbedTargetFacts>? records);
        if (records is null || records.Count == 0)
        {
            return NodeExpectation.Failed(new ArticleEmbedError(ArticleEmbedErrorCode.Missing, "target_missing"));
        }
        if (records.Count > 1)
        {
            return NodeExpectation.Failed(new ArticleEmbedError(ArticleEmbedErrorCode.Ambiguous, "target_ambiguous"));
        }

        ArticleEmbedTargetFacts facts = records[0];
        ArticleEmbedError? failure = ExpectedFailure(facts, snapshot, target);
        if (failure is not null)
        {
            return NodeExpectation.Failed(failure);
        }

        ArticleEmbedSafeProjectionReference? projection = target.Kind switch
        {
            ArticleEmbedTargetKind.Article => facts.BodyProjection,
            ArticleEmbedTargetKind.Heading => facts.Headings
                .Single(heading => heading.HeadingIdentity == target.HeadingIdentity)
                .SubtreeProjection,
            ArticleEmbedTargetKind.Block => facts.Blocks
                .Single(block => block.BlockAnchor == target.BlockAnchor)
                .BlockProjection,
            _ => null
        };
        return projection is null
            ? NodeExpectation.Failed(new ArticleEmbedError(ArticleEmbedErrorCode.InvalidTarget, "target_invalid"))
            : new NodeExpectation(null, facts, projection);
    }

    internal static ArticleEmbedAuthoringVerification Finish(List<string> reasons)
    {
        var verification = new ArticleEmbedAuthoringVerification(reasons.Count == 0, reasons, string.Empty);
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

    internal sealed record NodeKey(
        string PortableArticleIdentity,
        ArticleEmbedTargetKind Kind,
        string? HeadingIdentity,
        string? BlockAnchor);

    internal sealed record NodeExpectation(
        ArticleEmbedError? Error,
        ArticleEmbedTargetFacts? Facts,
        ArticleEmbedSafeProjectionReference? Projection)
    {
        public static NodeExpectation Failed(ArticleEmbedError error)
            => new(error, null, null);
    }
}
