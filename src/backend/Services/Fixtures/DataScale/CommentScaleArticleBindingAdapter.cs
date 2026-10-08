using System.Text.Json;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

/// <summary>
/// Consumes original article semantic validation and its immutable native identity
/// map. This verifies structural reference binding, not database provenance,
/// normalized-role receipt admission, credential validity or global uniqueness.
/// </summary>
public static class CommentScaleArticleBindingAdapter
{
    /// <summary>
    /// Binds an original owner's actual graph/map and bounded resolved payload to
    /// its complete assignment roster. Both original factory inputs are mandatory;
    /// diagnostic content/time/ordinal fallbacks are never selected by this adapter.
    /// Original allocation/artifact provenance and comment graph admission remain
    /// caller duties. No native identity is reserved or inferred here.
    /// </summary>
    public static CommentScaleGraphFactBindings BindResolved(
        CommentScalePlan commentPlan,
        ArticleScalePlan articlePlan,
        ArticleScaleArtifactBindings authoritativeArtifacts,
        ArticleScaleResolvedGraphBatch resolvedBatch,
        ArticleScaleArticleGraph graph,
        ArticleScaleGraphIdentityBindings identities,
        CommentScaleGraphOccurrence occurrence,
        CommentScaleArtifactReference nativeBindingReference,
        IReadOnlyList<CommentScaleRequestFactBinding> comments)
    {
        ArgumentNullException.ThrowIfNull(commentPlan);
        ArgumentNullException.ThrowIfNull(articlePlan);
        ArgumentNullException.ThrowIfNull(authoritativeArtifacts);
        ArgumentNullException.ThrowIfNull(resolvedBatch);
        ArgumentNullException.ThrowIfNull(graph);
        ArgumentNullException.ThrowIfNull(identities);
        ArgumentNullException.ThrowIfNull(occurrence);
        ArgumentNullException.ThrowIfNull(nativeBindingReference);
        ArgumentNullException.ThrowIfNull(comments);
        ArticleScalePlanValidator.Validate(articlePlan, authoritativeArtifacts).ThrowIfInvalid();
        _ = resolvedBatch.Resolve(articlePlan, graph.ArticleOrdinal, graph.Variant);
        CanonicalArticleGraphVerifier.VerifyArticleGraph(articlePlan, graph).ThrowIfInvalid();
        ArticleScaleArticleGraph expected = CanonicalArticleGraphFactory.BuildArticleGraph(
            articlePlan, graph.ArticleOrdinal, graph.Variant,
            ArticleScaleVariantContractCatalog.Get(graph.Variant), identities, resolvedBatch);
        if (graph.SemanticArticleId != expected.SemanticArticleId || graph.ArticleDigest != expected.ArticleDigest
            || graph.EdgeObligations is null || !graph.EdgeObligations.SequenceEqual(expected.EdgeObligations)
            || !JsonElement.DeepEquals(JsonSerializer.SerializeToElement(graph), JsonSerializer.SerializeToElement(expected)))
        {
            throw new InvalidOperationException("Comment article graph does not match its original resolved inputs and native identities.");
        }
        return Bind(commentPlan, articlePlan, authoritativeArtifacts, identities, occurrence,
            graph.SemanticArticleId, nativeBindingReference, comments);
    }

    /// <summary>
    /// Resolves one caller-selected original article role using the original map.
    /// No role, ordinal, ID or digest is inferred or allocated by the comment owner.
    /// Independently admitted article artifacts/map provenance remain caller duties.
    /// </summary>
    public static CommentScaleGraphFactBindings Bind(
        CommentScalePlan commentPlan,
        ArticleScalePlan articlePlan,
        ArticleScaleArtifactBindings authoritativeArtifacts,
        ArticleScaleGraphIdentityBindings identities,
        CommentScaleGraphOccurrence occurrence,
        string semanticArticleId,
        CommentScaleArtifactReference nativeBindingReference,
        IReadOnlyList<CommentScaleRequestFactBinding> comments)
    {
        ArgumentNullException.ThrowIfNull(commentPlan);
        ArgumentNullException.ThrowIfNull(articlePlan);
        ArgumentNullException.ThrowIfNull(authoritativeArtifacts);
        ArgumentNullException.ThrowIfNull(identities);
        ArgumentNullException.ThrowIfNull(occurrence);
        ArgumentNullException.ThrowIfNull(nativeBindingReference);
        ArgumentNullException.ThrowIfNull(comments);
        ArgumentException.ThrowIfNullOrWhiteSpace(semanticArticleId);

        ArticleScalePlanValidator.Validate(articlePlan, authoritativeArtifacts).ThrowIfInvalid();
        identities.ValidateFor(articlePlan, semanticArticleId);
        if (commentPlan.Schema != CommentScalePlanContract.Schema
            || commentPlan.ContentDigest != CommentScalePlanContract.ComputeDigest(commentPlan)
            || commentPlan.ArticlePlan is null || commentPlan.ArticlePlan.Schema != ArticleScaleContractIds.PlanSchema
            || commentPlan.ArticlePlan.ContentDigest != articlePlan.ContentDigest
            || commentPlan.Namespace != articlePlan.Namespace || commentPlan.ScaleTier != articlePlan.ScaleTier
            || commentPlan.ArticleCount < 0 || commentPlan.ArticleCount > articlePlan.ArticleCount
            || nativeBindingReference.Schema != ArticleScaleGraphIdentityBindings.Schema
            || nativeBindingReference.ContentDigest != identities.Digest)
        {
            throw new InvalidOperationException("Comment/article/map references do not exact-match their original contracts.");
        }
        CommentScaleScenario[] scenarios = commentPlan.Scenarios?.Where(item => item is not null
            && item.Role == occurrence.ScenarioRole && item.ArticleTargetRole == occurrence.ArticleTargetRole).ToArray()
            ?? [];
        if (scenarios.Length != 1 || occurrence.Repetition < 0 || occurrence.Repetition >= scenarios[0].Repetitions)
        {
            throw new InvalidOperationException("Comment/article binding has no unique requested occurrence.");
        }

        int articleId = checked((int)identities.Resolve(semanticArticleId));
        return new(occurrence, commentPlan.Namespace, commentPlan.ContentDigest, articlePlan.ContentDigest,
            semanticArticleId, articleId, nativeBindingReference, Array.AsReadOnly(comments.ToArray()));
    }
}
