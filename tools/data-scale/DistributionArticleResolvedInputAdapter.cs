using FsusBlog.Server.Services.Fixtures.DataScale;

namespace FsusBlog.Tooling.DataScale;

/// <summary>
/// Consumes the original owner's complete coverage and bounded typed inputs in
/// the existing factory. Caller references must come from the validated distribution
/// request. This creates pre-native graphs only, not IDs, DB writes or admission.
/// </summary>
public static class DistributionArticleResolvedInputAdapter
{
    /// <summary>
    /// Preserve owner digest authority, validate the entire current payload before
    /// building any graph, and pass resolved values before factory hash sealing.
    /// Whole coverage proves the roster; future batches' payloads remain unvalidated.
    /// </summary>
    public static (ArticleScaleResolvedGraphBatch ResolvedBatch, IReadOnlyList<ArticleScaleArticleGraph> Graphs) PrepareBatch(
        ArticleScalePlan plan,
        ArticleScaleAssignmentCoverage coverage,
        string expectedPlanDigest,
        string expectedCoverageDigest,
        string expectedAssignmentAuthorityReference,
        IReadOnlyList<ArticleScaleResolvedInput> inputs)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(coverage);
        ArgumentNullException.ThrowIfNull(inputs);
        ArticleScalePlanValidator.Validate(plan, plan.Artifacts).ThrowIfInvalid();
        if (coverage.PlanDigest != expectedPlanDigest
            || ArticleScalePlanDigest.Compute(plan) != expectedPlanDigest
            || coverage.CoverageDigest != expectedCoverageDigest
            || coverage.AssignmentAuthorityReference != expectedAssignmentAuthorityReference)
        {
            throw new InvalidOperationException("distribution_resolved_owner_identity_mismatch");
        }
        int count = inputs.Count;
        if (count is < 1 or > 1000)
        {
            throw new InvalidOperationException("distribution_resolved_batch_bound_invalid");
        }
        var snapshot = new ArticleScaleResolvedInput[count];
        for (int index = 0; index < count; index++)
        {
            snapshot[index] = inputs[index];
        }
        // Owner validates and freezes all current inputs before any factory call.
        var batch = new ArticleScaleResolvedGraphBatch(plan, coverage, snapshot);
        ArticleScaleArticleGraph[] graphs = snapshot.Select(input =>
            CanonicalArticleGraphFactory.BuildArticleGraph(plan, input.ArticleOrdinal, input.Variant,
                ArticleScaleVariantContractCatalog.Get(input.Variant), identities: null, resolvedBatch: batch)).ToArray();
        foreach (ArticleScaleArticleGraph graph in graphs)
        {
            CanonicalArticleGraphVerifier.VerifyArticleGraph(plan, graph).ThrowIfInvalid();
        }
        return (batch, Array.AsReadOnly(graphs));
    }
}
