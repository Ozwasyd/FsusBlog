using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Fixtures.DataScale;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleScaleGraphIdentityBindingsTests
{
    [Theory]
    [InlineData(ArticleScaleVariant.Published)]
    [InlineData(ArticleScaleVariant.Scheduled)]
    [InlineData(ArticleScaleVariant.PublishedWithScheduledUpdate)]
    [InlineData(ArticleScaleVariant.Archived)]
    [InlineData(ArticleScaleVariant.Deleted)]
    public void NativeRoleBindings_AreConsumedBeforeHashesEnvelopesAndFinalDigest(ArticleScaleVariant variant)
    {
        ArticleScalePlan plan = Plan();
        ArticleScaleArticleGraph diagnostic = Build(plan, variant);
        Dictionary<string, long> ids = Ids(diagnostic);
        var bindings = new ArticleScaleGraphIdentityBindings(ArticleScalePlanDigest.Compute(plan), diagnostic.SemanticArticleId, ids);
        ArticleScaleArticleGraph bound = Build(plan, variant, bindings);
        CanonicalArticleGraphVerifier.VerifyArticleGraph(plan, bound).ThrowIfInvalid();
        Assert.Equal(diagnostic.SemanticArticleId, bound.SemanticArticleId);
        Assert.Equal(diagnostic.Rows.Select(row => row.SemanticId), bound.Rows.Select(row => row.SemanticId));
        Assert.Equal(diagnostic.Relations, bound.Relations);
        Assert.Equal(diagnostic.Pointers, bound.Pointers);
        Assert.NotEqual(diagnostic.ArticleDigest, bound.ArticleDigest);
        Assert.Equal(bound.ArticleDigest, Build(plan, variant, bindings).ArticleDigest);

        int articleId = checked((int)ids[bound.SemanticArticleId]);
        foreach (ArticleScaleRowPlan row in bound.Rows)
        {
            if (row.Fields.TryGetValue("ArticleId", out object? actual))
            {
                Assert.Equal(articleId, Assert.IsType<int>(actual));
            }
            if (ids.TryGetValue(row.SemanticId, out long id))
            {
                Assert.Equal(id, Convert.ToInt64(row.Fields["Id"]));
            }
        }
        ArticleScaleRowPlan article = bound.Rows.Single(row => row.Kind == ArticleScaleRowKind.Article);
        ArticleScaleRowPlan unboundArticle = diagnostic.Rows.Single(row => row.Kind == ArticleScaleRowKind.Article);
        foreach (string field in new[] { "CurrentRevisionId", "CurrentPublicationId" })
        {
            if (unboundArticle.Fields[field] is string role)
            {
                Assert.Equal(ids[role], Assert.IsType<long>(article.Fields[field]));
            }
            else
            {
                Assert.Null(article.Fields[field]);
            }
        }
        foreach (ArticleScaleRowPlan row in bound.Rows.Where(row => row.Kind == ArticleScaleRowKind.ArticleRightsSnapshot))
        {
            string role = Assert.IsType<string>(row.Fields["ArticleRevisionSemanticId"]);
            Assert.Equal(ids[role], Assert.IsType<long>(row.Fields["ArticleRevisionId"]));
            ArticleScaleRowPlan before = diagnostic.Rows.Single(before => before.SemanticId == row.SemanticId);
            Assert.NotEqual(before.Fields["ContentCanonicalHash"], row.Fields["ContentCanonicalHash"]);
        }
        foreach (ArticleScaleRowPlan row in bound.Rows.Where(row => row.Kind == ArticleScaleRowKind.ArticleMutationOutboxEnvelope))
        {
            var persisted = new ArticleMutationOutboxEvent
            {
                Id = ids[row.SemanticId],
                EventId = Assert.IsType<string>(row.Fields["EventId"]),
                AggregateId = Assert.IsType<int>(row.Fields["AggregateId"]),
                SchemaVersion = Assert.IsType<int>(row.Fields["SchemaVersion"]),
                EventType = Assert.IsType<string>(row.Fields["EventType"]),
                ArticleRevisionId = Assert.IsType<long>(row.Fields["ArticleRevisionId"]),
                RightsSnapshotId = Assert.IsType<long>(row.Fields["RightsSnapshotId"]),
                ResponsibilitySnapshotId = Assert.IsType<long>(row.Fields["ResponsibilitySnapshotId"]),
                ArticlePublicationId = row.Fields["ArticlePublicationId"] as long?,
                PayloadJson = Assert.IsType<string>(row.Fields["PayloadJson"])
            };
            ArticleMutationOutboxEnvelope envelope = ArticleMutationOutboxEnvelopeCodec.Read(persisted);
            Assert.Equal(articleId, envelope.ArticleId);
            Assert.Equal(persisted.ArticleRevisionId, envelope.Version.RevisionId);
            Assert.Equal(persisted.RightsSnapshotId, envelope.Version.RightsSnapshotId);
            Assert.Equal(persisted.ResponsibilitySnapshotId, envelope.Version.ResponsibilitySnapshotId);
            Assert.Equal(persisted.ArticlePublicationId, envelope.Version.PublicationId);
            persisted.ArticleRevisionId++;
            Assert.Throws<InvalidOperationException>(() => ArticleMutationOutboxEnvelopeCodec.Read(persisted));
        }
        foreach (ArticleScaleRowPlan row in bound.Rows.Where(row => row.Kind == ArticleScaleRowKind.ArticleMutationOutboxEdge))
        {
            Assert.Equal(ids[Assert.IsType<string>(row.Fields["OutboxSemanticId"])], Assert.IsType<long>(row.Fields["OutboxEventId"]));
        }
        ArticleScaleRowPlan[] responsibilities = bound.Rows.Where(row => row.Kind == ArticleScaleRowKind.ArticleResponsibilitySnapshot).ToArray();
        if (responsibilities.Length == 2)
        {
            Assert.Equal(ids[responsibilities[0].SemanticId], Assert.IsType<long>(responsibilities[1].Fields["PreviousSnapshotId"]));
        }
    }

    [Fact]
    public void IdentityBindingSnapshotAndDigest_DoNotDependOnCallerMutationOrEnumerationOrder()
    {
        ArticleScalePlan plan = Plan();
        ArticleScaleArticleGraph graph = Build(plan, ArticleScaleVariant.Published);
        Dictionary<string, long> ids = Ids(graph);
        var first = new ArticleScaleGraphIdentityBindings(ArticleScalePlanDigest.Compute(plan), graph.SemanticArticleId, ids);
        var reordered = new ArticleScaleGraphIdentityBindings(first.PlanDigest, graph.SemanticArticleId,
            ids.Reverse().ToDictionary(pair => pair.Key, pair => pair.Value));
        Assert.Equal(first.Digest, reordered.Digest);
        long expected = ids[graph.SemanticArticleId];
        ids[graph.SemanticArticleId]++;
        Assert.Equal(expected, first.Ids[graph.SemanticArticleId]);
        var changed = new ArticleScaleGraphIdentityBindings(first.PlanDigest, graph.SemanticArticleId, ids);
        Assert.NotEqual(first.Digest, changed.Digest);
    }

    [Fact]
    public void IncompleteExtraDuplicateAliasForeignAndOverflowBindings_FailClosed()
    {
        ArticleScalePlan plan = Plan();
        const ArticleScaleVariant variant = ArticleScaleVariant.PublishedWithScheduledUpdate;
        ArticleScaleArticleGraph graph = Build(plan, variant);
        Dictionary<string, long> complete = Ids(graph);
        void Reject(Dictionary<string, long> ids, string? digest = null)
            => Assert.Throws<InvalidOperationException>(() => Build(plan, variant,
                new ArticleScaleGraphIdentityBindings(digest ?? ArticleScalePlanDigest.Compute(plan), graph.SemanticArticleId, ids)));
        var missing = new Dictionary<string, long>(complete);
        missing.Remove(graph.SemanticArticleId);
        Reject(missing);
        var extra = new Dictionary<string, long>(complete) { [graph.SemanticArticleId + "/unknown"] = 91 };
        Reject(extra);
        var duplicate = new Dictionary<string, long>(complete);
        ArticleScaleRowPlan[] revisions = graph.Rows.Where(row => row.Kind == ArticleScaleRowKind.ArticleRevision).ToArray();
        duplicate[revisions[1].SemanticId] = duplicate[revisions[0].SemanticId];
        Reject(duplicate);
        var alias = new Dictionary<string, long>(complete);
        ArticleScaleRowPlan[] blocks = graph.Rows.Where(row => row.Kind == ArticleScaleRowKind.ArticleRevisionContentBlock).ToArray();
        alias[blocks[1].SemanticId]++;
        Reject(alias);
        Reject(complete, "sha256:" + new string('0', 64));
        Assert.Throws<ArgumentException>(() => new ArticleScaleGraphIdentityBindings(ArticleScalePlanDigest.Compute(plan), graph.SemanticArticleId,
            new Dictionary<string, long> { ["another:article/000001"] = 1 }));
        var overflow = new Dictionary<string, long>(complete) { [graph.SemanticArticleId] = (long)int.MaxValue + 1 };
        Assert.Throws<OverflowException>(() => Build(plan, variant,
            new ArticleScaleGraphIdentityBindings(ArticleScalePlanDigest.Compute(plan), graph.SemanticArticleId, overflow)));
    }

    private static ArticleScaleArticleGraph Build(ArticleScalePlan plan, ArticleScaleVariant variant, ArticleScaleGraphIdentityBindings? bindings = null)
        => CanonicalArticleGraphFactory.BuildArticleGraph(plan, 1, variant, ArticleScaleVariantContractCatalog.Get(variant), bindings);

    private static Dictionary<string, long> Ids(ArticleScaleArticleGraph graph)
    {
        var result = new Dictionary<string, long>(StringComparer.Ordinal);
        long id = 700;
        foreach (ArticleScaleRowPlan row in graph.Rows.Reverse())
        {
            if (row.Kind is not (ArticleScaleRowKind.ArticleBody or ArticleScaleRowKind.ArticleTaxonomyReference or ArticleScaleRowKind.ArticleAuditCoordinate))
            {
                result.Add(row.SemanticId, id += 13);
            }
        }
        foreach (IGrouping<object?, ArticleScaleRowPlan> group in graph.Rows.Where(row => row.Kind == ArticleScaleRowKind.ArticleRevisionContentBlock).GroupBy(row => row.Fields["ContentHash"]))
        {
            foreach (ArticleScaleRowPlan row in group.Skip(1))
            {
                result[row.SemanticId] = result[group.First().SemanticId];
            }
        }
        return result;
    }

    private static ArticleScalePlan Plan()
    {
        ArticleScaleArtifactReference Reference(string schema, string authority, string shape)
            => new(schema, $"config/testing/{authority}", shape, "sha256:" + new string('1', 64));
        var artifacts = new ArticleScaleArtifactBindings(
            Reference(ArticleScaleContractIds.TemporalArtifactSchema, "resolved-temporal-roles", "data-scale.lifecycle"),
            Reference(ArticleScaleContractIds.FixtureVariantCatalogSchema, "fixture-variant-catalog", ArticleScaleContractIds.DistributionShape),
            [Reference(ArticleScaleContractIds.ContentShapeCatalogSchema, "content-shape-catalog", "script.zh-hans")],
            [Reference(ArticleScaleContractIds.MediaShapeCatalogSchema, "media-shape-catalog", "webp-landscape")],
            [Reference(ArticleScaleContractIds.FixtureVariantCatalogSchema, "fixture-variant-catalog", ArticleScaleContractIds.TaxonomyShape)]);
        return ArticleScalePlanBuilder.Create("scale-s", "bulk-boundary", artifacts);
    }
}
