using System.Text.Json;

using Xunit.Abstractions;

using FsusBlog.Contracts.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Fixtures.DataScale;

namespace FsusBlog.Server.Tests.Unit;

/// <summary>
/// Checks canonical input against persistence boundaries before provider execution can be accepted.
/// These tests do not qualify database writes, runtime isolation or scale capacity.
/// </summary>
public sealed class ArticleScaleBulkWriterInputTests(ITestOutputHelper output)
{
    [Theory]
    [InlineData(ArticleScaleVariant.Published)]
    [InlineData(ArticleScaleVariant.Scheduled)]
    [InlineData(ArticleScaleVariant.PublishedWithScheduledUpdate)]
    [InlineData(ArticleScaleVariant.Archived)]
    [InlineData(ArticleScaleVariant.Deleted)]
    public void FactoryContentBlockKey_MatchesProductionContentAddress(ArticleScaleVariant variant)
    {
        ArticleScaleArticleGraph graph = CreateGraph("bulk-input-first", variant);
        output.WriteLine("CanonicalGraph=" + JsonSerializer.Serialize(graph));

        foreach (ArticleScaleRowPlan block in graph.Rows.Where(
            row => row.Kind == ArticleScaleRowKind.ArticleRevisionContentBlock))
        {
            ArticleRevisionContentAddress address = ArticleRevisionContentAddress.Compute(
                Assert.IsType<string>(block.Fields["MarkdownContent"]));
            output.WriteLine($"Block={block.SemanticId}; ExpectedHash={address.ContentHash}; FactoryHash={block.Fields["ContentHash"]}");

            Assert.Equal(address.ByteLength, Assert.IsType<int>(block.Fields["ByteLength"]));
            Assert.Equal(address.ContentHash, Assert.IsType<string>(block.Fields["ContentHash"]));
        }
    }

    [Theory]
    [InlineData(ArticleScaleVariant.Published)]
    [InlineData(ArticleScaleVariant.Scheduled)]
    [InlineData(ArticleScaleVariant.PublishedWithScheduledUpdate)]
    [InlineData(ArticleScaleVariant.Archived)]
    [InlineData(ArticleScaleVariant.Deleted)]
    public void Verifier_RejectsContentAddressTamperEvenWithRecomputedGraphDigest(ArticleScaleVariant variant)
    {
        ArticleScaleArticleGraph original = CreateGraph("bulk-input-first", variant);
        ArticleScaleRowPlan block = original.Rows.First(
            row => row.Kind == ArticleScaleRowKind.ArticleRevisionContentBlock);

        foreach ((string field, object value, string violation) in new[]
        {
            ("ContentHash", (object)new string('0', 64), "content_block_hash_mismatch:"),
            ("ByteLength", (object)0, "content_block_byte_length_mismatch:")
        })
        {
            var fields = new Dictionary<string, object?>(block.Fields, StringComparer.Ordinal)
            {
                [field] = value
            };
            ArticleScaleRowPlan[] rows = original.Rows.Select(
                row => row.SemanticId == block.SemanticId ? row with { Fields = fields } : row).ToArray();
            ArticleScaleArticleGraph tampered = original with
            {
                Rows = rows,
                ArticleDigest = CanonicalArticleGraphFactory.ComputeArticleDigest(
                    original.SemanticArticleId, original.Variant, rows, original.Relations, original.Pointers)
            };
            ArticleScalePlan plan = CreatePlan("bulk-input-first");
            CanonicalArticleGraphVerificationResult result = CanonicalArticleGraphVerifier.VerifyArticleGraph(plan, tampered);
            Assert.False(result.IsValid);
            Assert.Contains(result.Violations, item => item.StartsWith(violation, StringComparison.Ordinal));
        }
    }

    [Theory]
    [InlineData(ArticleScaleVariant.Published)]
    [InlineData(ArticleScaleVariant.Scheduled)]
    [InlineData(ArticleScaleVariant.PublishedWithScheduledUpdate)]
    [InlineData(ArticleScaleVariant.Archived)]
    [InlineData(ArticleScaleVariant.Deleted)]
    public void FactoryContentBlockRoles_WithSameKeyHaveIdenticalPersistedValues(ArticleScaleVariant variant)
    {
        ArticleScaleArticleGraph graph = CreateGraph("bulk-input-first", variant);
        foreach (IGrouping<string, ArticleScaleRowPlan> sharedKey in graph.Rows
            .Where(row => row.Kind == ArticleScaleRowKind.ArticleRevisionContentBlock)
            .GroupBy(row => Assert.IsType<string>(row.Fields["ContentHash"]), StringComparer.Ordinal))
        {
            ArticleScaleRowPlan first = sharedKey.First();
            foreach (ArticleScaleRowPlan alias in sharedKey.Skip(1))
            {
                Assert.Equal(first.Fields["MarkdownContent"], alias.Fields["MarkdownContent"]);
                Assert.Equal(first.Fields["ByteLength"], alias.Fields["ByteLength"]);
                Assert.Equal(first.Fields["CreatedAt"], alias.Fields["CreatedAt"]);
            }
        }
    }

