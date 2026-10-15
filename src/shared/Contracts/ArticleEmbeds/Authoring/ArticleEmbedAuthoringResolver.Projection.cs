namespace FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;

/// <summary>Explicit projection stage in the existing resolver owner; the public Resolve entry retains its recursive contract.</summary>
public static partial class ArticleEmbedAuthoringResolver
{
    /// <summary>Projects only the supplied current targets; recursive expansion requires the explicit graph stage.</summary>
    public static ArticleEmbedAuthoringResolution ResolveProjection(
        IReadOnlyList<ArticleEmbedProviderRequest>? requests,
        ArticleEmbedAuthoritySnapshot? snapshot,
        ArticleEmbedResolutionBudgetLimits? budgets,
        TimeProvider? time = null)
    {
        time ??= TimeProvider.System;
        long started = time.GetTimestamp();

        ArticleEmbedValidationResult budgetCheck = ArticleEmbedAuthoringContractValidator.ValidateBudgets(budgets);
        if (!budgetCheck.IsValid)
        {
            return Rejected(budgetCheck.ReasonCode!, snapshot, budgets, requests?.Count ?? 0);
        }

        ArticleEmbedValidationResult snapshotCheck = ArticleEmbedAuthoringContractValidator.Validate(snapshot);
        if (!snapshotCheck.IsValid)
        {
            return Rejected(snapshotCheck.ReasonCode!, snapshot, budgets!, requests?.Count ?? 0);
        }

        if (requests is null)
        {
            return Rejected("article_embed_authoring_requests_missing", snapshot, budgets!, 0);
        }
        if (requests.Count > budgets!.MaxExpandedNodes)
        {
            return Rejected("article_embed_authoring_request_set_exceeds_budget", snapshot, budgets, requests.Count);
        }

        var context = new Context(snapshot!, budgets, time, started);
        var results = new List<ArticleEmbedAuthoringEmbedResult>(requests.Count);
        var items = new List<ArticleEmbedAuthoringReceiptItem>(requests.Count);
        foreach (ArticleEmbedProviderRequest request in requests)
        {
            NodeOutcome outcome = ResolveProjectionTarget(context, request);
            AppendOutcome(context, request, outcome, results, items);
        }
        return Complete(requests, snapshot!, budgets, context, results, items);
    }

    internal static void AppendOutcome(
        Context context, ArticleEmbedProviderRequest request, NodeOutcome outcome,
        List<ArticleEmbedAuthoringEmbedResult> results, List<ArticleEmbedAuthoringReceiptItem> items)
    {
        ArticleEmbedProviderResult result = outcome.ToResult(request, context);
        results.Add(new ArticleEmbedAuthoringEmbedResult(
            request.RequestId,
            result,
            outcome.Eligibility,
            outcome.Status == ArticleEmbedProviderResultStatus.Resolved
                ? new ArticleEmbedOpenSourceIntent(
                    ArticleEmbedAuthoringSchemas.OpenSourceIntentKind,
                    request.Target,
                    outcome.Coordinate!.ResolvedRevision)
                : null,
            outcome.UpdateAvailable,
            outcome.Children));
        items.Add(new ArticleEmbedAuthoringReceiptItem(
            request.RequestId,
            request.Target,
            result.Status,
            result.Error?.Code,
            result.Visibility,
            result.Lifecycle,
            result.Permission,
            outcome.Coordinate?.ResolvedRevision,
            outcome.Eligibility,
            outcome.CacheHit,
            outcome.Children.Count,
            result.ResultDigest));
    }

    internal static ArticleEmbedAuthoringResolution Complete(
        IReadOnlyList<ArticleEmbedProviderRequest> requests, ArticleEmbedAuthoritySnapshot snapshot,
        ArticleEmbedResolutionBudgetLimits budgets, Context context,
        List<ArticleEmbedAuthoringEmbedResult> results, List<ArticleEmbedAuthoringReceiptItem> items)
    {
        ArticleEmbedAuthoringReceipt receipt = SealReceipt(new ArticleEmbedAuthoringReceipt(
            ArticleEmbedAuthoringSchemas.Receipt,
            ArticleEmbedAuthoringSchemas.Version,
            snapshot!.HostPortableArticleIdentity,
            snapshot.HostDocument,
            snapshot.HostSourceRevision,
            snapshot.AuthorityGeneration,
            snapshot.SnapshotDigest,
            snapshot.Actor,
            snapshot.Runtime,
            snapshot.MaterialLocale,
            snapshot.MaterialTheme,
            budgets,
            context.Meter.Observed(context.Time, context.Started),
            requests.Count,
            results.Count(static result => result.Result.Status == ArticleEmbedProviderResultStatus.Resolved),
            results.Count(static result => result.Result.Status == ArticleEmbedProviderResultStatus.Failed),
            context.Meter.CacheHits,
            context.Meter.MaxDepth,
            items,
            string.Empty));

        return Seal(new ArticleEmbedAuthoringResolution(
            ArticleEmbedAuthoringSchemas.Resolution,
            ArticleEmbedAuthoringSchemas.Version,
            ArticleEmbedAuthoringResolutionStatus.Completed,
            null,
            results,
            receipt,
            string.Empty));
    }

