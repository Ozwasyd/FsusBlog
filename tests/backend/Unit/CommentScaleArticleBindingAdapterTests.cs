using FsusBlog.Server.Services.Fixtures.DataScale;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>
/// Synthetic unit references and supplied IDs exercise the actual original
/// article validator/map. They prove no native allocation, artifact admission,
/// normalized-role receipt, database graph or credentials.
/// </summary>
public sealed class CommentScaleArticleBindingAdapterTests
{
    private const string UnitDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string OtherDigest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    private const string SemanticRole = "original-owner-supplied-article";

    [Fact]
    public void Bind_UsesOriginalValidatorMapAndSuppliedSemanticRoleWithoutAllocatingIds()
    {
        ArticleScaleArtifactBindings artifacts = Artifacts();
        ArticleScalePlan article = ArticleScalePlanBuilder.Create("scale-xs", "unit-map", artifacts);
        CommentScalePlan plan = Plan(article);
        var ids = new Dictionary<string, long> { [SemanticRole] = 900007 };
        var map = new ArticleScaleGraphIdentityBindings(article.ContentDigest, SemanticRole, ids);
        var reference = new CommentScaleArtifactReference(ArticleScaleGraphIdentityBindings.Schema, map.Digest);

        CommentScaleGraphFactBindings result = Bind(plan, article, artifacts, map, reference);

        Assert.True(ArticleScalePlanValidator.Validate(article, artifacts).IsValid);
        Assert.Equal(900007, result.ArticleId);
        Assert.Equal(SemanticRole, result.ArticleSemanticRole);
        Assert.Equal(article.ContentDigest, result.ArticlePlanDigest);
        Assert.Equal(plan.ContentDigest, result.CommentPlanDigest);
        Assert.Same(reference, result.NativeArticleBinding);
        Assert.Empty(result.Comments);
        ids[SemanticRole] = 1;
        Assert.Equal(900007, result.ArticleId);
        Assert.Equal(900007, map.Ids[SemanticRole]);
    }

    [Theory]
    [InlineData("comment-schema")]
    [InlineData("comment-digest")]
    [InlineData("article-reference")]
    [InlineData("article-schema")]
    [InlineData("namespace")]
    [InlineData("tier")]
    [InlineData("article-count")]
    [InlineData("native-schema")]
    [InlineData("native-digest")]
    [InlineData("occurrence")]
    [InlineData("repetition")]
    [InlineData("duplicate-occurrence")]
    public void Bind_RefusesCrossedReferencesAndUnknownOccurrence(string change)
    {
        ArticleScaleArtifactBindings artifacts = Artifacts();
        ArticleScalePlan article = ArticleScalePlanBuilder.Create("scale-xs", "unit-map", artifacts);
        CommentScalePlan plan = Plan(article);
        var map = new ArticleScaleGraphIdentityBindings(article.ContentDigest, SemanticRole,
            new Dictionary<string, long> { [SemanticRole] = 71 });
        var reference = new CommentScaleArtifactReference(ArticleScaleGraphIdentityBindings.Schema, map.Digest);
        CommentScaleGraphOccurrence occurrence = Occurrence();
        plan = change switch
        {
            "comment-schema" => plan with { Schema = "fsusblog.comment-scale-plan.v1" },
            "article-reference" => plan with { ArticlePlan = plan.ArticlePlan with { ContentDigest = OtherDigest } },
            "article-schema" => plan with { ArticlePlan = plan.ArticlePlan with { Schema = "unowned.v1" } },
            "namespace" => plan with { Namespace = "crossed" },
            "tier" => plan with { ScaleTier = "scale-s" },
            "article-count" => plan with { ArticleCount = 2 },
            "duplicate-occurrence" => plan with { Scenarios = [plan.Scenarios[0], plan.Scenarios[0]] },
            _ => plan
        };
        plan = Seal(plan);
        if (change == "comment-digest")
        {
            plan = plan with
            {
                ContentDigest = OtherDigest
            };
        }
        if (change == "native-schema")
        {
            reference = reference with
            {
                Schema = "unowned.v1"
            };
        }
        if (change == "native-digest")
        {
            reference = reference with
            {
                ContentDigest = OtherDigest
            };
        }
        occurrence = change switch
        {
            "occurrence" => occurrence with { ScenarioRole = "crossed" },
            "repetition" => occurrence with { Repetition = 1 },
            _ => occurrence
        };

        Assert.Throws<InvalidOperationException>(() => CommentScaleArticleBindingAdapter.Bind(
            plan, article, artifacts, map, occurrence, SemanticRole, reference, []));
    }

    [Fact]
    public void Bind_OriginalArticleValidatorRejectsIndependentlySuppliedArtifactDrift()
    {
        ArticleScaleArtifactBindings artifacts = Artifacts();
        ArticleScalePlan article = ArticleScalePlanBuilder.Create("scale-xs", "unit-map", artifacts);
        var map = new ArticleScaleGraphIdentityBindings(article.ContentDigest, SemanticRole,
            new Dictionary<string, long> { [SemanticRole] = 71 });
        var reference = new CommentScaleArtifactReference(ArticleScaleGraphIdentityBindings.Schema, map.Digest);
        artifacts = artifacts with
        {
            Temporal = artifacts.Temporal with
            {
                ContentDigest = OtherDigest
            }
        };

        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
            Bind(Plan(article), article, artifacts, map, reference));

