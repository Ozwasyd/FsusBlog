using FsusBlog.Server.Services.Fixtures.DataScale;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleScalePlanTests
{
    [Fact]
    public void Create_SealsEveryVariantAndProviderNeutralPostcondition()
    {
        ArticleScalePlan plan = ArticleScalePlanBuilder.Create(
            "scale-s",
            "run-a",
            Distribution(96, 1, 1, 1, 1),
            Artifacts());

        Assert.Equal(100, plan.ArticleCount);
        Assert.Equal(Enum.GetValues<ArticleScaleVariant>(), plan.StateDistribution.Select(static item => item.Variant));
        Assert.All(plan.StateDistribution, static item => Assert.True(item.Count > 0));
        Assert.Equal(0, plan.Postconditions.ExpectedOrphans);
        Assert.Equal(
            100,
            plan.Postconditions.ExpectedRows.Single(static item => item.Kind == ArticleScaleRowKind.Article).Count);
        Assert.Equal(
            103,
            plan.Postconditions.ExpectedRows.Single(static item => item.Kind == ArticleScaleRowKind.ArticleMutationOutbox).Count);
        Assert.StartsWith("sha256:", plan.ContentDigest, StringComparison.Ordinal);
        Assert.True(ArticleScalePlanValidator.Validate(plan).IsValid);
    }

    [Fact]
    public void Create_UsesExplicitDistributionInsteadOfOrdinalModulo()
    {
        ArticleScalePlan plan = ArticleScalePlanBuilder.Create(
            "scale-s",
            "distribution-case",
            Distribution(20, 20, 20, 20, 20),
            Artifacts());

        Assert.All(plan.StateDistribution, static allocation => Assert.Equal(20, allocation.Count));
        Assert.Equal(
            120,
            plan.Postconditions.ExpectedRows.Single(static item => item.Kind == ArticleScaleRowKind.ArticleRevision).Count);
        Assert.Equal(
            80,
            plan.Postconditions.ExpectedRows.Single(static item => item.Kind == ArticleScaleRowKind.ArticlePublication).Count);
    }

    [Fact]
    public void Create_ScaleXsRequiresTheCanonicalPublishedArticle()
    {
        ArticleScalePlan plan = ArticleScalePlanBuilder.Create(
            "scale-xs",
            "single",
            Distribution(1, 0, 0, 0, 0),
            Artifacts());

        Assert.Equal(1, plan.ArticleCount);
        Assert.Equal(
            1,
            plan.StateDistribution.Single(static item => item.Variant == ArticleScaleVariant.Published).Count);
        Assert.True(ArticleScalePlanValidator.Validate(plan).IsValid);

        Assert.Throws<InvalidOperationException>(() => ArticleScalePlanBuilder.Create(
            "scale-xs",
            "invalid-single",
            Distribution(0, 1, 0, 0, 0),
            Artifacts()));
    }

    [Fact]
    public void Validate_RejectsMissingDuplicateAndTamperedVariantContracts()
    {
        ArticleScalePlan plan = ArticleScalePlanBuilder.Create(
            "scale-s",
            "variant-tamper",
            Distribution(96, 1, 1, 1, 1),
            Artifacts());
        ArticleScaleVariantAllocation published = plan.StateDistribution[0];
        ArticleScalePlan missing = plan with
        {
            StateDistribution = plan.StateDistribution.Take(plan.StateDistribution.Count - 1).ToArray(),
            ContentDigest = string.Empty
        };
        ArticleScalePlan duplicate = plan with
        {
            StateDistribution = [published, published, .. plan.StateDistribution.Skip(2)],
            ContentDigest = string.Empty
        };
        ArticleScalePlan contractTamper = plan with
        {
            StateDistribution = [published with
            {
                Contract = published.Contract with { IsDeleted = true }
            }, .. plan.StateDistribution.Skip(1)],
            ContentDigest = string.Empty
        };

        Assert.False(ArticleScalePlanValidator.Validate(missing).IsValid);
        Assert.False(ArticleScalePlanValidator.Validate(duplicate).IsValid);
        Assert.False(ArticleScalePlanValidator.Validate(contractTamper).IsValid);
    }

    [Fact]
    public void Create_RejectsUnknownOrMissingDistributionEntries()
    {
        Dictionary<ArticleScaleVariant, int> missing = Distribution(96, 1, 1, 1, 1);
        missing.Remove(ArticleScaleVariant.Deleted);
        Dictionary<ArticleScaleVariant, int> unknown = Distribution(96, 1, 1, 1, 1);
        unknown[(ArticleScaleVariant)999] = 0;

        Assert.Throws<ArgumentException>(() => ArticleScalePlanBuilder.Create(
            "scale-s",
            "missing-variant",
            missing,
            Artifacts()));
        Assert.Throws<ArgumentException>(() => ArticleScalePlanBuilder.Create(
            "scale-s",
            "unknown-variant",
            unknown,
            Artifacts()));
    }

    [Fact]
    public void Validate_RejectsPayloadLikeReferencesAndDigestDrift()
    {
        ArticleScalePlan plan = ArticleScalePlanBuilder.Create(
            "scale-s",
            "artifact-tamper",
            Distribution(96, 1, 1, 1, 1),
            Artifacts());
        ArticleScalePlan payloadReference = plan with
        {
            Artifacts = plan.Artifacts with
            {
                Content = [new("content-shapes", "https://example.test/article.md", Digest('a'))]
            },
            ContentDigest = string.Empty
        };
        ArticleScalePlan stale = plan with
        {
            ContentDigest = Digest('f')
        };

        Assert.Contains(
            ArticleScalePlanValidator.Validate(payloadReference).Errors,
            static error => error.Contains("bounded references", StringComparison.Ordinal));
        Assert.Contains(
            ArticleScalePlanValidator.Validate(stale).Errors,
            static error => error.Contains("digest", StringComparison.Ordinal));
    }

    [Fact]
    public void Catalog_DeclaresLifecycleSpecificHistoryPointersAndOutboxEdges()
    {
        ArticleScaleVariantContract scheduled = ArticleScaleVariantContractCatalog.Get(ArticleScaleVariant.Scheduled);
        ArticleScaleVariantContract scheduledUpdate = ArticleScaleVariantContractCatalog.Get(
            ArticleScaleVariant.PublishedWithScheduledUpdate);
        ArticleScaleVariantContract archived = ArticleScaleVariantContractCatalog.Get(ArticleScaleVariant.Archived);
        ArticleScaleVariantContract deleted = ArticleScaleVariantContractCatalog.Get(ArticleScaleVariant.Deleted);

        Assert.Contains(ArticleScalePointerKind.ScheduledPublishAt, scheduled.RequiredPointers);
        Assert.DoesNotContain(ArticleScalePointerKind.CurrentPublication, scheduled.RequiredPointers);
        Assert.Contains(ArticleScalePointerKind.PendingPublicationAt, scheduledUpdate.RequiredPointers);
        Assert.True(scheduledUpdate.RetainsPublicationHistory);
        Assert.Contains(ArticleScalePointerKind.ArchivedAt, archived.RequiredPointers);
        Assert.True(deleted.IsDeleted);
        Assert.Null(deleted.Transitions[^1].Operation);
        Assert.Contains(ArticleScalePointerKind.DeletedAt, deleted.RequiredPointers);
        Assert.All(
            ArticleScaleVariantContractCatalog.Variants,
            variant => Assert.NotEmpty(ArticleScaleVariantContractCatalog.Get(variant).OutboxEdgeObligations));
    }

    [Fact]
    public void Contract_IsProviderNeutralAndDoesNotDeclareDerivedCacheRows()
    {
        string[] forbiddenNamespacePrefixes = ["Npgsql", "SqlSugar"];
        Type[] contractTypes =
        [
            typeof(ArticleScalePlan),
            typeof(ArticleScaleVariantContract),
            typeof(ArticleScalePostconditions)
        ];

        Assert.DoesNotContain(
            contractTypes.SelectMany(static type => type.GetProperties())
                .Select(static property => property.PropertyType.Namespace ?? string.Empty),
            value => forbiddenNamespacePrefixes.Any(prefix => value.StartsWith(prefix, StringComparison.Ordinal)));
        Assert.DoesNotContain(
            Enum.GetNames<ArticleScaleRowKind>(),
            static name => name.Contains("Redis", StringComparison.Ordinal)
                || name.Contains("Search", StringComparison.Ordinal)
                || name.Contains("Aot", StringComparison.Ordinal)
                || name.Contains("HotRead", StringComparison.Ordinal));
    }

    private static Dictionary<ArticleScaleVariant, int> Distribution(
        int published,
        int scheduled,
        int scheduledUpdate,
        int archived,
        int deleted)
        => new()
        {
            [ArticleScaleVariant.Published] = published,
            [ArticleScaleVariant.Scheduled] = scheduled,
            [ArticleScaleVariant.PublishedWithScheduledUpdate] = scheduledUpdate,
            [ArticleScaleVariant.Archived] = archived,
            [ArticleScaleVariant.Deleted] = deleted
        };

    private static ArticleScaleArtifactBindings Artifacts()
        => new(
            new("temporal-shapes", "resolved.article.lifecycle", Digest('1')),
            [new("content-shapes", "article.multilingual-markdown", Digest('2'))],
            [new("media-shapes", "article.cover.landscape", Digest('3'))],
            [new("taxonomy-shapes", "article.category-and-tags", Digest('4'))]);

    private static string Digest(char value) => "sha256:" + new string(value, 64);
}