    private static NodeOutcome ResolveProjectionTarget(
        Context context,
        ArticleEmbedProviderRequest request)
    {
        context.Meter.ObserveDepth(1);

        ArticleEmbedValidationResult requestCheck = ArticleEmbedContractValidator.Validate(request);
        if (!requestCheck.IsValid)
        {
            return NodeOutcome.Failed(ArticleEmbedErrorCode.InvalidTarget, "request_contract_invalid");
        }
        if (request.RequestedScope != ArticleEmbedRequestedScope.Authoring)
        {
            return NodeOutcome.Failed(ArticleEmbedErrorCode.InvalidTarget, "authoring_scope_required");
        }
        if (request.AbortSignal.IsCancellationRequested)
        {
            return NodeOutcome.Failed(ArticleEmbedErrorCode.StaleSource, "request_aborted");
        }

        NodeOutcome? binding = BindHost(context, request);
        if (binding is not null)
        {
            return binding;
        }
        context.Meter.ObserveNode();
        if (context.Meter.Nodes > context.Budgets.MaxExpandedNodes)
        {
            return NodeOutcome.Failed(ArticleEmbedErrorCode.SizeExceeded, "expanded_nodes_exceeded");
        }
        if (context.Meter.Elapsed(context.Time, context.Started) > context.Budgets.MaxElapsedMilliseconds)
        {
            return NodeOutcome.Failed(ArticleEmbedErrorCode.TimeExceeded, "elapsed_exceeded");
        }
        var key = KeyOf(request.Target);
        if (context.Memo.TryGetValue(key, out NodeOutcome? cached))
        {
            context.Meter.Hit();
            return cached with
            {
                CacheHit = true
            };
        }
        NodeOutcome outcome = ProjectCurrent(context, request.Target);
        if (!outcome.PathSensitive)
        {
            context.Memo[key] = outcome;
        }
        return outcome;
    }

    internal static NodeKey KeyOf(ArticleEmbedTargetIdentity target)
        => new(target.PortableArticleIdentity, target.Kind, target.HeadingIdentity, target.BlockAnchor);

