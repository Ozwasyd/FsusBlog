using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;

namespace FsusBlog.Shared.Contracts.ArticleEmbeds.Publication;

/// <summary>
/// Deterministic publication dependency planner. It consumes sealed #2454 publication-plan requests plus a sealed
/// public authority snapshot; it never parses Markdown, never reads rendered output, never consults an authoring
/// cache or a previous publication, and never mutates host source or targets. Every evaluated embed occurrence
/// becomes one edge; any non-public, unknown, invalid, cyclic or over-budget target blocks the whole plan so the
/// publication writer can emit zero business writes before commit.
/// </summary>
public static class ArticleEmbedPublicationPlanner
{
    private static readonly ArticleEmbedActorContext s_rejectedActor =
        new("rejected:unknown", "rejected:unknown", new string('0', 64));

    private static readonly ArticleEmbedRuntimeContext s_rejectedRuntime =
        new("rejected", 0, ArticleEmbedSchemas.ProviderRuntime, new string('0', 64));

    private static readonly ArticleEmbedDocumentIdentity s_rejectedDocument = new("rejected:unknown", 1);

    /// <summary>
    /// Plans every supplied publication-plan request against one sealed authority snapshot under shared budgets.
    /// Nested embeds expand inside the same graph and budget context; the resulting plan is sealed only when every
    /// edge froze to an exact public coordinate.
    /// </summary>
    public static ArticleEmbedPublicationPlan Plan(
        IReadOnlyList<ArticleEmbedProviderRequest>? requests,
        ArticleEmbedPublicationAuthority? authority,
        ArticleEmbedResolutionBudgetLimits? budgets,
        TimeProvider? time = null)
    {
        time ??= TimeProvider.System;
        long started = time.GetTimestamp();

        ArticleEmbedValidationResult budgetCheck = ArticleEmbedAuthoringContractValidator.ValidateBudgets(budgets);
        if (!budgetCheck.IsValid)
        {
            return Blocked(budgetCheck.ReasonCode!, authority, budgets, requests?.Count ?? 0);
        }

        ArticleEmbedValidationResult authorityCheck = ArticleEmbedPublicationContractValidator.Validate(authority);
        if (!authorityCheck.IsValid)
        {
            return Blocked(authorityCheck.ReasonCode!, authority, budgets!, requests?.Count ?? 0);
        }

        if (!authority!.FrozenArtifactRetention)
        {
            return Blocked(
                "frozen_artifact_retention_unavailable",
                authority,
                budgets!,
                requests?.Count ?? 0);
        }

        if (requests is null)
        {
            return Blocked("article_embed_publication_requests_missing", authority, budgets!, 0);
        }
        if (requests.Count > budgets!.MaxExpandedNodes)
        {
            return Blocked("article_embed_publication_request_set_exceeds_budget", authority, budgets, requests.Count);
        }

        var context = new Context(authority, budgets, time, started);
        var items = new List<ArticleEmbedPublicationReceiptItem>(requests.Count);
        foreach (ArticleEmbedProviderRequest request in requests)
        {
            int edgeStart = context.Edges.Count;
            NodeOutcome outcome = EmitEdge(
                context,
                request,
                authority.HostPortableArticleIdentity,
                authority.HostCurrentRevision,
                request.Directive,
                request.Target,
                depth: 1,
                path: new HashSet<NodeKey> { HostKey(authority) },
                topLevel: true);
            int descendantEdges = context.Edges.Count - edgeStart - 1;
            int blockedDescendants = context.Edges
                .Skip(edgeStart + 1)
                .Count(static edge => edge.Status == ArticleEmbedPublicationEdgeStatus.Blocked);
            items.Add(new ArticleEmbedPublicationReceiptItem(
                request.RequestId,
                request.Target,
                outcome.EdgeStatus,
                outcome.Error?.Code,
                outcome.Coordinate?.ResolvedRevision,
                descendantEdges,
                blockedDescendants,
                outcome.EdgeDigest));
        }

        ArticleEmbedPublicationEdge? firstBlocked = context.Edges
            .FirstOrDefault(static edge => edge.Status == ArticleEmbedPublicationEdgeStatus.Blocked);
        ArticleEmbedPublicationPlanStatus status = firstBlocked is null
            ? ArticleEmbedPublicationPlanStatus.Sealed
            : ArticleEmbedPublicationPlanStatus.Blocked;
        string? blockedReason = firstBlocked?.Error?.SafeReasonCode;

        ArticleEmbedPublicationReceipt receipt = SealReceipt(new ArticleEmbedPublicationReceipt(
            ArticleEmbedPublicationSchemas.Receipt,
            ArticleEmbedPublicationSchemas.Version,
            authority.HostPortableArticleIdentity,
            authority.HostDocument,
            authority.HostCurrentRevision,
            authority.HostSourceDigest,
            authority.PublicationRequestId,
            authority.ExpectedRevision,
            authority.AuthorityGeneration,
            authority.AuthorityDigest,
            authority.Actor,
            authority.Runtime,
            authority.MaterialLocale,
            authority.MaterialTheme,
            budgets,
            context.Meter.Observed(context.Time, context.Started),
            requests.Count,
            context.Edges.Count(static edge => edge.Status == ArticleEmbedPublicationEdgeStatus.Frozen),
            context.Edges.Count(static edge => edge.Status == ArticleEmbedPublicationEdgeStatus.Blocked),
            context.Meter.MaxDepth,
            ArticleEmbedPublicationDigest.ComputeGraph(context.Edges),
            items,
            string.Empty));

        return SealPlan(new ArticleEmbedPublicationPlan(
            ArticleEmbedPublicationSchemas.Plan,
            ArticleEmbedPublicationSchemas.Version,
            status,
            blockedReason,
            context.Edges.ToArray(),
            receipt,
            string.Empty));
    }

