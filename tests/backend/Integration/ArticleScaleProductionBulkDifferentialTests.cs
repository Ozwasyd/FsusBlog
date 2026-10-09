using System.Data.Common;
using System.Text.Json;

using FsusBlog.Contracts.Articles;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Articles;
using FsusBlog.Server.Services.Fixtures;
using FsusBlog.Server.Services.Fixtures.DataScale;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Data.Sqlite;
using Microsoft.Extensions.Configuration;

using MySqlConnector;

using Npgsql;

using NSubstitute;

using SqlSugar;

using Xunit.Abstractions;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class ArticleScaleProductionBulkDifferentialTests(
    PostgresSchemaMigrationFixture fixture,
    ITestOutputHelper output)
{
    public static IEnumerable<object[]> VariantCases
        => ArticleScaleVariantContractCatalog.Variants.Select(variant => new object[] { variant });

    [Theory]
    [MemberData(nameof(VariantCases))]
    public async Task ActualProductionWriterAndAtomicBulkFactory_ExposeCurrentSemanticDrift(ArticleScaleVariant variant)
    {
        using var cancellation = new CancellationTokenSource(TimeSpan.FromMinutes(3));
        string productionConnection = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        string bulkConnection = await PostgresSqlSugarTestClient.CreateConnectionStringAsync(fixture);
        Assert.NotEqual(new NpgsqlConnectionStringBuilder(productionConnection).Database,
            new NpgsqlConnectionStringBuilder(bulkConnection).Database);
        using SqlSugarClient production = PostgresSqlSugarTestClient.Create(productionConnection);
        using SqlSugarClient bulk = PostgresSqlSugarTestClient.Create(bulkConnection);
        Type[] graphModels = DataScaleArticlePhysicalProjection.EntityModels.Select(model => model.Entity).ToArray();
        PostgresSqlSugarTestClient.InitTables(production,
            [.. graphModels, typeof(Category), typeof(Tag), typeof(AdminPrincipal), typeof(AuditLog),
                typeof(ArticleTag), typeof(ContentAsset), typeof(ContentAssetReference),
                typeof(ContentAssetCleanupQueueItem), typeof(ArticleMutationCommand)]);
        PostgresSqlSugarTestClient.InitTables(bulk, graphModels);
        var schema = DataScaleArticlePhysicalProjection.EntityModels.ToDictionary(model => model.Kind, model =>
        {
            var entity = production.EntityMaintenance.GetEntityInfo(model.Entity);
            return new DataScaleEntityTransportBinding(entity.DbTableName,
                entity.Columns.Where(column => !column.IsIgnore).ToDictionary(column => column.PropertyName,
                    column => column.DbColumnName.ToLowerInvariant()));
        });
        var (plan, diagnostic) = Inputs(variant);
        ArticleScaleRowPlan article = diagnostic.Rows.Single(row => row.Kind == ArticleScaleRowKind.Article);
        ArticleScaleRowPlan body = diagnostic.Rows.Single(row => row.Kind == ArticleScaleRowKind.ArticleBody);
        ArticleScaleRowPlan initialRevision = diagnostic.Rows.First(row => row.Kind == ArticleScaleRowKind.ArticleRevision);
        DateTime commandTime = TestTemporalContext.FromEnvironment().BusinessEpochUtc.UtcDateTime;
        long adminId = await production.Insertable(new AdminPrincipal
        {
            Handle = "differential-admin",
            DisplayName = "Differential Admin",
            Status = AdminPrincipalStatus.Active,
            Permissions = string.Join('\n', AdminPermissions.ArticleWrite, AdminPermissions.ArticlePublish),
            CreatedAtUtc = commandTime
        }).ExecuteReturnBigIdentityAsync();
        int category = Convert.ToInt32(article.Fields["CategoryId"]);
        foreach (int id in Enumerable.Range(1, 5))
            await production.Insertable(new Category { Id = id, Name = $"category-{id}" }).ExecuteCommandAsync();
        foreach (int id in Enumerable.Range(1, 10))
            await production.Insertable(new Tag { Id = id, Name = $"tag-{id}" }).ExecuteCommandAsync();
        int[] tags = Convert.ToString(diagnostic.Rows.First(row => row.Kind == ArticleScaleRowKind.ArticleRevision).Fields["TagIds"])!
            .Split(',').Select(int.Parse).ToArray();
        string lifecycleVariant = variant switch
        {
            ArticleScaleVariant.PublishedWithScheduledUpdate => CanonicalArticleLifecycleVariants.PublishedScheduledUpdate,
            _ => variant.ToString().ToLowerInvariant()
        };
        DateTime? due = article.Fields["ScheduledPublishAt"] is string scheduled
            ? DateTime.Parse(scheduled, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.RoundtripKind)
            : article.Fields["PendingPublicationAt"] is string pending
                ? DateTime.Parse(pending, System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.RoundtripKind)
                : null;
        var binding = new CanonicalArticleLifecycleFixtureBinding("writer-differential", "production-root",
            "writer-differential", ["article.write", "article.publish"], adminId,
            CanonicalArticleLifecycleFixturePort.CurrentWriterContractDigest, plan.Artifacts.Temporal.ContentDigest);
        var filter = Substitute.For<IContentFilterService>();
        filter.ValidateContent(Arg.Any<string>()).Returns(new ContentValidationResult(true, "ok", string.Empty));
        var port = new CanonicalArticleLifecycleFixturePort(production,
            new ConfigurationBuilder().AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["Audit:TamperEvidenceKey"] = "differential-component-key-0123456789abcdef"
            }).Build(), new ArticlePublicationValidator(production, filter),
            Substitute.For<IArticlePublicMutationFence>(), TestTemporalContext.FromEnvironment().BusinessClock);
        CanonicalArticleLifecycleResult productionResult = await port.ExecuteAsync(new(binding,
            new CanonicalArticleLifecyclePlan(diagnostic.SemanticArticleId, lifecycleVariant,
                (string)initialRevision.Fields["Title"]!, (string)body.Fields["MarkdownContent"]!,
                (string?)article.Fields["Summary"], (string?)article.Fields["CoverImageUrl"], category, tags,
                null, Responsibility(diagnostic), due)));
        Assert.True(productionResult.Verification.IsValid,
            string.Join(';', productionResult.Verification.Violations));
        Assert.False(productionResult.IdempotencyReplay);

        // Diagnostic transport identities are deliberately not allocator provenance.
        // No qualified seed or parity receipt is emitted by this test.
        Dictionary<string, long> ids = diagnostic.Rows.Where(row => row.Kind is not
            (ArticleScaleRowKind.ArticleBody or ArticleScaleRowKind.ArticleTaxonomyReference or ArticleScaleRowKind.ArticleAuditCoordinate))
            .Select((row, index) => (row.SemanticId, Id: 7001L + index)).ToDictionary(item => item.SemanticId, item => item.Id);
        foreach (var aliases in diagnostic.Rows.Where(row => row.Kind == ArticleScaleRowKind.ArticleRevisionContentBlock)
                     .GroupBy(row => row.Fields["ContentHash"]))
            foreach (ArticleScaleRowPlan alias in aliases.Skip(1))
                ids[alias.SemanticId] = ids[aliases.First().SemanticId];
        var identities = new ArticleScaleGraphIdentityBindings(ArticleScalePlanDigest.Compute(plan), diagnostic.SemanticArticleId, ids);
        ArticleScaleArticleGraph graph = CanonicalArticleGraphFactory.BuildArticleGraph(plan, diagnostic.ArticleOrdinal,
            variant, ArticleScaleVariantContractCatalog.Get(variant), identities);
        DataScaleArticlePhysicalBatch model = DataScaleArticlePhysicalProjection.Compile(plan, [graph],
            new Dictionary<string, ArticleScaleGraphIdentityBindings> { [graph.SemanticArticleId] = identities },
            schema, new Dictionary<string, long> { [$"{plan.IdAllocation.NamespacePrefix}:principal/authoring-admin"] = adminId });
        DataScaleArticlePhysicalWritePlan writes = DataScaleArticlePhysicalProjection.PrepareWrites(model);
        await using var bulkNative = new NpgsqlConnection(bulkConnection);
        await bulkNative.OpenAsync();
        DataScaleBulkExecution execution = await DataScaleProviderBulkTransport.ExecuteAtomicBatchAsync(bulkNative,
            DataScaleBulkProvider.PostgreSql, writes.Inserts, writes.DeferredUpdates,
            DataScalePhysicalBatchReadback.ExpectedDigest(model),
            (connection, transaction, token) => DataScalePhysicalBatchReadback.ObserveAsync(connection, transaction,
                DataScaleBulkProvider.PostgreSql, model, token), cancellation.Token);
        Assert.Equal(DataScaleBulkCommitState.Committed, execution.State);
        await using var productionNative = new NpgsqlConnection(productionConnection);
        await productionNative.OpenAsync();
        DataScaleArticlePhysicalBatch observedProduction = await ArticleScaleWriterDifferential.ObserveIsolatedRootAsync(
            productionNative, DataScaleBulkProvider.PostgreSql, model, cancellation.Token,
            schema.Values.Select(table => table.Table).ToArray());
        DataScaleArticlePhysicalBatch observedBulk = await ArticleScaleWriterDifferential.ObserveIsolatedRootAsync(
            bulkNative, DataScaleBulkProvider.PostgreSql, model, cancellation.Token,
            schema.Values.Select(table => table.Table).ToArray());
        ArticleScaleWriterDifferentialResult factoryReadback = ArticleScaleWriterDifferential.Compare(model, observedBulk);
        Assert.True(factoryReadback.PhysicalEquivalent);
        ArticleScaleWriterDifferentialResult result = ArticleScaleWriterDifferential.Compare(observedProduction, observedBulk);
        IReadOnlyDictionary<string, IReadOnlyDictionary<string, string>> references = ReferenceTargets(schema);
        ArticleScaleDifferentialIdentityBindings bulkRoles = ArticleScaleDifferentialIdentityBindings.FromCanonicalGraph(
            plan, graph, identities, schema, references);
        ArticleScaleDifferentialIdentityBindings productionRoles = ObservedProductionRoles(
            observedProduction, graph, productionResult.Receipt, schema, references);
        ArticleScaleWriterDifferentialResult semantic = ArticleScaleWriterDifferential.Compare(
            observedProduction, observedBulk, productionRoles, bulkRoles);
        // Synthetic diagnostic rows are retained independently of receipts so reviewers can
        // recompute a failed comparison after task-owned databases have been disposed.
        output.WriteLine(JsonSerializer.Serialize(new
        {
            schema = "fsusblog.article-writer-differential-component-diagnostic.v1",
            sourceCommit = Environment.GetEnvironmentVariable("FSUSBLOG_PARITY_SOURCE_COMMIT"),
            variant,
            productionContractVersions = CanonicalArticleGraphFactory.GetProductionContractVersions(),
            plan,
            graph,
            identities,
            production = productionResult.Receipt,
            productionRows = observedProduction,
            bulkRows = observedBulk,
            productionRoles,
            bulkRoles,
            execution,
            result,
            semantic,
            qualificationEligible = result.QualificationEligible,
            identityNormalizedEquivalent = semantic.IdentityNormalizedEquivalent
        }));
        Assert.False(result.QualificationEligible);
        Assert.False(result.PhysicalEquivalent);
        Assert.NotEmpty(result.Differences);
        Assert.Contains(semantic.Differences, difference => difference.Field == schema[ArticleScaleRowKind.Article].Columns["CreateTime"]);
        Assert.False(semantic.IdentityNormalizedEquivalent);
        Assert.Contains("logical-persistence-unverified:ArticleAuditCoordinate", result.MissingPostconditions);
        Assert.Contains("logical-persistence-unverified:ArticleTaxonomyReference", result.MissingPostconditions);

        // Same sealed rows can be consumed by another provider without remapping business fields.
        await using var sqlite = new SqliteConnection("Data Source=:memory:");
        await sqlite.OpenAsync();
        await CreateDiagnosticTablesAsync(sqlite, DataScaleBulkProvider.Sqlite, model);
        DataScaleBulkExecution sqliteExecution = await DataScaleProviderBulkTransport.ExecuteAtomicBatchAsync(sqlite,
            DataScaleBulkProvider.Sqlite, writes.Inserts, writes.DeferredUpdates,
            DataScalePhysicalBatchReadback.ExpectedDigest(model),
            (connection, transaction, token) => DataScalePhysicalBatchReadback.ObserveAsync(connection, transaction,
                DataScaleBulkProvider.Sqlite, model, token), cancellation.Token);
        Assert.Equal(DataScaleBulkCommitState.Committed, sqliteExecution.State);
        DataScaleArticlePhysicalBatch sqliteRows = await ArticleScaleWriterDifferential.ObserveIsolatedRootAsync(
            sqlite, DataScaleBulkProvider.Sqlite, model, cancellation.Token);
        Assert.True(ArticleScaleWriterDifferential.Compare(observedBulk, sqliteRows).PhysicalEquivalent);
        await VerifyMySqlAsync(model, writes, observedBulk, cancellation.Token);
    }

    private static async Task VerifyMySqlAsync(DataScaleArticlePhysicalBatch model,
        DataScaleArticlePhysicalWritePlan writes, DataScaleArticlePhysicalBatch postgresRows, CancellationToken cancellationToken)
    {
        string raw = Environment.GetEnvironmentVariable("FSUSBLOG_PARITY_MYSQL_CONNECTION_STRING")
            ?? throw new InvalidOperationException("task-owned MySQL parity connection is required");
        var root = new MySqlConnectionStringBuilder(raw);
        if (root.Database != "fsusblog_parity")
            throw new InvalidOperationException("task-owned MySQL parity root mismatch");
        await using var admin = new MySqlConnection(raw);
        await admin.OpenAsync(cancellationToken);
        string database = "parity_" + Guid.NewGuid().ToString("N");
        await using (DbCommand create = admin.CreateCommand())
        {
            create.CommandText = $"CREATE DATABASE `{database}`";
            await create.ExecuteNonQueryAsync(cancellationToken);
        }
        root.Database = database;
        await using var connection = new MySqlConnection(root.ConnectionString);
        await connection.OpenAsync(cancellationToken);
        await CreateDiagnosticTablesAsync(connection, DataScaleBulkProvider.MySql, model);
        DataScaleBulkExecution execution = await DataScaleProviderBulkTransport.ExecuteAtomicBatchAsync(connection,
            DataScaleBulkProvider.MySql, writes.Inserts, writes.DeferredUpdates,
            DataScalePhysicalBatchReadback.ExpectedDigest(model),
            (db, transaction, token) => DataScalePhysicalBatchReadback.ObserveAsync(db, transaction,
                DataScaleBulkProvider.MySql, model, token), cancellationToken);
        Assert.Equal(DataScaleBulkCommitState.Committed, execution.State);
        DataScaleArticlePhysicalBatch observed = await ArticleScaleWriterDifferential.ObserveIsolatedRootAsync(
            connection, DataScaleBulkProvider.MySql, model, cancellationToken);
        Assert.True(ArticleScaleWriterDifferential.Compare(postgresRows, observed).PhysicalEquivalent);
        await connection.CloseAsync();
        await using DbCommand cleanup = admin.CreateCommand();
        cleanup.CommandText = $"DROP DATABASE `{database}`";
        await cleanup.ExecuteNonQueryAsync(cancellationToken);
    }

    private static async Task CreateDiagnosticTablesAsync(DbConnection connection, DataScaleBulkProvider provider,
        DataScaleArticlePhysicalBatch model)
    {
        string Quote(string name) => provider == DataScaleBulkProvider.MySql ? $"`{name}`" : $"\"{name}\"";
        foreach (DataScaleBulkTableRows table in model.Tables)
        {
            await using DbCommand create = connection.CreateCommand();
            create.CommandText = $"CREATE TABLE {Quote(table.Table)} ({string.Join(',', table.Columns.Select((column, index) =>
            {
                string type = provider == DataScaleBulkProvider.MySql ? column.Type switch
                {
                    System.Data.DbType.String => "LONGTEXT",
                    System.Data.DbType.DateTime => "DATETIME(6)",
                    _ => "BIGINT"
                } : column.Type is System.Data.DbType.String or System.Data.DbType.DateTime ? "TEXT" : "INTEGER";
                return $"{Quote(column.Name)} {type}" + (index == model.PrimaryKeyColumns[table.Table] ? " PRIMARY KEY" : "");
            }))})";
            await create.ExecuteNonQueryAsync();
        }
    }

    private static IReadOnlyDictionary<string, IReadOnlyDictionary<string, string>> ReferenceTargets(
        IReadOnlyDictionary<ArticleScaleRowKind, DataScaleEntityTransportBinding> schema)
    {
        var result = new Dictionary<string, IReadOnlyDictionary<string, string>>(StringComparer.Ordinal);
        void Bind(ArticleScaleRowKind source, params (string Property, ArticleScaleRowKind Target)[] fields)
            => result.Add(schema[source].Table, fields.ToDictionary(field => schema[source].Columns[field.Property],
                field => schema[field.Target].Table, StringComparer.Ordinal));
        // Explicit identity field dispositions. Unknown fields are still compared exactly.
        Bind(ArticleScaleRowKind.Article, ("CurrentRevisionId", ArticleScaleRowKind.ArticleRevision),
            ("CurrentPublicationId", ArticleScaleRowKind.ArticlePublication));
        foreach (ArticleScaleRowKind kind in new[] { ArticleScaleRowKind.ArticleBody, ArticleScaleRowKind.ArticleRightsPolicy })
            Bind(kind, ("ArticleId", ArticleScaleRowKind.Article));
        Bind(ArticleScaleRowKind.ArticleRevision, ("ArticleId", ArticleScaleRowKind.Article),
            ("ContentBlockId", ArticleScaleRowKind.ArticleRevisionContentBlock),
            ("RollbackSourceRevisionId", ArticleScaleRowKind.ArticleRevision));
        Bind(ArticleScaleRowKind.ArticleRightsSnapshot, ("ArticleId", ArticleScaleRowKind.Article),
            ("ArticleRevisionId", ArticleScaleRowKind.ArticleRevision), ("ArticleRightsPolicyId", ArticleScaleRowKind.ArticleRightsPolicy));
        Bind(ArticleScaleRowKind.ArticleRightsProof, ("ArticleId", ArticleScaleRowKind.Article),
            ("ArticleRevisionId", ArticleScaleRowKind.ArticleRevision), ("ArticleRightsSnapshotId", ArticleScaleRowKind.ArticleRightsSnapshot));
        Bind(ArticleScaleRowKind.ArticleResponsibilitySnapshot, ("ArticleId", ArticleScaleRowKind.Article),
            ("ArticleRevisionId", ArticleScaleRowKind.ArticleRevision), ("PreviousSnapshotId", ArticleScaleRowKind.ArticleResponsibilitySnapshot));
        Bind(ArticleScaleRowKind.ArticlePublication, ("ArticleId", ArticleScaleRowKind.Article),
            ("ArticleRevisionId", ArticleScaleRowKind.ArticleRevision), ("RightsSnapshotId", ArticleScaleRowKind.ArticleRightsSnapshot),
            ("ResponsibilitySnapshotId", ArticleScaleRowKind.ArticleResponsibilitySnapshot));
        Bind(ArticleScaleRowKind.ArticleMutationOutboxEnvelope, ("AggregateId", ArticleScaleRowKind.Article),
            ("ArticleRevisionId", ArticleScaleRowKind.ArticleRevision), ("ArticlePublicationId", ArticleScaleRowKind.ArticlePublication),
            ("RightsSnapshotId", ArticleScaleRowKind.ArticleRightsSnapshot), ("ResponsibilitySnapshotId", ArticleScaleRowKind.ArticleResponsibilitySnapshot));
        Bind(ArticleScaleRowKind.ArticleMutationOutboxEdge, ("OutboxEventId", ArticleScaleRowKind.ArticleMutationOutboxEnvelope));
        return result;
    }

    private static ArticleScaleDifferentialIdentityBindings ObservedProductionRoles(
        DataScaleArticlePhysicalBatch observed,
        ArticleScaleArticleGraph graph,
        CanonicalArticleLifecycleReceipt receipt,
        IReadOnlyDictionary<ArticleScaleRowKind, DataScaleEntityTransportBinding> schema,
        IReadOnlyDictionary<string, IReadOnlyDictionary<string, string>> references)
    {
        var maps = new Dictionary<string, IReadOnlyDictionary<long, string>>(StringComparer.Ordinal);
        foreach (DataScaleBulkTableRows table in observed.Tables)
        {
            var owner = schema.Single(item => item.Value.Table == table.Table);
            ArticleScaleRowPlan[] expected = graph.Rows.Where(row => row.Kind == owner.Key).ToArray();
            object? Field(IReadOnlyList<object?> row, string property)
                => row[table.Columns.ToList().FindIndex(column => column.Name == owner.Value.Columns[property])];
            var roles = new Dictionary<long, string>();
            foreach (IReadOnlyList<object?> row in table.Rows)
            {
                long key = Convert.ToInt64(row[observed.PrimaryKeyColumns[table.Table]]);
                ArticleScaleRowPlan? match = owner.Key switch
                {
                    ArticleScaleRowKind.Article or ArticleScaleRowKind.ArticleBody or ArticleScaleRowKind.ArticleRightsPolicy => expected.Single(),
                    ArticleScaleRowKind.ArticleRevision or ArticleScaleRowKind.ArticleRightsSnapshot
                        or ArticleScaleRowKind.ArticleRightsProof or ArticleScaleRowKind.ArticleResponsibilitySnapshot
                        => expected.SingleOrDefault(candidate => Convert.ToInt32(candidate.Fields["RevisionNo"]) == Convert.ToInt32(Field(row, "RevisionNo"))),
                    ArticleScaleRowKind.ArticlePublication => expected.SingleOrDefault(candidate =>
                        Convert.ToInt32(candidate.Fields["PublicationNo"]) == Convert.ToInt32(Field(row, "PublicationNo"))),
                    ArticleScaleRowKind.ArticleRevisionContentBlock => expected.OrderBy(candidate => candidate.SemanticId, StringComparer.Ordinal)
                        .FirstOrDefault(candidate => Equals(candidate.Fields["ContentHash"], Field(row, "ContentHash"))),
                    ArticleScaleRowKind.ArticleMutationOutboxEnvelope => expected.ElementAtOrDefault(
                        receipt.Operations.ToList().FindIndex(operation => operation.OutboxEventId == Convert.ToString(Field(row, "EventId")))),
                    ArticleScaleRowKind.ArticleMutationOutboxEdge => expected.SingleOrDefault(candidate =>
                        Equals(candidate.Fields["EdgeName"], Field(row, "EdgeName"))
                        && Equals(candidate.Fields["OutboxSemanticId"], maps[schema[ArticleScaleRowKind.ArticleMutationOutboxEnvelope].Table]
                            [Convert.ToInt64(Field(row, "OutboxEventId"))])),
                    _ => throw new InvalidOperationException("differential_row_kind_unmapped")
                };
                roles.Add(key, match?.SemanticId ?? $"unmatched-observation:{table.Table}:{key}");
            }
            maps.Add(table.Table, roles);
        }
        return new(maps, references);
    }

    private static ArticleResponsibilityDraft Responsibility(ArticleScaleArticleGraph graph)
    {
        IReadOnlyDictionary<string, object?> fields = graph.Rows.First(row =>
            row.Kind == ArticleScaleRowKind.ArticleResponsibilitySnapshot).Fields;
        var options = new JsonSerializerOptions(JsonSerializerDefaults.Web);
        return new ArticleResponsibilityDraft((bool)fields["InheritSiteAuthor"]!,
            JsonSerializer.Deserialize<ArticleResponsiblePerson[]>((string)fields["AuthorsJson"]!, options)!,
            JsonSerializer.Deserialize<ArticleResponsiblePerson>((string)fields["ReviewerJson"]!, options),
            JsonSerializer.Deserialize<ArticleEvidenceSource[]>((string)fields["SourcesJson"]!, options)!,
            (string?)fields["UpdateSummary"], (string?)fields["UpdateReason"],
            fields["EffectiveAt"] is string instant ? DateTime.Parse(instant,
                System.Globalization.CultureInfo.InvariantCulture, System.Globalization.DateTimeStyles.RoundtripKind) : null,
            (string?)fields["ConclusionImpact"], (string?)fields["Methodology"],
            (string?)fields["Applicability"], (string?)fields["Limitations"],
            (bool)fields["ResponsiblePersonConfirmed"]!, false, false, false, 1);
    }

    private static (ArticleScalePlan Plan, ArticleScaleArticleGraph Graph) Inputs(ArticleScaleVariant variant)
    {
        ArticleScaleArtifactReference Reference(string schema, string owner, string shape)
            => new(schema, $"config/testing/{owner}", shape, "sha256:" + new string('1', 64));
        // Unit artifact references, not sealed catalog/clock qualification.
        var artifacts = new ArticleScaleArtifactBindings(
            Reference(ArticleScaleContractIds.TemporalArtifactSchema, "resolved-temporal-roles", "data-scale.lifecycle"),
            Reference(ArticleScaleContractIds.FixtureVariantCatalogSchema, "fixture-variant-catalog", ArticleScaleContractIds.DistributionShape),
            [Reference(ArticleScaleContractIds.ContentShapeCatalogSchema, "content-shape-catalog", "script.zh-hans")],
            [Reference(ArticleScaleContractIds.MediaShapeCatalogSchema, "media-shape-catalog", "webp-landscape")],
            [Reference(ArticleScaleContractIds.FixtureVariantCatalogSchema, "fixture-variant-catalog", ArticleScaleContractIds.TaxonomyShape)]);
        ArticleScalePlan plan = ArticleScalePlanBuilder.Create("scale-s", "writer-differential", artifacts);
        int ordinal = plan.IdAllocation.ArticleOrdinalBase;
        foreach (ArticleScaleVariantAllocation allocation in plan.StateDistribution)
        {
            if (allocation.Variant == variant)
                break;
            ordinal += allocation.Count;
        }
        return (plan, CanonicalArticleGraphFactory.BuildArticleGraph(plan, ordinal, variant,
            ArticleScaleVariantContractCatalog.Get(variant)));
    }
}
