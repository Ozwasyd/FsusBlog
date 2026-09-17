using System.Diagnostics;
using System.Reflection;
using System.Text.Json;

using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Fixtures.DataScale;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class CanonicalArticleGraphFactoryTests
{
    private static ArticleScaleArtifactBindings Artifacts()
        => new(
            new(
                ArticleScaleContractIds.TemporalArtifactSchema,
                "config/testing/resolved-temporal-roles",
                "data-scale.lifecycle",
                Digest('1')),
            new(
                ArticleScaleContractIds.FixtureVariantCatalogSchema,
                "config/testing/fixture-variant-catalog",
                ArticleScaleContractIds.DistributionShape,
                Digest('2')),
            [
                new(
                    ArticleScaleContractIds.ContentShapeCatalogSchema,
                    "config/testing/content-shape-catalog",
                    "script.zh-hans",
                    Digest('3'))
            ],
            [
                new(
                    ArticleScaleContractIds.MediaShapeCatalogSchema,
                    "config/testing/media-shape-catalog",
                    "webp-landscape",
                    Digest('4')),
                new(
                    ArticleScaleContractIds.MediaShapeCatalogSchema,
                    "config/testing/media-shape-catalog",
                    "no-cover",
                    Digest('5'))
            ],
            [
                new(
                    ArticleScaleContractIds.FixtureVariantCatalogSchema,
                    "config/testing/fixture-variant-catalog",
                    ArticleScaleContractIds.TaxonomyShape,
                    Digest('6'))
            ]);

    private static string Digest(char value) => "sha256:" + new string(value, 64);

    [Fact]
    public void GetProductionContractVersions_ReturnsExpectedKeys()
    {
        var versions = CanonicalArticleGraphFactory.GetProductionContractVersions();

        Assert.Equal(ArticleScaleContractIds.PlanSchema, versions["PlanSchema"]);
        Assert.Equal(ArticleScaleContractIds.GraphSchema, versions["GraphSchema"]);
        Assert.Equal(ArticleScaleContractIds.RequiredGraphFactory, versions["FactoryId"]);
        Assert.Equal(ArticleMutationOutboxEnvelopeCodec.CurrentSchemaId, versions["OutboxEnvelopeSchema"]);
        Assert.Equal("2", versions["OutboxEnvelopeVersion"]);
        Assert.Equal(ArticleMutationReplayEdges.ContractId, versions["ReplayEdgesContract"]);
    }

    [Theory]
    [InlineData(ArticleScaleVariant.Published)]
    [InlineData(ArticleScaleVariant.Scheduled)]
    [InlineData(ArticleScaleVariant.PublishedWithScheduledUpdate)]
    [InlineData(ArticleScaleVariant.Archived)]
    [InlineData(ArticleScaleVariant.Deleted)]
    public void BuildArticleGraph_MatchesVariantContractExactly(ArticleScaleVariant variant)
    {
        ArticleScalePlan plan = ArticleScalePlanBuilder.Create("scale-s", "test-run", Artifacts());
        ArticleScaleVariantContract contract = ArticleScaleVariantContractCatalog.Get(variant);

        ArticleScaleArticleGraph graph = CanonicalArticleGraphFactory.BuildArticleGraph(plan, 1, variant, contract);

        Assert.Equal(variant, graph.Variant);
        Assert.StartsWith($"{plan.IdAllocation.NamespacePrefix}:article/000001", graph.SemanticArticleId);

        // Verify row counts by kind
        var rowGroups = graph.Rows.GroupBy(r => r.Kind).ToDictionary(g => g.Key, g => g.Count());
        foreach (ArticleScaleRowRequirement req in contract.Rows)
        {
            rowGroups.TryGetValue(req.Kind, out int actualCount);
            Assert.Equal(req.CountPerArticle, actualCount);
        }

        // Verify all required relations are present
        var relationKinds = graph.Relations.Select(r => r.Kind).ToHashSet();
        foreach (ArticleScaleRelationKind rel in contract.Relations)
        {
            Assert.Contains(rel, relationKinds);
        }

        // Verify all required pointers are present
        var pointerKinds = graph.Pointers.Select(p => p.Kind).ToHashSet();
        foreach (ArticleScalePointerRequirement ptr in contract.Pointers)
        {
            Assert.Contains(ptr.Kind, pointerKinds);
        }

        // Verify verifier agrees
        var verification = CanonicalArticleGraphVerifier.VerifyArticleGraph(plan, graph);
        Assert.True(verification.IsValid, string.Join("; ", verification.Violations));
    }

    [Fact]
    public void RightsAndResponsibility_SnapshotsHaveValidCanonicalHashesWithoutSentinel()
    {
        ArticleScalePlan plan = ArticleScalePlanBuilder.Create("scale-s", "test-run", Artifacts());

        foreach (ArticleScaleVariant variant in Enum.GetValues<ArticleScaleVariant>())
        {
            var contract = ArticleScaleVariantContractCatalog.Get(variant);
            var graph = CanonicalArticleGraphFactory.BuildArticleGraph(plan, 42, variant, contract);

            var rightsSnapshots = graph.Rows.Where(r => r.Kind == ArticleScaleRowKind.ArticleRightsSnapshot).ToList();
            Assert.NotEmpty(rightsSnapshots);

            foreach (var rightsRow in rightsSnapshots)
            {
                string policyHash = Assert.IsType<string>(rightsRow.Fields["PolicyHash"]);
                string contentHash = Assert.IsType<string>(rightsRow.Fields["ContentCanonicalHash"]);

                Assert.False(string.IsNullOrWhiteSpace(policyHash));
                Assert.False(string.IsNullOrWhiteSpace(contentHash));
                Assert.DoesNotContain("recompute", policyHash, StringComparison.OrdinalIgnoreCase);
                Assert.DoesNotContain("sentinel", policyHash, StringComparison.OrdinalIgnoreCase);
                Assert.DoesNotContain("recompute", contentHash, StringComparison.OrdinalIgnoreCase);
                Assert.DoesNotContain("sentinel", contentHash, StringComparison.OrdinalIgnoreCase);
            }

            var respSnapshots = graph.Rows.Where(r => r.Kind == ArticleScaleRowKind.ArticleResponsibilitySnapshot).ToList();
            Assert.NotEmpty(respSnapshots);

            foreach (var respRow in respSnapshots)
            {
                Assert.True(Assert.IsType<bool>(respRow.Fields["ResponsiblePersonConfirmed"]));
                string authorsJson = Assert.IsType<string>(respRow.Fields["AuthorsJson"]);
                string sourcesJson = Assert.IsType<string>(respRow.Fields["SourcesJson"]);
                Assert.NotEqual("[]", authorsJson);
                Assert.NotEqual("[]", sourcesJson);
            }
        }
    }

    [Fact]
    public void ScheduledVariants_RequireFutureDueAndRetainPublicationHistoryOnlyForUpdate()
    {
        ArticleScalePlan plan = ArticleScalePlanBuilder.Create("scale-s", "test-run", Artifacts());

        // Scheduled
        var schedGraph = CanonicalArticleGraphFactory.BuildArticleGraph(
            plan, 10, ArticleScaleVariant.Scheduled, ArticleScaleVariantContractCatalog.Get(ArticleScaleVariant.Scheduled));
        var schedArticle = schedGraph.Rows.Single(r => r.Kind == ArticleScaleRowKind.Article);
        Assert.Equal((int)ArticleStatus.Scheduled, schedArticle.Fields["Status"]);
        Assert.NotNull(schedArticle.Fields["ScheduledPublishAt"]);
        Assert.Null(schedArticle.Fields["PublishedAt"]);
        Assert.Null(schedArticle.Fields["CurrentPublicationId"]);
        Assert.DoesNotContain(schedGraph.Rows, static r => r.Kind == ArticleScaleRowKind.ArticlePublication);

        // PublishedWithScheduledUpdate
        var updateGraph = CanonicalArticleGraphFactory.BuildArticleGraph(
            plan, 11, ArticleScaleVariant.PublishedWithScheduledUpdate,
            ArticleScaleVariantContractCatalog.Get(ArticleScaleVariant.PublishedWithScheduledUpdate));
        var updateArticle = updateGraph.Rows.Single(r => r.Kind == ArticleScaleRowKind.Article);
        Assert.Equal((int)ArticleStatus.Published, updateArticle.Fields["Status"]);
        Assert.NotNull(updateArticle.Fields["PublishedAt"]);
        Assert.NotNull(updateArticle.Fields["PendingPublicationAt"]);
        Assert.NotNull(updateArticle.Fields["CurrentPublicationId"]);
        Assert.Contains("revision/2", Assert.IsType<string>(updateArticle.Fields["CurrentRevisionId"]));
        Assert.Single(updateGraph.Rows, static r => r.Kind == ArticleScaleRowKind.ArticlePublication);
        Assert.Equal(2, updateGraph.Rows.Count(r => r.Kind == ArticleScaleRowKind.ArticleRevision));
    }

    [Fact]
    public void ArchivedAndDeletedVariants_RetainFullPublicationHistory()
    {
        ArticleScalePlan plan = ArticleScalePlanBuilder.Create("scale-s", "test-run", Artifacts());

        // Archived
        var archGraph = CanonicalArticleGraphFactory.BuildArticleGraph(
            plan, 20, ArticleScaleVariant.Archived, ArticleScaleVariantContractCatalog.Get(ArticleScaleVariant.Archived));
        var archArticle = archGraph.Rows.Single(r => r.Kind == ArticleScaleRowKind.Article);
        Assert.Equal((int)ArticleStatus.Archived, archArticle.Fields["Status"]);
        Assert.False(Assert.IsType<bool>(archArticle.Fields["IsDeleted"]));
        Assert.NotNull(archArticle.Fields["ArchivedAt"]);
        Assert.NotNull(archArticle.Fields["PublishedAt"]);
        Assert.Single(archGraph.Rows, static r => r.Kind == ArticleScaleRowKind.ArticlePublication);

        // Deleted
        var delGraph = CanonicalArticleGraphFactory.BuildArticleGraph(
            plan, 21, ArticleScaleVariant.Deleted, ArticleScaleVariantContractCatalog.Get(ArticleScaleVariant.Deleted));
        var delArticle = delGraph.Rows.Single(r => r.Kind == ArticleScaleRowKind.Article);
        Assert.Equal((int)ArticleStatus.Deleted, delArticle.Fields["Status"]);
        Assert.True(Assert.IsType<bool>(delArticle.Fields["IsDeleted"]));
        Assert.NotNull(delArticle.Fields["DeletedAt"]);
        Assert.NotNull(delArticle.Fields["PublishedAt"]);
        Assert.Single(delGraph.Rows, static r => r.Kind == ArticleScaleRowKind.ArticlePublication);
    }

    [Fact]
    public void OutboxEnvelopes_MatchProductionCodecAndDeclareRequiredEdges()
    {
        ArticleScalePlan plan = ArticleScalePlanBuilder.Create("scale-s", "test-run", Artifacts());

        foreach (ArticleScaleVariant variant in Enum.GetValues<ArticleScaleVariant>())
        {
            var contract = ArticleScaleVariantContractCatalog.Get(variant);
            var graph = CanonicalArticleGraphFactory.BuildArticleGraph(plan, 30, variant, contract);

            var outboxRows = graph.Rows.Where(r => r.Kind == ArticleScaleRowKind.ArticleMutationOutboxEnvelope).ToList();
            Assert.NotEmpty(outboxRows);

            foreach (var outboxRow in outboxRows)
            {
                var evt = new ArticleMutationOutboxEvent
                {
                    EventId = (string)outboxRow.Fields["EventId"]!,
                    AggregateId = (int)outboxRow.Fields["AggregateId"]!,
                    SchemaVersion = (int)outboxRow.Fields["SchemaVersion"]!,
                    ArticleRevisionId = (long?)outboxRow.Fields["ArticleRevisionId"],
                    RevisionNo = (int?)outboxRow.Fields["RevisionNo"],
                    RightsSnapshotId = (long?)outboxRow.Fields["RightsSnapshotId"],
                    ResponsibilitySnapshotId = (long?)outboxRow.Fields["ResponsibilitySnapshotId"],
                    ResponsibilityVersion = (int?)outboxRow.Fields["ResponsibilityVersion"],
                    ArticlePublicationId = (long?)outboxRow.Fields["ArticlePublicationId"],
                    PublicationNo = (int?)outboxRow.Fields["PublicationNo"],
                    EventType = (string)outboxRow.Fields["EventType"]!,
                    PayloadJson = (string)outboxRow.Fields["PayloadJson"]!,
                    CreatedAt = DateTime.Parse((string)outboxRow.Fields["CreatedAt"]!, null, System.Globalization.DateTimeStyles.RoundtripKind)
                };

                var envelope = ArticleMutationOutboxEnvelopeCodec.Read(evt);
                Assert.Equal(ArticleMutationOutboxEnvelopeCodec.CurrentSchemaVersion, envelope.SchemaVersion);
                Assert.Equal(evt.AggregateId, envelope.ArticleId);
                Assert.Equal(evt.EventType, envelope.EventType);
            }

            // Verify edge obligations match
            int expectedEdgeCount = contract.Transitions.Count * plan.Outbox.RequiredEdges.Count;
            Assert.Equal(expectedEdgeCount, graph.EdgeObligations.Count);
        }
    }

    [Fact]
    public void DeterministicGraphDigest_ProducesIdenticalDigestForIdenticalPlanAndDiffersForModifiedPlan()
    {
        ArticleScalePlan plan1 = ArticleScalePlanBuilder.Create("scale-s", "run-1", Artifacts());
        ArticleScalePlan plan2 = ArticleScalePlanBuilder.Create("scale-s", "run-1", Artifacts());

        var receipt1 = CanonicalArticleGraphFactory.GenerateReceipt(plan1);
        var receipt2 = CanonicalArticleGraphFactory.GenerateReceipt(plan2);

        Assert.Equal(receipt1.SemanticGraphDigest, receipt2.SemanticGraphDigest);

        // Plan with different namespace -> produces different digest
        ArticleScalePlan planModified = ArticleScalePlanBuilder.Create("scale-s", "run-2", Artifacts());
        var receiptModified = CanonicalArticleGraphFactory.GenerateReceipt(planModified);
        Assert.NotEqual(receipt1.SemanticGraphDigest, receiptModified.SemanticGraphDigest);
    }

    [Fact]
    public void StreamingGeneration_MaintainsBoundedBatches()
    {
        ArticleScalePlan plan = ArticleScalePlanBuilder.Create("scale-s", "run-stream", Artifacts());

        int batchCount = 0;
        int totalArticles = 0;
        foreach (var batch in CanonicalArticleGraphFactory.GenerateBatches(plan, batchSize: 25))
        {
            batchCount++;
            totalArticles += batch.Count;
            Assert.InRange(batch.Count, 1, 25);
        }

        Assert.Equal(4, batchCount);
        Assert.Equal(100, totalArticles);
    }

    [Fact]
    public void Verifier_ValidatesCleanStreamAndRejectsTamperedReceiptOrRows()
    {
        ArticleScalePlan plan = ArticleScalePlanBuilder.Create("scale-s", "run-verify", Artifacts());
        var receipt = CanonicalArticleGraphFactory.GenerateReceipt(plan);

        // Clean verification passes
        var cleanResult = CanonicalArticleGraphVerifier.VerifyFullStream(
            plan,
            CanonicalArticleGraphFactory.GenerateGraphStream(plan),
            receipt);
        Assert.True(cleanResult.IsValid, string.Join("; ", cleanResult.Violations));

        // Tampered receipt variant count
        var tamperedVariantCounts = new Dictionary<string, int>(receipt.VariantCounts)
        {
            [ArticleScaleVariant.Published.ToString()] = receipt.VariantCounts[ArticleScaleVariant.Published.ToString()] + 1
        };
        var tamperedReceipt = receipt with
        {
            VariantCounts = tamperedVariantCounts
        };
        var tamperedResult = CanonicalArticleGraphVerifier.VerifyReceipt(plan, tamperedReceipt);
        Assert.False(tamperedResult.IsValid);
        Assert.Contains(tamperedResult.Violations, v => v.Contains("receipt_variant_count_mismatch"));

        // Tampered row in article graph
        var contract = ArticleScaleVariantContractCatalog.Get(ArticleScaleVariant.Published);
        var cleanGraph = CanonicalArticleGraphFactory.BuildArticleGraph(plan, 1, ArticleScaleVariant.Published, contract);

        var tamperedRows = cleanGraph.Rows.Select(r =>
        {
            if (r.Kind == ArticleScaleRowKind.Article)
            {
                var fields = new Dictionary<string, object?>(r.Fields)
                {
                    ["Title"] = "Tampered Title"
                };
                return new ArticleScaleRowPlan(r.Kind, r.SemanticId, fields);
            }
            return r;
        }).ToList();

        var tamperedGraph = new ArticleScaleArticleGraph(
            cleanGraph.SemanticArticleId,
            cleanGraph.ArticleOrdinal,
            cleanGraph.Variant,
            tamperedRows,
            cleanGraph.Relations,
            cleanGraph.Pointers,
            cleanGraph.EdgeObligations,
            cleanGraph.ArticleDigest);

        var rowTamperedResult = CanonicalArticleGraphVerifier.VerifyArticleGraph(plan, tamperedGraph);
        Assert.False(rowTamperedResult.IsValid);
        Assert.Contains(rowTamperedResult.Violations, v => v.Contains("article_digest_tamper_detected"));
    }

    [Fact]
    public void ProductionModelDrift_FailClosedWhenBusinessPropertiesNotMapped()
    {
        ArticleScalePlan plan = ArticleScalePlanBuilder.Create("scale-s", "drift-check", Artifacts());
        var contract = ArticleScaleVariantContractCatalog.Get(ArticleScaleVariant.Published);
        var graph = CanonicalArticleGraphFactory.BuildArticleGraph(plan, 1, ArticleScaleVariant.Published, contract);

        // Check Article entity properties
        AssertEntityPropertiesMapped<Article>(graph, ArticleScaleRowKind.Article);

        // Check ArticleRevision entity properties
        AssertEntityPropertiesMapped<ArticleRevision>(graph, ArticleScaleRowKind.ArticleRevision);

        // Check ArticlePublicationRecord entity properties
        AssertEntityPropertiesMapped<ArticlePublicationRecord>(graph, ArticleScaleRowKind.ArticlePublication);

        // Check ArticleBody entity properties
        AssertEntityPropertiesMapped<ArticleBody>(graph, ArticleScaleRowKind.ArticleBody);

        // Check ArticleRightsPolicy entity properties
        AssertEntityPropertiesMapped<ArticleRightsPolicy>(graph, ArticleScaleRowKind.ArticleRightsPolicy);

        // Check ArticleRightsSnapshot entity properties
        AssertEntityPropertiesMapped<ArticleRightsSnapshot>(graph, ArticleScaleRowKind.ArticleRightsSnapshot);

        // Check ArticleRightsProof entity properties
        AssertEntityPropertiesMapped<ArticleRightsProof>(graph, ArticleScaleRowKind.ArticleRightsProof);

        // Check ArticleResponsibilitySnapshot entity properties
        AssertEntityPropertiesMapped<ArticleResponsibilitySnapshot>(graph, ArticleScaleRowKind.ArticleResponsibilitySnapshot);

        // Check ArticleMutationOutboxEvent entity properties
        AssertEntityPropertiesMapped<ArticleMutationOutboxEvent>(graph, ArticleScaleRowKind.ArticleMutationOutboxEnvelope);

        // Check ArticleMutationOutboxEdge entity properties
        AssertEntityPropertiesMapped<ArticleMutationOutboxEdge>(graph, ArticleScaleRowKind.ArticleMutationOutboxEdge);
    }

    [Fact]
    public void LifecycleCoordinates_AreDerivedFromCreatePlanAndDeleteFlow()
    {
        ArticleScalePlan plan = ArticleScalePlanBuilder.Create("scale-s", "lifecycle", Artifacts());

        foreach (ArticleScaleVariant variant in Enum.GetValues<ArticleScaleVariant>())
        {
            ArticleScaleVariantContract contract = ArticleScaleVariantContractCatalog.Get(variant);
            var temporal = CanonicalArticleGraphFactory.ResolveTemporalMap(1, contract);
            var derived = CanonicalArticleGraphFactory.DeriveLifecycleCoordinates(contract, temporal);
            var graph = CanonicalArticleGraphFactory.BuildArticleGraph(plan, 1, variant, contract);
            var article = graph.Rows.Single(r => r.Kind == ArticleScaleRowKind.Article);

            Assert.Equal((int)contract.TerminalStatus, article.Fields["Status"]);
            Assert.Equal(contract.IsDeleted, Assert.IsType<bool>(article.Fields["IsDeleted"]));
            Assert.Equal(derived.PublishedAt?.ToString("O"), article.Fields["PublishedAt"]?.ToString());
            Assert.Equal(derived.ScheduledPublishAt?.ToString("O"), article.Fields["ScheduledPublishAt"]?.ToString());
            Assert.Equal(derived.PendingPublicationAt?.ToString("O"), article.Fields["PendingPublicationAt"]?.ToString());
            Assert.Equal(derived.ArchivedAt?.ToString("O"), article.Fields["ArchivedAt"]?.ToString());
            Assert.Equal(derived.DeletedAt?.ToString("O"), article.Fields["DeletedAt"]?.ToString());
            Assert.Equal(derived.PublicUpdatedAt?.ToString("O"), article.Fields["PublicUpdatedAt"]?.ToString());

            bool hasPublication = contract.Rows.Single(r => r.Kind == ArticleScaleRowKind.ArticlePublication).CountPerArticle > 0;
            Assert.Equal(hasPublication, derived.HasPublication);
            if (hasPublication)
            {
                var publication = graph.Rows.Single(r => r.Kind == ArticleScaleRowKind.ArticlePublication);
                Assert.Equal(derived.PublicationTransitionKind, publication.Fields["TransitionKind"]);
                Assert.Equal(
                    ArticlePublicationTransitionKinds.ImmediatePublish,
                    publication.Fields["TransitionKind"]);
            }
        }
    }

    [Fact]
    public void AuthorityFields_UseSemanticRolesAndHonestProofStatus()
    {
        ArticleScalePlan plan = ArticleScalePlanBuilder.Create("scale-s", "authority", Artifacts());

        foreach (ArticleScaleVariant variant in Enum.GetValues<ArticleScaleVariant>())
        {
            var graph = CanonicalArticleGraphFactory.BuildArticleGraph(
                plan, 7, variant, ArticleScaleVariantContractCatalog.Get(variant));

            foreach (var revision in graph.Rows.Where(r => r.Kind == ArticleScaleRowKind.ArticleRevision))
            {
                Assert.False(revision.Fields.ContainsKey("ContentBlockId"));
                Assert.False(revision.Fields.ContainsKey("CreatedByAdminPrincipalId"));
                Assert.True(revision.Fields.ContainsKey("ContentBlockSemanticId"));
                Assert.True(revision.Fields.ContainsKey("CreatedByAdminPrincipalSemanticId"));
                Assert.Contains(":principal/authoring-admin", Assert.IsType<string>(revision.Fields["CreatedByAdminPrincipalSemanticId"]));
            }

            foreach (var proof in graph.Rows.Where(r => r.Kind == ArticleScaleRowKind.ArticleRightsProof))
            {
                string status = Assert.IsType<string>(proof.Fields["ProofStatus"]);
                Assert.Contains(status, new[] { "pending", "not-public" });
                Assert.Null(proof.Fields["SignatureBase64Url"]);
                Assert.Null(proof.Fields["SigningKeyId"]);
                Assert.Null(proof.Fields["SigningKeyVersion"]);
                Assert.Null(proof.Fields["SigningAlgorithm"]);
                Assert.Null(proof.Fields["PublishProofId"]);
            }

            foreach (var audit in graph.Rows.Where(r => r.Kind == ArticleScaleRowKind.ArticleAuditCoordinate))
            {
                Assert.False(audit.Fields.ContainsKey("ActorPrincipalId"));
                Assert.Contains(":principal/authoring-admin", Assert.IsType<string>(audit.Fields["ActorPrincipalSemanticId"]));
            }
        }
    }

    [Theory]
    [InlineData(100_000)]
    [InlineData(1_000_000)]
    public void Streaming_100kAnd1M_KeepBoundedWorkingSet(int articleCount)
    {
        ArticleScalePlan plan = ArticleScalePlanBuilder.Create("scale-xs", $"stream-{articleCount}", Artifacts());
        ArticleScaleVariant[] variants = Enum.GetValues<ArticleScaleVariant>();

        GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: true);
        GC.WaitForPendingFinalizers();
        GC.Collect(2, GCCollectionMode.Forced, blocking: true, compacting: true);

        using Process process = Process.GetCurrentProcess();
        process.Refresh();
        long baselineWorkingSet = process.WorkingSet64;
        long peakWorkingSet = baselineWorkingSet;
        long firstSampleAfterWarmup = 0;
        int produced = 0;

        for (int i = 0; i < articleCount; i++)
        {
            ArticleScaleVariant variant = variants[i % variants.Length];
            ArticleScaleVariantContract contract = ArticleScaleVariantContractCatalog.Get(variant);
            ArticleScaleArticleGraph graph = CanonicalArticleGraphFactory.BuildArticleGraph(
                plan,
                i + 1,
                variant,
                contract);
            if (graph.Rows.Count == 0 || string.IsNullOrWhiteSpace(graph.ArticleDigest))
            {
                throw new InvalidOperationException("streaming graph produced empty output");
            }

            produced++;
            if ((i & 0x3FFF) == 0)
            {
                process.Refresh();
                long ws = process.WorkingSet64;
                peakWorkingSet = Math.Max(peakWorkingSet, ws);
                if (i == 0)
                {
                    firstSampleAfterWarmup = ws;
                }
                else if (firstSampleAfterWarmup == 0)
                {
                    firstSampleAfterWarmup = ws;
                }
            }
        }

        process.Refresh();
        peakWorkingSet = Math.Max(peakWorkingSet, process.WorkingSet64);
        long growth = Math.Max(0, peakWorkingSet - baselineWorkingSet);

        // Streaming must remain sub-linear: a few hundred MiB ceiling covers builder/scratch,
        // not O(N) retention of full graphs.
        const long MaxGrowthBytes = 768L * 1024 * 1024;
        Assert.Equal(articleCount, produced);
        Assert.True(
            growth < MaxGrowthBytes,
            $"WorkingSet growth {growth} bytes exceeds bound {MaxGrowthBytes} for N={articleCount}; baseline={baselineWorkingSet}, peak={peakWorkingSet}");

        if (firstSampleAfterWarmup > 0)
        {
            Assert.True(
                peakWorkingSet < firstSampleAfterWarmup + MaxGrowthBytes,
                $"WorkingSet peaked at {peakWorkingSet} from warmup sample {firstSampleAfterWarmup}");
        }
    }

    private static void AssertEntityPropertiesMapped<TEntity>(
        ArticleScaleArticleGraph graph,
        ArticleScaleRowKind rowKind)
    {
        var row = graph.Rows.FirstOrDefault(r => r.Kind == rowKind);
        Assert.NotNull(row);

        var entityProperties = typeof(TEntity).GetProperties(BindingFlags.Public | BindingFlags.Instance);
        foreach (PropertyInfo prop in entityProperties)
        {
            var sugarCol = prop.GetCustomAttribute<SugarColumn>();
            // Ignore navigation properties and database generated identity PKs
            if (sugarCol is not null && sugarCol.IsIgnore)
            {
                continue;
            }
            if (sugarCol is not null && sugarCol.IsIdentity)
            {
                continue;
            }
            if (sugarCol is not null && sugarCol.IsPrimaryKey && string.Equals(prop.Name, "Id", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }
            if (prop.PropertyType.IsGenericType && prop.PropertyType.GetGenericTypeDefinition() == typeof(List<>))
            {
                continue; // Navigation list
            }

            // Every other persistent business property must be represented in the row's fields dictionary
            // (either under exact PropertyName or Semantic counterpart like ArticleSemanticId for ArticleId)
            bool isMapped = row.Fields.ContainsKey(prop.Name)
                || row.Fields.ContainsKey($"{prop.Name}SemanticId")
                || (prop.Name.EndsWith("Id", StringComparison.Ordinal) && row.Fields.ContainsKey(prop.Name[..^2] + "SemanticId"));

            Assert.True(isMapped, $"Entity '{typeof(TEntity).Name}' property '{prop.Name}' is not mapped in row kind '{rowKind}'. Model drift fail-closed triggered!");
        }
    }
}