    private static ArticleEmbedPublicationPlan Blocked(
        string reasonCode,
        ArticleEmbedPublicationAuthority? authority,
        ArticleEmbedResolutionBudgetLimits? budgets,
        int requestCount)
    {
        ArticleEmbedPublicationReceipt receipt = SealReceipt(new ArticleEmbedPublicationReceipt(
            ArticleEmbedPublicationSchemas.Receipt,
            ArticleEmbedPublicationSchemas.Version,
            authority?.HostPortableArticleIdentity ?? "rejected:unknown",
            authority?.HostDocument ?? s_rejectedDocument,
            authority?.HostCurrentRevision ?? 0,
            authority?.HostSourceDigest ?? new string('0', 64),
            authority?.PublicationRequestId ?? "rejected:unknown",
            authority?.ExpectedRevision ?? 0,
            authority?.AuthorityGeneration ?? 0,
            authority?.AuthorityDigest ?? new string('0', 64),
            authority?.Actor ?? s_rejectedActor,
            authority?.Runtime ?? s_rejectedRuntime,
            authority?.MaterialLocale,
            authority?.MaterialTheme,
            budgets ?? new ArticleEmbedResolutionBudgetLimits(0, 0, 0, 0, 0),
            new ArticleEmbedBudgetObservation(0, 0, 0, 0),
            requestCount,
            0,
            0,
            0,
            ArticleEmbedPublicationDigest.ComputeGraph([]),
            [],
            string.Empty));

        return SealPlan(new ArticleEmbedPublicationPlan(
            ArticleEmbedPublicationSchemas.Plan,
            ArticleEmbedPublicationSchemas.Version,
            ArticleEmbedPublicationPlanStatus.Blocked,
            reasonCode,
            [],
            receipt,
            string.Empty));
    }

    private static NodeKey HostKey(ArticleEmbedPublicationAuthority authority)
        => new(authority.HostPortableArticleIdentity, ArticleEmbedTargetKind.Article, null, null);

