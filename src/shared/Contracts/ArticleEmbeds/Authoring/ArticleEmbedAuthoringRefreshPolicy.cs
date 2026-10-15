using FsusBlog.Shared.Contracts.ArticleEmbeds.Graph;

namespace FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;

/// <summary>
/// Compares a caller-owned host draft dependency with an existing complete current authoring graph candidate.
/// A valid comparison means unchanged or update-available, not authorization, result admission,
/// an executable refresh plan or a committed revision. Persisted reads, revalidation, expected-revision
/// writes and audit/outbox remain the canonical draft owner's responsibility.
/// </summary>
public static class ArticleEmbedAuthoringRefreshPolicy
{
    /// <summary>
    /// Reuses the independent complete-graph verifier and exact target coordinates. It never looks up
    /// latest targets, changes source/directive bytes, mutates either coordinate or touches publications.
    /// Failure leaves <paramref name="updateAvailable"/> false. Callers must obtain the recorded
    /// coordinate from the exact authorized host draft, not an imported or unrelated publication.
    /// </summary>
    public static ArticleEmbedValidationResult TryCompare(
        IReadOnlyList<ArticleEmbedProviderRequest>? requests,
        ArticleEmbedAuthoritySnapshot? snapshot,
        ArticleEmbedResolutionBudgetLimits? budgets,
        ArticleEmbedAuthoringResolution? current,
        string? requestId,
        ArticleEmbedDependencyCoordinate? recordedCoordinate,
        out bool updateAvailable)
    {
        updateAvailable = false;
        if (!ArticleEmbedAuthoringContractValidator.ValidateBudgets(budgets).IsValid
            || requests is null
            || current?.Results is null
            || current.Receipt?.Items is null
            || requests.Count > budgets!.MaxExpandedNodes
            || current.Results.Count != requests.Count
            || current.Receipt.Items.Count != requests.Count
            || requests.Any(static request => request is null)
            || current.Results.Any(static result => result?.Result is null || result.Children is null)
            || !WithinTreeBudget(current.Results, budgets))
        {
            return Invalid("article_embed_refresh_candidate_unbounded_or_missing");
        }
        if (current.Status != ArticleEmbedAuthoringResolutionStatus.Completed
            || !ArticleEmbedDependencyGraphVerifier.Verify(requests, snapshot, budgets, current).Valid)
        {
            return Invalid("article_embed_refresh_candidate_invalid");
        }
        int selected = -1;
        for (int index = 0; index < requests.Count; index++)
        {
            if (requests[index].RequestId != requestId)
            {
                continue;
            }
            if (selected >= 0)
            {
                return Invalid("article_embed_refresh_request_ambiguous");
            }
            selected = index;
        }
        if (selected < 0)
        {
            return Invalid("article_embed_refresh_request_missing");
        }
        ArticleEmbedProviderRequest request = requests[selected];
        if (request.RequestedScope != ArticleEmbedRequestedScope.Authoring
            || request.AbortSignal.IsCancellationRequested)
        {
            return Invalid("article_embed_refresh_request_stale_or_wrong_scope");
        }
        if (!ArticleEmbedContractValidator.Validate(recordedCoordinate).IsValid
            || recordedCoordinate!.Target != request.Target)
        {
            return Invalid("article_embed_refresh_recorded_coordinate_mismatch");
        }
        ArticleEmbedAuthoringEmbedResult result = current.Results[selected];
        ArticleEmbedBudgetObservation observed = current.Receipt.Observed;
        if (result.Result.Status != ArticleEmbedProviderResultStatus.Resolved
            || observed.Depth > budgets.MaxDepth
            || observed.Nodes > budgets.MaxExpandedNodes
            || observed.Bytes > budgets.MaxSourceBytes
            || observed.ElapsedMilliseconds > budgets.MaxElapsedMilliseconds
            || !DependenciesResolved(result.Children))
        {
            return Invalid("article_embed_refresh_dependency_unavailable");
        }
        // The authority's latest-observed hint cannot advance the exact resolved coordinate.
        updateAvailable = recordedCoordinate != result.Result.Coordinate;
        return ArticleEmbedValidationResult.Valid();
    }

    private static bool WithinTreeBudget(
        IReadOnlyList<ArticleEmbedAuthoringEmbedResult> results,
        ArticleEmbedResolutionBudgetLimits budgets)
    {
        int nodes = results.Count;
        var pending = new Stack<(ArticleEmbedResolvedNode Node, int Depth)>();
        foreach (ArticleEmbedAuthoringEmbedResult result in results)
        {
            if (result.Children.Count > budgets.MaxExpandedNodes - pending.Count)
            {
                return false;
            }
            foreach (ArticleEmbedResolvedNode child in result.Children)
            {
                pending.Push((child, 2));
            }
        }
        while (pending.TryPop(out var item))
        {
            if (++nodes > budgets.MaxExpandedNodes || item.Depth > budgets.MaxDepth
                || item.Node?.Children is null || pending.Count > budgets.MaxExpandedNodes)
            {
                return false;
            }
            if (item.Node.Children.Count > budgets.MaxExpandedNodes - pending.Count)
            {
                return false;
            }
            foreach (ArticleEmbedResolvedNode child in item.Node.Children)
            {
                pending.Push((child, item.Depth + 1));
                if (pending.Count > budgets.MaxExpandedNodes)
                {
                    return false;
                }
            }
        }
        return true;
    }

    private static bool DependenciesResolved(IReadOnlyList<ArticleEmbedResolvedNode> children)
    {
        var pending = new Stack<ArticleEmbedResolvedNode>(children);
        while (pending.TryPop(out ArticleEmbedResolvedNode? node))
        {
            if (node.Status != ArticleEmbedProviderResultStatus.Resolved)
            {
                return false;
            }
            foreach (ArticleEmbedResolvedNode child in node.Children)
            {
                pending.Push(child);
            }
        }
        return true;
    }

    private static ArticleEmbedValidationResult Invalid(string reasonCode)
        => ArticleEmbedValidationResult.Invalid(reasonCode);
}
