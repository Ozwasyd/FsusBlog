namespace FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;

/// <summary>Explicit projection verification and current-fact policy; legacy recursive verification keeps its original helpers.</summary>
public static partial class ArticleEmbedAuthoringVerifier
{
    /// <summary>Independently verifies a projection-only candidate, rejecting recursive graph output.</summary>
    public static ArticleEmbedAuthoringVerification VerifyProjection(
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

        if (candidate.Status == ArticleEmbedAuthoringResolutionStatus.Completed
            && (candidate.Results is null
                || candidate.Results.Any(static result => result?.Result is null || result.Children is not { Count: 0 })
                || candidate.Results.Any(static result => result.Result.Error?.Code is ArticleEmbedErrorCode.Cycle
                    or ArticleEmbedErrorCode.DepthExceeded)))
        {
            reasons.Add("projection_stage_contains_graph_outcome");
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
        if (candidate.Receipt.Observed.Depth > 1 || candidate.Receipt.MaxObservedDepth > 1
            || candidate.Receipt.Observed.Nodes > requests!.Count)
        {
            reasons.Add("projection_stage_graph_budget_observation");
        }

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
            VerifyProjectionRequestResult(
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

    private static void VerifyProjectionRequestResult(
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

        if (!ArticleEmbedTargetCodec.TryDecode(request.Directive.TargetToken, request.Directive.Mode, out var decoded).IsValid
            || decoded != request.Target)
        {
            reasons.Add($"projection_request_target_mismatch:{request.RequestId}");
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

        NodeExpectation expectation = ExpectProjection(request.Target, snapshot, factsByIdentity);
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
        if (expectation.Error is null || IsFactStable(expectation.Error.Code))
        {
            seenMemoizable.Add(key);
        }
    }

    internal static ArticleEmbedError? ExpectedProjectionFailure(
        ArticleEmbedTargetFacts facts,
        ArticleEmbedAuthoritySnapshot snapshot,
        ArticleEmbedTargetIdentity target)
    {
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
        if (facts.AuthorityGeneration != snapshot.AuthorityGeneration)
        {
            return new ArticleEmbedError(ArticleEmbedErrorCode.StaleTarget, "authority_generation_drift");
        }
        if (facts.SourceRevision != facts.ResolvedRevision)
        {
            return new ArticleEmbedError(ArticleEmbedErrorCode.StaleTarget, "target_source_revision_drift");
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

    internal static NodeExpectation ExpectProjection(
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
        ArticleEmbedError? failure = ExpectedProjectionFailure(facts, snapshot, target);
        if (failure is not null)
        {
            return new NodeExpectation(failure, facts, null);
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
}
