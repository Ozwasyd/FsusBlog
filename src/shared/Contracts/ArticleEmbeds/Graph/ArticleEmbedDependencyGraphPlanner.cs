using FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;

using static FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring.ArticleEmbedAuthoringResolver;

namespace FsusBlog.Shared.Contracts.ArticleEmbeds.Graph;

/// <summary>
/// Explicit dependency expansion after the non-recursive current projection stage. Reuses the sole
/// projection selector, existing typed nodes and sealed resolution artifacts; owns no index or store.
/// A valid input is candidate evidence only, never an independently observed permission grant.
/// </summary>
public static class ArticleEmbedDependencyGraphPlanner
{
    public static ArticleEmbedAuthoringResolution Expand(
        IReadOnlyList<ArticleEmbedProviderRequest>? requests,
        ArticleEmbedAuthoritySnapshot? snapshot,
        ArticleEmbedResolutionBudgetLimits? budgets,
        ArticleEmbedAuthoringResolution? projection,
        TimeProvider? time = null)
    {
        if (!ArticleEmbedAuthoringVerifier.Verify(requests, snapshot, budgets, projection).Valid)
        {
            return Rejected("article_embed_graph_projection_unverified", snapshot, budgets, requests?.Count ?? 0);
        }
        if (projection!.Status == ArticleEmbedAuthoringResolutionStatus.Rejected)
        {
            return projection;
        }
        time ??= TimeProvider.System;
        var context = new Context(snapshot!, budgets!, time, time.GetTimestamp());
        var results = new List<ArticleEmbedAuthoringEmbedResult>(requests!.Count);
        var items = new List<ArticleEmbedAuthoringReceiptItem>(requests.Count);
        for (int index = 0; index < requests.Count; index++)
        {
            ArticleEmbedProviderRequest request = requests[index];
            ArticleEmbedAuthoringEmbedResult source = projection.Results[index];
            NodeOutcome outcome;
            if (source.Result.Status == ArticleEmbedProviderResultStatus.Failed)
            {
                context.Meter.ObserveNode();
                context.Meter.ObserveDepth(1);
                if (projection.Receipt.Items[index].CacheHit)
                {
                    context.Meter.Hit();
                }
                outcome = NodeOutcome.Failed(source.Result.Error!.Code, source.Result.Error.SafeReasonCode,
                    source.Result.Visibility, source.Result.Lifecycle, source.Result.Permission, request.Target) with
                {
                    CacheHit = projection.Receipt.Items[index].CacheHit
                };
            }
            else
            {
                outcome = ResolveNode(context, request, request.Target, 1,
                    new HashSet<NodeKey> { new(snapshot!.HostPortableArticleIdentity, ArticleEmbedTargetKind.Article, null, null) }, true);
            }
            AppendOutcome(context, request, outcome, results, items);
        }
        return Complete(requests, snapshot!, budgets!, context, results, items);
    }

    private static NodeOutcome ResolveNode(
        Context context,
        ArticleEmbedProviderRequest? request,
        ArticleEmbedTargetIdentity target,
        int depth,
        HashSet<NodeKey> path,
        bool topLevel)
    {
        context.Meter.ObserveNode();
        context.Meter.ObserveDepth(depth);
        if (request?.AbortSignal.IsCancellationRequested == true)
        {
            return NodeOutcome.Failed(
    ArticleEmbedErrorCode.StaleSource, "request_aborted", nodeTarget: target);
        }
        if (context.Meter.Nodes > context.Budgets.MaxExpandedNodes)
        {
            return NodeOutcome.Failed(
    ArticleEmbedErrorCode.SizeExceeded, "expanded_nodes_exceeded", nodeTarget: target);
        }
        if (depth > context.Budgets.MaxDepth)
        {
            return NodeOutcome.Failed(
    ArticleEmbedErrorCode.DepthExceeded, "depth_exceeded", nodeTarget: target);
        }
        if (context.Meter.Elapsed(context.Time, context.Started) > context.Budgets.MaxElapsedMilliseconds)
        {
            return NodeOutcome.Failed(
    ArticleEmbedErrorCode.TimeExceeded, "elapsed_exceeded", nodeTarget: target);
        }

        var key = new NodeKey(target.PortableArticleIdentity, target.Kind, target.HeadingIdentity, target.BlockAnchor);
        if (path.Contains(key))
        {
            return NodeOutcome.Failed(
    ArticleEmbedErrorCode.Cycle, "embed_cycle", nodeTarget: target);
        }
        if (context.Memo.TryGetValue(key, out NodeOutcome? cached))
        {
            if (topLevel)
            {
                context.Meter.Hit();
            }
            NodeOutcome memoized = cached with
            {
                CacheHit = topLevel
            };
            // Reuse authorized projection facts, not an expansion tied to an earlier path/budget.
            return memoized.Status == ArticleEmbedProviderResultStatus.Resolved
                ? ExpandChildren(context, request, target, key, depth, path, memoized)
                : memoized;
        }

        NodeOutcome leaf = ArticleEmbedAuthoringResolver.ProjectCurrent(context, target);
        if (leaf.Status != ArticleEmbedProviderResultStatus.Resolved)
        {
            if (!leaf.PathSensitive)
            {
                context.Memo[key] = leaf;
            }
            return leaf;
        }
        return ExpandChildren(context, request, target, key, depth, path, leaf);
    }