    internal static NodeOutcome ProjectCurrent(Context context, ArticleEmbedTargetIdentity target)
    {
        context.Meter.ObserveMessage();
        if (context.Meter.Messages > context.Budgets.MaxAuthorityMessages)
        {
            return NodeOutcome.Failed(
    ArticleEmbedErrorCode.SizeExceeded, "authority_messages_exceeded", nodeTarget: target);
        }
        context.FactsByIdentity.TryGetValue(target.PortableArticleIdentity, out List<ArticleEmbedTargetFacts>? records);
        if (records is null || records.Count == 0)
        {
            return NodeOutcome.Failed(
    ArticleEmbedErrorCode.Missing, "target_missing", nodeTarget: target);
        }
        if (records.Count > 1)
        {
            return NodeOutcome.Failed(
    ArticleEmbedErrorCode.Ambiguous, "target_ambiguous", nodeTarget: target);
        }

        ArticleEmbedTargetFacts facts = records[0];
        NodeOutcome? factFailure = ClassifyProjection(context, facts);
        if (factFailure is not null)
        {
            return factFailure with
            {
                NodeTarget = target
            };
        }

        context.Meter.ObserveBytes(facts.SourceByteCount);
        if (context.Meter.Bytes > context.Budgets.MaxSourceBytes)
        {
            return NodeOutcome.Failed(
    ArticleEmbedErrorCode.SizeExceeded, "source_bytes_exceeded", nodeTarget: target);
        }

        ArticleEmbedSafeProjectionReference? projection = SelectProjection(facts, target, out ArticleEmbedErrorCode? coordinateError);
        if (projection is null)
        {
            return NodeOutcome.Failed(
                coordinateError!.Value,
                coordinateError == ArticleEmbedErrorCode.HeadingMissing ? "heading_missing"
                    : coordinateError == ArticleEmbedErrorCode.HeadingDuplicate ? "heading_duplicate"
                    : coordinateError == ArticleEmbedErrorCode.BlockMissing ? "block_missing"
                    : "block_duplicate",
                facts.Visibility,
                facts.Lifecycle,
                facts.Permission,
                nodeTarget: target);
        }

        var coordinate = ArticleEmbedContractValidator.Seal(new ArticleEmbedDependencyCoordinate(
            ArticleEmbedSchemas.DependencyCoordinate,
            ArticleEmbedSchemas.Version,
            target,
            facts.ResolvedRevision,
            facts.TargetVersionIdentity,
            projection.ProjectionIdentity,
            projection.ContentDigest,
            string.Empty));

        var outcome = new NodeOutcome(
            ArticleEmbedProviderResultStatus.Resolved,
            coordinate,
            projection,
            new ArticleEmbedAttribution(
                facts.PortableArticleIdentity,
                facts.ResolvedRevision,
                facts.AttributionDisplayText,
                ArticleEmbedContractDigest.ComputeAttribution(
                    facts.PortableArticleIdentity,
                    facts.ResolvedRevision,
                    facts.AttributionDisplayText)),
            facts.Visibility,
            facts.Lifecycle,
            facts.Permission,
            null,
            [],
            facts.LatestObservedRevision > facts.ResolvedRevision,
            facts.Visibility == ArticleEmbedVisibilityStatus.Public
                && facts.Lifecycle == ArticleEmbedLifecycleStatus.Published
                ? ArticleEmbedPublicationEligibility.PublicationEligible
                : ArticleEmbedPublicationEligibility.AuthoringOnly,
            CacheHit: false,
            PathSensitive: false,
            NodeTarget: target);
        return outcome;
    }

    private static NodeOutcome? ClassifyProjection(Context context, ArticleEmbedTargetFacts facts)
    {
        // Check the actor/site boundary before exposing target generation or lifecycle facts.
        if (facts.SiteIdentity != context.Snapshot.Actor.SiteIdentity)
        {
            return NodeOutcome.Failed(ArticleEmbedErrorCode.PermissionUnknown, "site_mismatch");
        }
        if (facts.Permission == ArticleEmbedPermissionStatus.Denied)
        {
            return NodeOutcome.Failed(
                ArticleEmbedErrorCode.PermissionDenied,
                "permission_denied",
                permission: ArticleEmbedPermissionStatus.Denied);
        }
        if (facts.Permission == ArticleEmbedPermissionStatus.Unknown)
        {
            return NodeOutcome.Failed(ArticleEmbedErrorCode.PermissionUnknown, "permission_unknown");
        }
        if (facts.AuthorityGeneration != context.Snapshot.AuthorityGeneration
            || facts.SourceRevision != facts.ResolvedRevision)
        {
            return NodeOutcome.Failed(
                ArticleEmbedErrorCode.StaleTarget,
                facts.AuthorityGeneration != context.Snapshot.AuthorityGeneration
                    ? "authority_generation_drift" : "target_source_revision_drift",
                facts.Visibility,
                facts.Lifecycle,
                facts.Permission);
        }
        return facts.Lifecycle switch
        {
            ArticleEmbedLifecycleStatus.Archived => NodeOutcome.Failed(
                ArticleEmbedErrorCode.Archived, "target_archived", facts.Visibility, facts.Lifecycle, facts.Permission),
            ArticleEmbedLifecycleStatus.Deleted => NodeOutcome.Failed(
                ArticleEmbedErrorCode.Deleted, "target_deleted", facts.Visibility, facts.Lifecycle, facts.Permission),
            ArticleEmbedLifecycleStatus.Unknown => NodeOutcome.Failed(
                ArticleEmbedErrorCode.Unpublished, "lifecycle_unknown", facts.Visibility, facts.Lifecycle, facts.Permission),
            _ => facts.Visibility == ArticleEmbedVisibilityStatus.Unknown
                ? NodeOutcome.Failed(
                    ArticleEmbedErrorCode.Unpublished, "visibility_unknown", facts.Visibility, facts.Lifecycle, facts.Permission)
                : null
        };
    }
}
