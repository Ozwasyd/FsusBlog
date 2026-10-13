namespace FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;

/// <summary>
/// Deterministic authoring-scope embed resolver. It consumes sealed #2454 authoring requests plus a sealed
/// authority snapshot of caller-verified current facts; it never parses Markdown, never reads rendered output,
/// never mutates targets or host source, and never persists cache state beyond one resolution.
/// </summary>
public static class ArticleEmbedAuthoringResolver
{
    private static readonly ArticleEmbedActorContext s_rejectedActor =
        new("rejected:unknown", "rejected:unknown", new string('0', 64));

    private static readonly ArticleEmbedRuntimeContext s_rejectedRuntime =
        new("rejected", 0, ArticleEmbedSchemas.ProviderRuntime, new string('0', 64));

    private static readonly ArticleEmbedDocumentIdentity s_rejectedDocument = new("rejected:unknown", 1);

    /// <summary>
    /// Resolves only supplied article/heading/block requests against the sealed current authority.
    /// Nested directives remain authority facts for the explicit graph stage; this provider never expands them.
    /// </summary>
    public static ArticleEmbedAuthoringResolution Resolve(
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
            NodeOutcome outcome = ResolveTarget(context, request);
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

    internal static ArticleEmbedAuthoringResolution Rejected(
        string reasonCode,
        ArticleEmbedAuthoritySnapshot? snapshot,
        ArticleEmbedResolutionBudgetLimits? budgets,
        int requestCount)
    {
        ArticleEmbedAuthoringReceipt receipt = SealReceipt(new ArticleEmbedAuthoringReceipt(
            ArticleEmbedAuthoringSchemas.Receipt,
            ArticleEmbedAuthoringSchemas.Version,
            snapshot?.HostPortableArticleIdentity ?? "rejected:unknown",
            snapshot?.HostDocument ?? s_rejectedDocument,
            snapshot?.HostSourceRevision ?? 0,
            snapshot?.AuthorityGeneration ?? 0,
            snapshot?.SnapshotDigest ?? new string('0', 64),
            snapshot?.Actor ?? s_rejectedActor,
            snapshot?.Runtime ?? s_rejectedRuntime,
            snapshot?.MaterialLocale,
            snapshot?.MaterialTheme,
            budgets ?? new ArticleEmbedResolutionBudgetLimits(0, 0, 0, 0, 0),
            new ArticleEmbedBudgetObservation(0, 0, 0, 0),
            requestCount,
            0,
            requestCount,
            0,
            0,
            [],
            string.Empty));

        return Seal(new ArticleEmbedAuthoringResolution(
            ArticleEmbedAuthoringSchemas.Resolution,
            ArticleEmbedAuthoringSchemas.Version,
            ArticleEmbedAuthoringResolutionStatus.Rejected,
            reasonCode,
            [],
            receipt,
            string.Empty));
    }

    private static NodeOutcome ResolveTarget(
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

    private static NodeOutcome? BindHost(Context context, ArticleEmbedProviderRequest request)
    {
        ArticleEmbedAuthoritySnapshot snapshot = context.Snapshot;
        if (request.HostPortableArticleIdentity != snapshot.HostPortableArticleIdentity
            || request.HostDocument != snapshot.HostDocument
            || request.SourceRevision != snapshot.HostSourceRevision
            || request.ContentDigest != snapshot.HostSourceDigest)
        {
            return NodeOutcome.Failed(ArticleEmbedErrorCode.StaleSource, "host_source_drift");
        }
        if (request.Actor != snapshot.Actor)
        {
            return NodeOutcome.Failed(ArticleEmbedErrorCode.StaleSource, "permission_context_drift");
        }
        if (request.Runtime != snapshot.Runtime)
        {
            return NodeOutcome.Failed(ArticleEmbedErrorCode.StaleRuntime, "runtime_drift");
        }
        return null;
    }

    internal static NodeKey KeyOf(ArticleEmbedTargetIdentity target)
        => new(target.PortableArticleIdentity, target.Kind, target.HeadingIdentity, target.BlockAnchor);

    // One current projection owner, reused by the graph stage for typed nested targets.
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
        NodeOutcome? factFailure = Classify(context, facts);
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

    private static NodeOutcome? Classify(Context context, ArticleEmbedTargetFacts facts)
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

    private static ArticleEmbedSafeProjectionReference? SelectProjection(
        ArticleEmbedTargetFacts facts,
        ArticleEmbedTargetIdentity target,
        out ArticleEmbedErrorCode? error)
    {
        error = null;
        switch (target.Kind)
        {
            case ArticleEmbedTargetKind.Article:
                return facts.BodyProjection;
            case ArticleEmbedTargetKind.Heading:
                {
                    ArticleEmbedHeadingFact[] matches = facts.Headings
                        .Where(heading => heading.HeadingIdentity == target.HeadingIdentity)
                        .ToArray();
                    if (matches.Length == 0)
                    {
                        error = ArticleEmbedErrorCode.HeadingMissing;
                        return null;
                    }
                    if (matches.Length > 1)
                    {
                        error = ArticleEmbedErrorCode.HeadingDuplicate;
                        return null;
                    }
                    return matches[0].SubtreeProjection;
                }
            case ArticleEmbedTargetKind.Block:
                {
                    ArticleEmbedBlockFact[] matches = facts.Blocks
                        .Where(block => block.BlockAnchor == target.BlockAnchor)
                        .ToArray();
                    if (matches.Length == 0)
                    {
                        error = ArticleEmbedErrorCode.BlockMissing;
                        return null;
                    }
                    if (matches.Length > 1)
                    {
                        error = ArticleEmbedErrorCode.BlockDuplicate;
                        return null;
                    }
                    return matches[0].BlockProjection;
                }
            default:
                error = ArticleEmbedErrorCode.InvalidTarget;
                return null;
        }
    }

    private static ArticleEmbedAuthoringReceipt SealReceipt(ArticleEmbedAuthoringReceipt receipt)
        => receipt with
        {
            ReceiptDigest = ArticleEmbedAuthoringDigest.ComputeReceipt(receipt with
            {
                ReceiptDigest = string.Empty
            })
        };

    private static ArticleEmbedAuthoringResolution Seal(ArticleEmbedAuthoringResolution resolution)
        => resolution with
        {
            ResolutionDigest = ArticleEmbedAuthoringDigest.ComputeResolution(
                resolution with
                {
                    ResolutionDigest = string.Empty
                })
        };

    internal sealed record NodeKey(
        string PortableArticleIdentity,
        ArticleEmbedTargetKind Kind,
        string? HeadingIdentity,
        string? BlockAnchor);

    internal sealed record NodeOutcome(
        ArticleEmbedProviderResultStatus Status,
        ArticleEmbedDependencyCoordinate? Coordinate,
        ArticleEmbedSafeProjectionReference? Projection,
        ArticleEmbedAttribution? Attribution,
        ArticleEmbedVisibilityStatus Visibility,
        ArticleEmbedLifecycleStatus Lifecycle,
        ArticleEmbedPermissionStatus Permission,
        ArticleEmbedError? Error,
        IReadOnlyList<ArticleEmbedResolvedNode> Children,
        bool UpdateAvailable,
        ArticleEmbedPublicationEligibility Eligibility,
        bool CacheHit,
        bool PathSensitive,
        ArticleEmbedTargetIdentity? NodeTarget)
    {
        public static NodeOutcome Failed(
            ArticleEmbedErrorCode code,
            string reason,
            ArticleEmbedVisibilityStatus visibility = ArticleEmbedVisibilityStatus.Unknown,
            ArticleEmbedLifecycleStatus lifecycle = ArticleEmbedLifecycleStatus.Unknown,
            ArticleEmbedPermissionStatus permission = ArticleEmbedPermissionStatus.Unknown,
            ArticleEmbedTargetIdentity? nodeTarget = null)
        {
            bool pathSensitive = code is ArticleEmbedErrorCode.Cycle
                or ArticleEmbedErrorCode.DepthExceeded
                or ArticleEmbedErrorCode.SizeExceeded
                or ArticleEmbedErrorCode.TimeExceeded
                or ArticleEmbedErrorCode.StaleSource;
            return new NodeOutcome(
                ArticleEmbedProviderResultStatus.Failed,
                null,
                null,
                null,
                visibility,
                lifecycle,
                permission,
                new ArticleEmbedError(code, reason),
                [],
                false,
                ArticleEmbedPublicationEligibility.AuthoringOnly,
                false,
                pathSensitive,
                nodeTarget);
        }

        public ArticleEmbedProviderResult ToResult(ArticleEmbedProviderRequest request, Context context)
            => ArticleEmbedContractValidator.Seal(new ArticleEmbedProviderResult(
                ArticleEmbedSchemas.ProviderResult,
                ArticleEmbedSchemas.Version,
                request.RequestId,
                request.RequestDigest,
                Status,
                Coordinate,
                Projection,
                Attribution,
                Visibility,
                Lifecycle,
                Permission,
                context.Meter.Observed(context.Time, context.Started),
                Error,
                string.Empty));

        public ArticleEmbedResolvedNode ToNode(ArticleEmbedDirectiveProjection directive, ArticleEmbedTargetIdentity? target)
            => new(directive, target, Status, Coordinate, Error, Children);
    }

    internal sealed class Context
    {
        public Context(
            ArticleEmbedAuthoritySnapshot snapshot,
            ArticleEmbedResolutionBudgetLimits budgets,
            TimeProvider time,
            long started)
        {
            Snapshot = snapshot;
            Budgets = budgets;
            Time = time;
            Started = started;
            FactsByIdentity = snapshot.Targets
                .GroupBy(static facts => facts.PortableArticleIdentity, StringComparer.Ordinal)
                .ToDictionary(static group => group.Key, static group => group.ToList(), StringComparer.Ordinal);
        }

        public ArticleEmbedAuthoritySnapshot Snapshot
        {
            get;
        }
        public ArticleEmbedResolutionBudgetLimits Budgets
        {
            get;
        }
        public TimeProvider Time
        {
            get;
        }
        public long Started
        {
            get;
        }
        public Dictionary<string, List<ArticleEmbedTargetFacts>> FactsByIdentity
        {
            get;
        }
        public Dictionary<NodeKey, NodeOutcome> Memo { get; } = new();
        public Meter Meter { get; } = new();
    }

    internal sealed class Meter
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
        public int CacheHits
        {
            get; private set;
        }

        public void ObserveNode() => Nodes++;
        public void ObserveMessage() => Messages++;
        public void ObserveBytes(long bytes) => Bytes += bytes;
        public void Hit() => CacheHits++;

        public void ObserveDepth(int depth)
        {
            if (depth > MaxDepth)
            {
                MaxDepth = depth;
            }
        }

        public long Elapsed(TimeProvider time, long started)
            => (long)time.GetElapsedTime(started).TotalMilliseconds;

        public ArticleEmbedBudgetObservation Observed(TimeProvider time, long started)
            => new(MaxDepth, Nodes, Bytes, Elapsed(time, started));
    }
}