        Assert.Contains("independently supplied authorities", error.Message);
    }

    [Fact]
    public void Bind_OriginalMapRejectsCrossPlanAndCrossSemanticRole()
    {
        ArticleScaleArtifactBindings artifacts = Artifacts();
        ArticleScalePlan article = ArticleScalePlanBuilder.Create("scale-xs", "unit-map", artifacts);
        var map = new ArticleScaleGraphIdentityBindings(OtherDigest, SemanticRole,
            new Dictionary<string, long> { [SemanticRole] = 71 });
        var reference = new CommentScaleArtifactReference(ArticleScaleGraphIdentityBindings.Schema, map.Digest);
        Assert.Throws<InvalidOperationException>(() => Bind(Plan(article), article, artifacts, map, reference));
        map = new(article.ContentDigest, SemanticRole, new Dictionary<string, long> { [SemanticRole] = 71 });
        reference = reference with
        {
            ContentDigest = map.Digest
        };

        Assert.Throws<InvalidOperationException>(() => CommentScaleArticleBindingAdapter.Bind(
            Plan(article), article, artifacts, map, Occurrence(), "crossed-article", reference, []));
    }

    [Fact]
    public void Bind_OriginalMapRejectsMissingArticleRoleAndCheckedConversionRejectsOverflow()
    {
        ArticleScaleArtifactBindings artifacts = Artifacts();
        ArticleScalePlan article = ArticleScalePlanBuilder.Create("scale-xs", "unit-map", artifacts);
        var missing = new ArticleScaleGraphIdentityBindings(article.ContentDigest, SemanticRole,
            new Dictionary<string, long> { [SemanticRole + "/revision"] = 71 });
        var reference = new CommentScaleArtifactReference(ArticleScaleGraphIdentityBindings.Schema, missing.Digest);
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
            Bind(Plan(article), article, artifacts, missing, reference));
        Assert.Contains("identity_role_missing", error.Message);
        var overflowing = new ArticleScaleGraphIdentityBindings(article.ContentDigest, SemanticRole,
            new Dictionary<string, long> { [SemanticRole] = (long)int.MaxValue + 1 });
        reference = reference with
        {
            ContentDigest = overflowing.Digest
        };

        Assert.Throws<OverflowException>(() => Bind(Plan(article), article, artifacts, overflowing, reference));
    }

    private static CommentScaleGraphFactBindings Bind(
        CommentScalePlan plan, ArticleScalePlan article, ArticleScaleArtifactBindings artifacts,
        ArticleScaleGraphIdentityBindings map, CommentScaleArtifactReference reference)
        => CommentScaleArticleBindingAdapter.Bind(plan, article, artifacts, map,
            Occurrence(), SemanticRole, reference, []);

    private static CommentScaleGraphOccurrence Occurrence() => new("empty", 0, "original.article.target");

    private static CommentScalePlan Plan(ArticleScalePlan article)
        => Seal(new(CommentScalePlanContract.Schema, CommentScalePlanContract.GraphSchema,
            article.Namespace, article.ScaleTier, 0, 1,
            new(ArticleScaleContractIds.PlanSchema, article.ContentDigest),
            new(ArticleScaleContractIds.ContentShapeCatalogSchema, UnitDigest),
            new(ArticleScaleContractIds.TemporalArtifactSchema, UnitDigest),
            [new("empty", CommentScaleThreadShape.ZeroCommentArticle, "original.article.target", 1, [],
                new(Enum.GetValues<CommentScaleRelation>(), Enum.GetValues<CommentScaleAuthority>()
                    .Select(authority => new CommentScaleAuthorityReference(authority, new string('a', 40), UnitDigest)).ToArray()))],
            string.Empty));

    private static CommentScalePlan Seal(CommentScalePlan plan)
        => plan with
        {
            ContentDigest = CommentScalePlanContract.ComputeDigest(plan)
        };

    private static ArticleScaleArtifactBindings Artifacts()
        => new(
            new(ArticleScaleContractIds.TemporalArtifactSchema, "config/testing/resolved-temporal-roles", "data-scale.lifecycle", UnitDigest),
            new(ArticleScaleContractIds.FixtureVariantCatalogSchema, "config/testing/fixture-variant-catalog", ArticleScaleContractIds.DistributionShape, UnitDigest),
            [new(ArticleScaleContractIds.ContentShapeCatalogSchema, "config/testing/content-shape-catalog", "script.zh-hans", UnitDigest)],
            [new(ArticleScaleContractIds.MediaShapeCatalogSchema, "config/testing/media-shape-catalog", "webp-landscape", UnitDigest),
             new(ArticleScaleContractIds.MediaShapeCatalogSchema, "config/testing/media-shape-catalog", "no-cover", UnitDigest)],
            [new(ArticleScaleContractIds.FixtureVariantCatalogSchema, "config/testing/fixture-variant-catalog", ArticleScaleContractIds.TaxonomyShape, UnitDigest)]);
}
