using FsusBlog.Server.Services.Fixtures.DataScale;

namespace FsusBlog.QueryEvidence;

/// <summary>
/// Test/evidence-only ingress for existing producer components. Matching native
/// references establish linkage only; they never authenticate physical rows or
/// supply the receipt/coordinates required before the original query runner.
/// </summary>
public static class QueryProducerRoleIntake
{
    /// <summary>
    /// Connects the original article allocation binding and comment factory's
    /// resolved intent without serializing either into a replacement contract.
    /// This is one occurrence, not an enumerable traversal of a million-row plan.
    /// </summary>
    public static QueryProducerRoleInspection Inspect(
        ArticleScaleGraphIdentityBindings? articleBindings,
        CommentScaleResolvedGraphIntent? commentIntent)
    {
        var blockers = new List<string>();
        if (articleBindings is null)
        {
            blockers.Add("article_native_identity_bindings_missing");
        }
        if (commentIntent is null)
        {
            blockers.Add("comment_resolved_graph_intent_missing");
        }
        if (articleBindings is not null && commentIntent is not null)
        {
            if (articleBindings.PlanDigest != commentIntent.ArticlePlanDigest)
            {
                blockers.Add("comment_article_plan_binding_mismatch");
            }
            if (articleBindings.SemanticArticleId != commentIntent.ArticleSemanticRole)
            {
                blockers.Add("comment_article_semantic_role_mismatch");
            }
            if (commentIntent.NativeArticleBinding is null
                || commentIntent.NativeArticleBinding.Schema != ArticleScaleGraphIdentityBindings.Schema
                || commentIntent.NativeArticleBinding.ContentDigest != articleBindings.Digest)
            {
                blockers.Add("comment_native_article_reference_mismatch");
            }
            if (!articleBindings.Ids.TryGetValue(articleBindings.SemanticArticleId, out long articleId)
                || articleId != commentIntent.ArticleId)
            {
                blockers.Add("comment_native_article_coordinate_mismatch");
            }
        }

        // #2542's identity binding explicitly lacks allocation provenance. #2545's
        // resolved graph explicitly lacks native comment rows and final thread/
        // visibility/moderation coordinates. Neither has a sealed physical receipt
        // API to call here; fabricating fields or accepting caller IDs would bypass
        // those owners. A later receipt intake must consume their actual API.
        blockers.Add("article_physical_graph_receipt_intake_missing");
        blockers.Add("comment_physical_graph_receipt_and_query_coordinates_missing");
        return new QueryProducerRoleInspection(articleBindings, commentIntent, blockers.AsReadOnly());
    }
}

/// <summary>
/// Source linkage diagnostics, retaining original typed producer objects. This
/// deliberately provides no expected model, qualification token or executor.
/// </summary>
public sealed record QueryProducerRoleInspection(
    ArticleScaleGraphIdentityBindings? ArticleBindings,
    CommentScaleResolvedGraphIntent? CommentIntent,
    IReadOnlyList<string> Blockers)
{
    /// <summary>Original components do not provide physical query admission.</summary>
    public bool CanExecuteQueries => false;

    /// <summary>Source linkage is not product qualification.</summary>
    public bool Qualification => false;

    /// <summary>These diagnostics are not a release receipt.</summary>
    public bool ReleaseEvidenceEligible => false;

    /// <summary>
    /// Must precede expected mapping and query capture in the original runner.
    /// Component references, including empty comment occurrences, cannot waive
    /// original physical receipt and current invocation admission.
    /// </summary>
    public void ThrowBeforeQueryExecution()
    {
        throw new InvalidOperationException(
            $"query_producer_role_intake_blocked: {string.Join("; ", Blockers)}");
    }
}