    [Theory]
    [InlineData(ArticleScaleVariant.Published)]
    [InlineData(ArticleScaleVariant.Scheduled)]
    [InlineData(ArticleScaleVariant.PublishedWithScheduledUpdate)]
    [InlineData(ArticleScaleVariant.Archived)]
    [InlineData(ArticleScaleVariant.Deleted)]
    public void ProductionCodec_RejectsGeneratedIdRemapWithoutFactoryPayloadRebinding(ArticleScaleVariant variant)
    {
        ArticleScaleArticleGraph graph = CreateGraph("bulk-input-first", variant);
        ArticleScaleRowPlan row = graph.Rows.First(
            candidate => candidate.Kind == ArticleScaleRowKind.ArticleMutationOutboxEnvelope);
        var item = new ArticleMutationOutboxEvent
        {
            EventId = Assert.IsType<string>(row.Fields["EventId"]),
            AggregateId = Assert.IsType<int>(row.Fields["AggregateId"]),
            SchemaVersion = Assert.IsType<int>(row.Fields["SchemaVersion"]),
            EventType = Assert.IsType<string>(row.Fields["EventType"]),
            ArticleRevisionId = Assert.IsType<long>(row.Fields["ArticleRevisionId"]),
            PayloadJson = Assert.IsType<string>(row.Fields["PayloadJson"])
        };
        ArticleMutationOutboxEnvelope original = ArticleMutationOutboxEnvelopeCodec.Read(item);
        Assert.Equal(item.ArticleRevisionId, original.Version.RevisionId);

        // A provider can rebind a foreign-key column, but cannot rewrite the factory's sealed payload.
        item.ArticleRevisionId += 1000;
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(
            () => ArticleMutationOutboxEnvelopeCodec.Read(item));
        Assert.Contains("articleRevisionId", error.Message, StringComparison.Ordinal);
    }

    private static ArticleScaleArticleGraph CreateGraph(string ownedNamespace, ArticleScaleVariant variant)
    {
        ArticleScalePlan plan = CreatePlan(ownedNamespace);
        ArticleScaleArticleGraph graph = CanonicalArticleGraphFactory.BuildArticleGraph(
            plan, 1, variant, ArticleScaleVariantContractCatalog.Get(variant));
        CanonicalArticleGraphVerifier.VerifyArticleGraph(plan, graph).ThrowIfInvalid();
        return graph;
    }

    private static ArticleScalePlan CreatePlan(string ownedNamespace)
    {
        // Syntactic artifact bindings exercise the pure input boundary only; they are not live artifact evidence.
        var artifacts = new ArticleScaleArtifactBindings(
            Reference(ArticleScaleContractIds.TemporalArtifactSchema, "resolved-temporal-roles", "data-scale.lifecycle"),
            Reference(ArticleScaleContractIds.FixtureVariantCatalogSchema, "fixture-variant-catalog", ArticleScaleContractIds.DistributionShape),
            [Reference(ArticleScaleContractIds.ContentShapeCatalogSchema, "content-shape-catalog", "script.zh-hans")],
            [Reference(ArticleScaleContractIds.MediaShapeCatalogSchema, "media-shape-catalog", "webp-landscape")],
            [Reference(ArticleScaleContractIds.FixtureVariantCatalogSchema, "fixture-variant-catalog", ArticleScaleContractIds.TaxonomyShape)]);
        ArticleScalePlan plan = ArticleScalePlanBuilder.Create("scale-s", ownedNamespace, artifacts);
        ArticleScalePlanValidator.Validate(plan, artifacts).ThrowIfInvalid();
        return plan;
    }

    private static ArticleScaleArtifactReference Reference(string schema, string authority, string shape)
        => new(schema, $"config/testing/{authority}", shape, "sha256:" + new string('1', 64));
}
