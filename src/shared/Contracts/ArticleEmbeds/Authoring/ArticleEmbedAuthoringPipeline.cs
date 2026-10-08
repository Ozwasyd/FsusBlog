using FsusBlog.Shared.Contracts.ArticleEmbeds.Graph;
using FsusBlog.Shared.Contracts.ArticleEmbeds.Relations;

namespace FsusBlog.Shared.Contracts.ArticleEmbeds.Authoring;

/// <summary>
/// Composes the existing non-recursive projection, explicit graph expansion and relation derivation.
/// Inputs still require the canonical caller's observed current-source/permission authority. This
/// composition performs no query, transport, publication, refresh execution, index or persistence write.
/// </summary>
public static class ArticleEmbedAuthoringPipeline
{
    public static (ArticleEmbedAuthoringResolution Projection, ArticleEmbedAuthoringResolution Graph,
        ArticleEmbedRelationDerivation Relations) Evaluate(
        IReadOnlyList<ArticleEmbedProviderRequest>? requests,
        ArticleEmbedAuthoritySnapshot? snapshot,
        ArticleEmbedResolutionBudgetLimits? budgets,
        TimeProvider? time = null)
    {
        ArticleEmbedAuthoringResolution projection = ArticleEmbedAuthoringResolver.Resolve(requests, snapshot, budgets, time);
        ArticleEmbedAuthoringResolution graph = ArticleEmbedDependencyGraphPlanner.Expand(requests, snapshot, budgets, projection, time);
        ArticleEmbedRelationDerivation relations = ArticleEmbedRelationDeriver.DeriveFromAuthoring(requests, snapshot, budgets, graph);
        return (projection, graph, relations);
    }
}