    private static NodeOutcome EmitEdge(
        Context context,
        ArticleEmbedProviderRequest? request,
        string ownerIdentity,
        long ownerRevision,
        ArticleEmbedDirectiveProjection? directive,
        ArticleEmbedTargetIdentity? target,
        int depth,
        HashSet<NodeKey> path,
        bool topLevel)
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
            return RecordBlocked(context, ownerIdentity, ownerRevision, directive, target, depth, failure);
        }

        if (context.Meter.Nodes > context.Budgets.MaxExpandedNodes)
        {
            return RecordBlocked(context, ownerIdentity, ownerRevision, directive, target, depth,
                new ArticleEmbedError(ArticleEmbedErrorCode.SizeExceeded, "expanded_nodes_exceeded"));
        }
        if (depth > context.Budgets.MaxDepth)
        {
            return RecordBlocked(context, ownerIdentity, ownerRevision, directive, target, depth,
                new ArticleEmbedError(ArticleEmbedErrorCode.DepthExceeded, "depth_exceeded"));
        }
        if (context.Meter.Elapsed(context.Time, context.Started) > context.Budgets.MaxElapsedMilliseconds)
        {
            return RecordBlocked(context, ownerIdentity, ownerRevision, directive, target, depth,
                new ArticleEmbedError(ArticleEmbedErrorCode.TimeExceeded, "elapsed_exceeded"));
        }

        var key = new NodeKey(target!.PortableArticleIdentity, target.Kind, target.HeadingIdentity, target.BlockAnchor);
        if (path.Contains(key))
        {
            return RecordBlocked(context, ownerIdentity, ownerRevision, directive, target, depth,
                new ArticleEmbedError(ArticleEmbedErrorCode.Cycle, "embed_cycle"));
        }

        if (context.Memo.TryGetValue(key, out NodeOutcome? cached))
        {
            return Record(context, ownerIdentity, ownerRevision, directive!, target, depth, cached, expand: false);
        }

        context.Meter.ObserveMessage();
        if (context.Meter.Messages > context.Budgets.MaxAuthorityMessages)
        {
            return RecordBlocked(context, ownerIdentity, ownerRevision, directive, target, depth,
                new ArticleEmbedError(ArticleEmbedErrorCode.SizeExceeded, "authority_messages_exceeded"));
        }

        context.FactsByIdentity.TryGetValue(
            target.PortableArticleIdentity,
            out List<ArticleEmbedPublicationTargetFacts>? records);
        if (records is null || records.Count == 0)
        {
            return RecordMemoized(context, ownerIdentity, ownerRevision, directive!, target, depth, key,
                NodeOutcome.Blocked(new ArticleEmbedError(ArticleEmbedErrorCode.Missing, "target_missing")));
        }
        if (records.Count > 1)
        {
            return RecordMemoized(context, ownerIdentity, ownerRevision, directive!, target, depth, key,
                NodeOutcome.Blocked(new ArticleEmbedError(ArticleEmbedErrorCode.Ambiguous, "target_ambiguous")));
        }

        ArticleEmbedPublicationTargetFacts facts = records[0];
        ArticleEmbedError? factFailure = ClassifyPublic(context, facts);
        if (factFailure is not null)
        {
            return RecordMemoized(context, ownerIdentity, ownerRevision, directive!, target, depth, key,
                NodeOutcome.Blocked(factFailure));
        }

        context.Meter.ObserveBytes(facts.SourceByteCount);
        if (context.Meter.Bytes > context.Budgets.MaxSourceBytes)
        {
            return RecordBlocked(context, ownerIdentity, ownerRevision, directive, target, depth,
                new ArticleEmbedError(ArticleEmbedErrorCode.SizeExceeded, "source_bytes_exceeded"));
        }

        ArticleEmbedSafeProjectionReference? projection = SelectProjection(facts, target, out ArticleEmbedError? coordinateError);
        if (projection is null)
        {
            return RecordMemoized(context, ownerIdentity, ownerRevision, directive!, target, depth, key,
                NodeOutcome.Blocked(coordinateError!));
        }

        var coordinate = ArticleEmbedContractValidator.Seal(new ArticleEmbedDependencyCoordinate(
            ArticleEmbedSchemas.DependencyCoordinate,
            ArticleEmbedSchemas.Version,
            target,
            facts.ResolvedPublicRevision,
            facts.TargetVersionIdentity,
            projection.ProjectionIdentity,
            projection.ContentDigest,
            string.Empty));

        var resolved = new NodeOutcome(
            ArticleEmbedPublicationEdgeStatus.Frozen,
            coordinate,
            null,
            facts,
            string.Empty);

        NodeOutcome edge = Record(context, ownerIdentity, ownerRevision, directive!, target, depth, resolved, expand: true, path, key, request);
        if (!edge.PathSensitive)
        {
            context.Memo[key] = resolved with
            {
                PathSensitive = false
            };
        }
        return edge;
    }

    private static NodeOutcome Record(
        Context context,
        string ownerIdentity,
        long ownerRevision,
        ArticleEmbedDirectiveProjection? directive,
        ArticleEmbedTargetIdentity? target,
        int depth,
        NodeOutcome outcome,
        bool expand,
        HashSet<NodeKey>? path = null,
        NodeKey? key = null,
        ArticleEmbedProviderRequest? request = null)
    {
        var edge = ArticleEmbedPublicationContractValidator.Seal(new ArticleEmbedPublicationEdge(
            ArticleEmbedPublicationSchemas.Edge,
            ArticleEmbedPublicationSchemas.Version,
            ownerIdentity,
            ownerRevision,
            directive,
            target,
            outcome.EdgeStatus,
            outcome.Coordinate,
            outcome.Error,
            depth,
            outcome.Facts?.LatestObservedRevision ?? 0,
            string.Empty));
        context.Edges.Add(edge);
        NodeOutcome recorded = outcome with
        {
            EdgeDigest = edge.EdgeDigest
        };

        if (!expand || outcome.Facts is null || path is null || key is null)
        {
            return recorded;
        }

        path.Add(key);
        bool pathSensitive = false;
        foreach (ArticleEmbedDirectiveProjection nested in OrderedNested(outcome.Facts))
        {
            ArticleEmbedTargetIdentity? nestedTarget = null;
            if (!Enum.IsDefined(nested.Mode)
                || !ArticleEmbedTargetCodec.TryDecode(nested.TargetToken, nested.Mode, out nestedTarget).IsValid
                || nestedTarget is null)
            {
                context.Meter.ObserveNode();
                context.Meter.ObserveDepth(depth + 1);
                RecordBlocked(
                    context,
                    outcome.Facts.PortableArticleIdentity,
                    outcome.Facts.ResolvedPublicRevision,
                    nested,
                    null,
                    depth + 1,
                    new ArticleEmbedError(ArticleEmbedErrorCode.InvalidTarget, "nested_target_invalid"));
                continue;
            }
            NodeOutcome child = EmitEdge(
                context,
                request,
                outcome.Facts.PortableArticleIdentity,
                outcome.Facts.ResolvedPublicRevision,
                nested,
                nestedTarget,
                depth + 1,
                path,
                topLevel: false);
            pathSensitive |= child.PathSensitive;
        }
        path.Remove(key);
        return recorded with
        {
            PathSensitive = pathSensitive
        };
    }

    private static NodeOutcome RecordBlocked(
        Context context,
        string ownerIdentity,
        long ownerRevision,
        ArticleEmbedDirectiveProjection? directive,
        ArticleEmbedTargetIdentity? target,
        int depth,
        ArticleEmbedError error)
        => Record(
            context,
            ownerIdentity,
            ownerRevision,
            directive,
            target,
            depth,
            NodeOutcome.Blocked(error),
            expand: false) with
        {
            PathSensitive = error.Code is ArticleEmbedErrorCode.Cycle
                or ArticleEmbedErrorCode.DepthExceeded
                or ArticleEmbedErrorCode.SizeExceeded
                or ArticleEmbedErrorCode.TimeExceeded
                or ArticleEmbedErrorCode.StaleSource
        };

    private static NodeOutcome RecordMemoized(
        Context context,
        string ownerIdentity,
        long ownerRevision,
        ArticleEmbedDirectiveProjection directive,
        ArticleEmbedTargetIdentity target,
        int depth,
        NodeKey key,
        NodeOutcome outcome)
    {
        context.Memo[key] = outcome;
        return Record(context, ownerIdentity, ownerRevision, directive, target, depth, outcome, expand: false);
    }

    private static IReadOnlyList<ArticleEmbedDirectiveProjection> OrderedNested(ArticleEmbedPublicationTargetFacts facts)
        => facts.NestedDirectives
            .OrderBy(static directive => directive.RawRange.Start)
            .ThenBy(static directive => directive.RawRange.End)
            .ThenBy(static directive => directive.TargetToken, StringComparer.Ordinal)
            .ToArray();

    /// <summary>Publication-side classification: only published, public, citable, package-complete targets freeze.</summary>
    private static ArticleEmbedError? ClassifyPublic(Context context, ArticleEmbedPublicationTargetFacts facts)
    {
        if (facts.AuthorityGeneration != context.Authority.AuthorityGeneration)
        {
            return new ArticleEmbedError(ArticleEmbedErrorCode.StaleTarget, "authority_generation_drift");
        }
        if (facts.SiteIdentity != context.Authority.Actor.SiteIdentity)
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
        return facts.Lifecycle switch
        {
            ArticleEmbedLifecycleStatus.Draft => new ArticleEmbedError(ArticleEmbedErrorCode.Draft, "target_draft"),
            ArticleEmbedLifecycleStatus.Scheduled => new ArticleEmbedError(ArticleEmbedErrorCode.Unpublished, "target_scheduled_not_public"),
            ArticleEmbedLifecycleStatus.Archived => new ArticleEmbedError(ArticleEmbedErrorCode.Archived, "target_archived"),
            ArticleEmbedLifecycleStatus.Deleted => new ArticleEmbedError(ArticleEmbedErrorCode.Deleted, "target_deleted"),
            ArticleEmbedLifecycleStatus.Unknown => new ArticleEmbedError(ArticleEmbedErrorCode.Unpublished, "lifecycle_unknown"),
            _ => facts.Visibility switch
            {
                ArticleEmbedVisibilityStatus.Private => new ArticleEmbedError(ArticleEmbedErrorCode.Private, "target_private"),
                ArticleEmbedVisibilityStatus.Unknown => new ArticleEmbedError(ArticleEmbedErrorCode.Unpublished, "visibility_unknown"),
                _ => !facts.RevisionPackageComplete
                    ? new ArticleEmbedError(ArticleEmbedErrorCode.Missing, "target_revision_incomplete")
                    : null
            }
        };
    }

    private static ArticleEmbedSafeProjectionReference? SelectProjection(
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
                    ArticleEmbedPublicationHeadingFact[] matches = facts.Headings
                        .Where(heading => heading.HeadingIdentity == target.HeadingIdentity)
                        .ToArray();
                    if (matches.Length == 0)
                    {
                        error = new ArticleEmbedError(ArticleEmbedErrorCode.HeadingMissing, "heading_missing");
                        return null;
                    }
                    if (matches.Length > 1)
                    {
                        error = new ArticleEmbedError(ArticleEmbedErrorCode.HeadingDuplicate, "heading_duplicate");
                        return null;
                    }
                    return matches[0].SubtreeProjection;
                }
            case ArticleEmbedTargetKind.Block:
                {
                    ArticleEmbedPublicationBlockFact[] matches = facts.Blocks
                        .Where(block => block.BlockAnchor == target.BlockAnchor)
                        .ToArray();
                    if (matches.Length == 0)
                    {
                        error = new ArticleEmbedError(ArticleEmbedErrorCode.BlockMissing, "block_missing");
                        return null;
                    }
                    if (matches.Length > 1)
                    {
                        error = new ArticleEmbedError(ArticleEmbedErrorCode.BlockDuplicate, "block_duplicate");
                        return null;
                    }
                    return matches[0].BlockProjection;
                }
            default:
                error = new ArticleEmbedError(ArticleEmbedErrorCode.InvalidTarget, "target_invalid");
                return null;
        }
    }

    /// <summary>Re-derives the request-level binding failure, in the exact planner check order.</summary>
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

    private static ArticleEmbedPublicationReceipt SealReceipt(ArticleEmbedPublicationReceipt receipt)
        => receipt with
        {
            ReceiptDigest = ArticleEmbedPublicationDigest.ComputeReceipt(receipt with
            {
                ReceiptDigest = string.Empty
            })
        };

    private static ArticleEmbedPublicationPlan SealPlan(ArticleEmbedPublicationPlan plan)
        => plan with
        {
            PlanDigest = ArticleEmbedPublicationDigest.ComputePlan(plan with
            {
                PlanDigest = string.Empty
            })
        };

    private sealed record NodeKey(
        string PortableArticleIdentity,
        ArticleEmbedTargetKind Kind,
        string? HeadingIdentity,
        string? BlockAnchor);

    private sealed record NodeOutcome(
        ArticleEmbedPublicationEdgeStatus EdgeStatus,
        ArticleEmbedDependencyCoordinate? Coordinate,
        ArticleEmbedError? Error,
        ArticleEmbedPublicationTargetFacts? Facts,
        string EdgeDigest,
        bool PathSensitive = false)
    {
        public static NodeOutcome Blocked(ArticleEmbedError error)
            => new(ArticleEmbedPublicationEdgeStatus.Blocked, null, error, null, string.Empty);
    }

    private sealed class Context
    {
        public Context(
            ArticleEmbedPublicationAuthority authority,
            ArticleEmbedResolutionBudgetLimits budgets,
            TimeProvider time,
            long started)
        {
            Authority = authority;
            Budgets = budgets;
            Time = time;
            Started = started;
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
        public TimeProvider Time
        {
            get;
        }
        public long Started
        {
            get;
        }
        public Dictionary<string, List<ArticleEmbedPublicationTargetFacts>> FactsByIdentity
        {
            get;
        }
        public List<ArticleEmbedPublicationEdge> Edges { get; } = new();
        public Dictionary<NodeKey, NodeOutcome> Memo { get; } = new();
        public Meter Meter { get; } = new();
    }

    private sealed class Meter
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

        public long Elapsed(TimeProvider time, long started)
            => (long)time.GetElapsedTime(started).TotalMilliseconds;

        public ArticleEmbedBudgetObservation Observed(TimeProvider time, long started)
            => new(MaxDepth, Nodes, Bytes, Elapsed(time, started));
    }
}
