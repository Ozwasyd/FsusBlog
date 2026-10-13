using System.Text.Json;

using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Services.Fixtures.DataScale;

internal static class ExpectedArticleControls
{
    internal static void Run(string directory, string sourceCommit)
    {
        CurrentSchemaTestMaterializer.ValidateAssemblySourceCommit(sourceCommit);
        Directory.CreateDirectory(directory);
        string Digest(char value) => "sha256:" + new string(value, 64);
        var artifacts = new ArticleScaleArtifactBindings(
            new(ArticleScaleContractIds.TemporalArtifactSchema, "config/testing/resolved-temporal-roles", "data-scale.lifecycle", Digest('1')),
            new(ArticleScaleContractIds.FixtureVariantCatalogSchema, "config/testing/fixture-variant-catalog", ArticleScaleContractIds.DistributionShape, Digest('2')),
            [new(ArticleScaleContractIds.ContentShapeCatalogSchema, "config/testing/content-shape-catalog", "script.zh-hans", Digest('3'))],
            [new(ArticleScaleContractIds.MediaShapeCatalogSchema, "config/testing/media-shape-catalog", "webp-landscape", Digest('4')),
                new(ArticleScaleContractIds.MediaShapeCatalogSchema, "config/testing/media-shape-catalog", "no-cover", Digest('5'))],
            [new(ArticleScaleContractIds.FixtureVariantCatalogSchema, "config/testing/fixture-variant-catalog", ArticleScaleContractIds.TaxonomyShape, Digest('6'))]);
        const string Epoch = "2026-10-08T00:00:00.000Z";
        var results = new List<object>();
        foreach (string tier in new[] { "scale-xs", "scale-s" })
        {
            ArticleScalePlan plan = ArticleScalePlanBuilder.Create(tier, "query-expected-control", artifacts);
            var keys = new List<object>();
            var counters = new Dictionary<ArticleScaleRowKind, int>();
            foreach (ArticleScaleRowPlan row in CanonicalArticleGraphFactory.GenerateGraphStream(plan).SelectMany(graph => graph.Rows))
            {
                counters.TryGetValue(row.Kind, out int count);
                counters[row.Kind] = ++count;
                keys.Add(new
                {
                    semanticId = row.SemanticId,
                    kind = row.Kind.ToString(),
                    id = count.ToString(System.Globalization.CultureInfo.InvariantCulture)
                });
            }
            object Mapping(IEnumerable<object> sourceKeys, string source = "", string epoch = Epoch) => new
            {
                sourceCommit = source.Length == 0 ? sourceCommit : source,
                dataScaleRunId = "expected-control",
                fixtureGeneration = "controlled-map",
                seedReceiptDigest = Digest('7'),
                businessEpochUtc = epoch,
                planDigest = ArticleScalePlanDigest.Compute(plan),
                graphReceipt = CanonicalArticleGraphFactory.GenerateReceipt(plan),
                keys = sourceKeys,
                categories = Enumerable.Range(1, 6).Select(ordinal => new { ordinal, id = (100 + ordinal).ToString(), name = "category " + ordinal }).ToArray(),
                tags = Enumerable.Range(1, 11).Select(ordinal => new { ordinal, id = (200 + ordinal).ToString(), name = "tag " + ordinal }).ToArray()
            };
            JsonElement Encode(object value) => JsonSerializer.SerializeToElement(value, new JsonSerializerOptions(JsonSerializerDefaults.Web));
            object model = CanonicalQueryExpectedArticles.Project(plan, Encode(Mapping(keys)), Epoch, sourceCommit);
            QueryPlanCollector.WritePrivate(Path.Combine(directory, tier + ".json"), model);
            JsonElement early = Encode(CanonicalQueryExpectedArticles.Project(plan, Encode(Mapping(keys, epoch: "2025-01-01T00:00:00.000Z")), "2025-01-01T00:00:00.000Z", sourceCommit));
            if (early.GetProperty("publicArticles").GetArrayLength() != 0)
            {
                throw new InvalidOperationException("canonical business epoch visibility control failed");
            }
            foreach ((string name, object value) in new[]
            {
                ("missing-key", Mapping(keys.Skip(1))),
                ("duplicate-key", Mapping(keys.Append(keys[0]))),
                ("wrong-source", Mapping(keys, source: new string('a', 40))),
                ("wrong-epoch", Mapping(keys, epoch: "2025-01-01T00:00:00.000Z"))
            })
            {
                bool refused = false;
                try
                {
                    CanonicalQueryExpectedArticles.Project(plan, Encode(value), Epoch, sourceCommit);
                }
                catch
                {
                    refused = true;
                }
                if (!refused)
                {
                    throw new InvalidOperationException("canonical mapped expected negative control failed");
                }
                results.Add(new
                {
                    tier,
                    name,
                    status = "refused"
                });
            }
        }
        QueryPlanCollector.WritePrivate(Path.Combine(directory, "controls.json"), new
        {
            sourceCommit,
            qualification = "not-performed",
            fixture = "controlled-canonical-map",
            results
        });
    }
}
