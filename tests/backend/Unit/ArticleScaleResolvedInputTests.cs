using FsusBlog.Server.Services.Fixtures.DataScale;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleScaleResolvedInputTests
{
    [Fact]
    public void CompleteAssignment_PermitsReorderedVariantsThroughExistingFactoryAndProjection()
    {
        var (plan, _, _) = DataScaleArticlePhysicalProjectionTests.Graph(ArticleScaleVariant.Published);
        List<ArticleScaleResolvedInput> inputs = Inputs(plan);
        // Preserve every count but move Deleted into the first ordinal and Published into its slot.
        int deleted = inputs.FindIndex(input => input.Variant == ArticleScaleVariant.Deleted);
        inputs[0] = Input(plan, inputs[0].ArticleOrdinal, ArticleScaleVariant.Deleted);
        inputs[deleted] = Input(plan, inputs[deleted].ArticleOrdinal, ArticleScaleVariant.Published);
        var coverage = Coverage(plan, inputs);
        var batch = new ArticleScaleResolvedGraphBatch(plan, coverage, [inputs[0]]);
        ArticleScaleArticleGraph diagnostic = CanonicalArticleGraphFactory.BuildArticleGraph(plan, inputs[0].ArticleOrdinal,
            inputs[0].Variant, ArticleScaleVariantContractCatalog.Get(inputs[0].Variant), null, batch);
        var native = new ArticleScaleGraphIdentityBindings(ArticleScalePlanDigest.Compute(plan), diagnostic.SemanticArticleId,
            DataScaleArticlePhysicalProjectionTests.Ids(diagnostic));
        ArticleScaleArticleGraph graph = CanonicalArticleGraphFactory.BuildArticleGraph(plan, diagnostic.ArticleOrdinal,
            diagnostic.Variant, ArticleScaleVariantContractCatalog.Get(diagnostic.Variant), native, batch);
        CanonicalArticleGraphVerifier.VerifyArticleGraph(plan, graph).ThrowIfInvalid();
        var bindings = new Dictionary<string, ArticleScaleGraphIdentityBindings> { [graph.SemanticArticleId] = native };
        var schema = DataScaleArticlePhysicalProjectionTests.Schema();
        Assert.Throws<InvalidOperationException>(() => DataScaleArticlePhysicalProjection.Compile(plan, [graph], bindings,
            schema, DataScaleArticlePhysicalProjectionTests.Principals(plan)));
        DataScaleArticlePhysicalBatch physical = DataScaleArticlePhysicalProjection.Compile(plan, [graph], bindings,
            schema, DataScaleArticlePhysicalProjectionTests.Principals(plan), batch);
        ArticleScaleRowPlan article = graph.Rows.Single(row => row.Kind == ArticleScaleRowKind.Article);
        Assert.Equal("Original authority title", article.Fields["Title"]);
        Assert.Equal(1234, article.Fields["Views"]);
        Assert.Contains(physical.Tables, table => table.Table == "article");
    }

    [Fact]
    public void Coverage_RejectsMissingDuplicateOutOfRangeAndChangedCountsBeforeFactoryUse()
    {
        var (plan, _, _) = DataScaleArticlePhysicalProjectionTests.Graph(ArticleScaleVariant.Published);
        List<ArticleScaleResolvedInput> inputs = Inputs(plan);
        var entries = inputs.Select(input => new ArticleScaleOrdinalAssignment(input.ArticleOrdinal, input.Variant,
            ArticleScaleAssignmentCoverage.ComputeInputDigest(input))).ToArray();
        Assert.Throws<InvalidOperationException>(() => new ArticleScaleAssignmentCoverage(plan, "original-distribution", entries[..^1]));
        ArticleScaleOrdinalAssignment[] duplicate = entries.ToArray();
        duplicate[^1] = duplicate[0];
        Assert.Throws<InvalidOperationException>(() => new ArticleScaleAssignmentCoverage(plan, "original-distribution", duplicate));
        ArticleScaleOrdinalAssignment[] outside = entries.ToArray();
        outside[^1] = outside[^1] with
        {
            ArticleOrdinal = int.MaxValue
        };
        Assert.Throws<InvalidOperationException>(() => new ArticleScaleAssignmentCoverage(plan, "original-distribution", outside));
        ArticleScaleOrdinalAssignment[] counts = entries.ToArray();
        counts[^1] = counts[^1] with
        {
            Variant = ArticleScaleVariant.Published
        };
        Assert.Throws<InvalidOperationException>(() => new ArticleScaleAssignmentCoverage(plan, "original-distribution", counts));
    }

    [Fact]
    public void PayloadMismatchMissingAuthorityAndTemporalViolation_AreRefusedBeforeAllocation()
    {
        var (plan, _, _) = DataScaleArticlePhysicalProjectionTests.Graph(ArticleScaleVariant.Published);
        List<ArticleScaleResolvedInput> inputs = Inputs(plan);
        var coverage = Coverage(plan, inputs);
        Assert.Throws<InvalidOperationException>(() => new ArticleScaleResolvedGraphBatch(plan, coverage,
            [inputs[0] with { MarkdownContent = "changed after coverage sealing" }]));
        Assert.Throws<InvalidOperationException>(() => new ArticleScaleResolvedGraphBatch(plan, coverage,
            [inputs[0] with { HotnessAuthorityReference = "" }]));
        var temporal = new Dictionary<string, DateTime>(inputs[0].TemporalRoles);
        temporal[ArticleScaleTemporalRoles.ArticlePublished] = temporal[ArticleScaleTemporalRoles.ArticleCreated].AddDays(-1);
        Assert.Throws<InvalidOperationException>(() => new ArticleScaleResolvedGraphBatch(plan, coverage,
            [inputs[0] with { TemporalRoles = temporal }]));
    }

    [Fact]
    public void Batch_SnapshotsCallerCollectionsAndNativeRosterAliases()
    {
        var (plan, _, _) = DataScaleArticlePhysicalProjectionTests.Graph(ArticleScaleVariant.PublishedWithScheduledUpdate);
        List<ArticleScaleResolvedInput> inputs = Inputs(plan);
        ArticleScaleResolvedInput input = inputs.First(input => input.Variant == ArticleScaleVariant.PublishedWithScheduledUpdate);
        var coverage = Coverage(plan, inputs);
        var batch = new ArticleScaleResolvedGraphBatch(plan, coverage, [input]);
        ArticleScaleArticleGraph before = CanonicalArticleGraphFactory.BuildArticleGraph(plan, input.ArticleOrdinal,
            input.Variant, ArticleScaleVariantContractCatalog.Get(input.Variant), null, batch);
        ((List<int>)input.TagIds).Clear();
        ((Dictionary<string, DateTime>)input.TemporalRoles).Clear();
        ArticleScaleArticleGraph after = CanonicalArticleGraphFactory.BuildArticleGraph(plan, input.ArticleOrdinal,
            input.Variant, ArticleScaleVariantContractCatalog.Get(input.Variant), null, batch);
        Assert.Equal(before.ArticleDigest, after.ArticleDigest);
        IReadOnlyList<ArticleScaleNativeRoleRequirement> roles = CanonicalArticleGraphFactory.DescribeNativeRoles(plan, [after]);
        ArticleScaleNativeRoleRequirement block = Assert.Single(roles, role => role.Kind == ArticleScaleRowKind.ArticleRevisionContentBlock);
        Assert.Equal(2, block.SemanticRoles.Count);
    }

    private static ArticleScaleAssignmentCoverage Coverage(ArticleScalePlan plan, IEnumerable<ArticleScaleResolvedInput> inputs)
        => new(plan, "original-distribution-authority", inputs.Select(input => new ArticleScaleOrdinalAssignment(input.ArticleOrdinal,
            input.Variant, ArticleScaleAssignmentCoverage.ComputeInputDigest(input))).ToArray());

    private static List<ArticleScaleResolvedInput> Inputs(ArticleScalePlan plan)
    {
        var result = new List<ArticleScaleResolvedInput>();
        int ordinal = plan.IdAllocation.ArticleOrdinalBase;
        foreach (ArticleScaleVariantAllocation allocation in plan.StateDistribution)
        {
            for (int index = 0; index < allocation.Count; index++)
            {
                result.Add(Input(plan, ordinal++, allocation.Variant));
            }
        }
        return result;
    }

    private static ArticleScaleResolvedInput Input(ArticleScalePlan plan, int ordinal, ArticleScaleVariant variant)
        => new(ordinal, variant, "Original authority title", "# Original content\n\nBound before hashes and envelopes.",
            "Resolved summary", "https://example.test/owned.webp", 17, new List<int> { 23, 29 }, 1234,
            new Dictionary<string, DateTime>(CanonicalArticleGraphFactory.ResolveTemporalMap(ordinal, ArticleScaleVariantContractCatalog.Get(variant))),
            plan.Artifacts, "original-hotness-authority");
}