    private static NodeOutcome ExpandChildren(
        Context context,
        ArticleEmbedProviderRequest? request,
        ArticleEmbedTargetIdentity target,
        NodeKey key,
        int depth,
        HashSet<NodeKey> path,
        NodeOutcome leaf)
    {
        ArticleEmbedTargetFacts facts = context.FactsByIdentity[target.PortableArticleIdentity][0];
        if (target.Kind != ArticleEmbedTargetKind.Article && facts.NestedDirectives.Count != 0)
        {
            // Whole-article dependency facts cannot be guessed into a selected heading or block.
            return NodeOutcome.Failed(ArticleEmbedErrorCode.InvalidTarget, "projection_dependencies_unbound",
                facts.Visibility, facts.Lifecycle, facts.Permission, target);
        }
        path.Add(key);
        var children = new List<ArticleEmbedResolvedNode>(facts.NestedDirectives.Count);
        bool pathSensitive = false;
        foreach (ArticleEmbedDirectiveProjection nested in OrderedNested(facts))
        {
            NodeOutcome child = ResolveNested(context, request, nested, depth + 1, path);
            pathSensitive |= child.PathSensitive;
            children.Add(child.ToNode(nested, child.NodeTarget));
        }
        path.Remove(key);

        NodeOutcome outcome = leaf with
        {
            Children = children,
            PathSensitive = pathSensitive
        };
        if (!pathSensitive)
        {
            context.Memo[key] = outcome;
        }
        return outcome;
    }

    private static NodeOutcome ResolveNested(
        Context context,
        ArticleEmbedProviderRequest? request,
        ArticleEmbedDirectiveProjection directive,
        int depth,
        HashSet<NodeKey> path)
    {
        ArticleEmbedTargetIdentity? target = null;
        if (!Enum.IsDefined(directive.Mode)
            || !ArticleEmbedTargetCodec.TryDecode(directive.TargetToken, directive.Mode, out target).IsValid
            || target is null)
        {
            context.Meter.ObserveNode();
            context.Meter.ObserveDepth(depth);
            return new NodeOutcome(
                ArticleEmbedProviderResultStatus.Failed,
                null,
                null,
                null,
                ArticleEmbedVisibilityStatus.Unknown,
                ArticleEmbedLifecycleStatus.Unknown,
                ArticleEmbedPermissionStatus.Unknown,
                new ArticleEmbedError(ArticleEmbedErrorCode.InvalidTarget, "nested_target_invalid"),
                [],
                false,
                ArticleEmbedPublicationEligibility.AuthoringOnly,
                false,
                false,
                null);
        }
        return ResolveNode(context, request, target, depth, path, topLevel: false);
    }

    private static IReadOnlyList<ArticleEmbedDirectiveProjection> OrderedNested(ArticleEmbedTargetFacts facts)
        => facts.NestedDirectives
            .OrderBy(static directive => directive.RawRange.Start)
            .ThenBy(static directive => directive.RawRange.End)
            .ThenBy(static directive => directive.TargetToken, StringComparer.Ordinal)
            .ToArray();

}
