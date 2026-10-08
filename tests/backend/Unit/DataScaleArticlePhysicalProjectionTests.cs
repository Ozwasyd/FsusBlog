using System.Reflection;
using System.Data.Common;

using Microsoft.Data.Sqlite;

using SqlSugar;

using FsusBlog.Server.Services.Fixtures.DataScale;

namespace FsusBlog.Server.Tests.Unit;

public sealed class DataScaleArticlePhysicalProjectionTests
{
    [Theory]
    [InlineData(ArticleScaleVariant.Published)]
    [InlineData(ArticleScaleVariant.Scheduled)]
    [InlineData(ArticleScaleVariant.PublishedWithScheduledUpdate)]
    [InlineData(ArticleScaleVariant.Archived)]
    [InlineData(ArticleScaleVariant.Deleted)]
    public async Task CanonicalBoundColumns_WriteAndReadExactlyWithImmediateCycleConstraints(ArticleScaleVariant variant)
    {
        var (plan, graph, identities) = Graph(variant);
        var schema = Schema();
        DataScaleArticlePhysicalBatch batch = DataScaleArticlePhysicalProjection.Compile(plan, [graph], identities, schema, Principals(plan));
        DataScaleArticlePhysicalWritePlan writes = DataScaleArticlePhysicalProjection.PrepareWrites(batch);
        await using var connection = new SqliteConnection("Data Source=:memory:");
        await connection.OpenAsync();
        await using (DbCommand pragma = connection.CreateCommand())
        {
            pragma.CommandText = "PRAGMA foreign_keys=ON";
            await pragma.ExecuteNonQueryAsync();
        }
        // Isolated unit schema: real native constraints/values, not prepared product schema
        // admission or production allocator provenance. External fixture roles stay diagnostic.
        foreach (var model in DataScaleArticlePhysicalProjection.EntityModels)
        {
            var properties = model.Entity.GetProperties().Where(property => property.GetCustomAttribute<SugarColumn>()?.IsIgnore != true)
                .ToDictionary(property => schema[model.Kind].Columns[property.Name]);
            string tableName = schema[model.Kind].Table;
            string[] definitions = properties.Select(pair =>
            {
                Type propertyType = Nullable.GetUnderlyingType(pair.Value.PropertyType) ?? pair.Value.PropertyType;
                string type = propertyType.IsEnum || propertyType == typeof(int) || propertyType == typeof(long) || propertyType == typeof(bool) ? "INTEGER" : "TEXT";
                SugarColumn? column = pair.Value.GetCustomAttribute<SugarColumn>();
                string nullable = column?.IsNullable == true ? "" : " NOT NULL";
                return $"\"{pair.Key}\" {type}{nullable}" + (column?.IsPrimaryKey == true ? " PRIMARY KEY" : "");
            }).ToArray();
            var constraints = new List<string>();
            void Foreign(string property, ArticleScaleRowKind target)
            {
                DataScaleEntityTransportBinding destination = schema[target];
                constraints.Add($"FOREIGN KEY(\"{schema[model.Kind].Columns[property]}\") REFERENCES \"{destination.Table}\"(\"{destination.Columns["Id"]}\")");
            }
            if (model.Kind == ArticleScaleRowKind.Article)
            {
                Foreign("CurrentRevisionId", ArticleScaleRowKind.ArticleRevision);
                Foreign("CurrentPublicationId", ArticleScaleRowKind.ArticlePublication);
            }
            else if (model.Kind != ArticleScaleRowKind.ArticleRevisionContentBlock
                && model.Kind != ArticleScaleRowKind.ArticleMutationOutboxEdge)
            {
                Foreign(model.Kind == ArticleScaleRowKind.ArticleMutationOutboxEnvelope ? "AggregateId" : "ArticleId", ArticleScaleRowKind.Article);
            }
            if (model.Kind == ArticleScaleRowKind.ArticleRevision)
                Foreign("ContentBlockId", ArticleScaleRowKind.ArticleRevisionContentBlock);
            if (model.Kind == ArticleScaleRowKind.ArticleResponsibilitySnapshot)
                Foreign("PreviousSnapshotId", ArticleScaleRowKind.ArticleResponsibilitySnapshot);
            if (model.Kind == ArticleScaleRowKind.ArticlePublication)
            {
                Foreign("ArticleRevisionId", ArticleScaleRowKind.ArticleRevision);
                Foreign("RightsSnapshotId", ArticleScaleRowKind.ArticleRightsSnapshot);
                Foreign("ResponsibilitySnapshotId", ArticleScaleRowKind.ArticleResponsibilitySnapshot);
            }
            if (model.Kind == ArticleScaleRowKind.ArticleMutationOutboxEdge)
                Foreign("OutboxEventId", ArticleScaleRowKind.ArticleMutationOutboxEnvelope);
            await using DbCommand create = connection.CreateCommand();
            create.CommandText = $"CREATE TABLE \"{tableName}\" ({string.Join(',', definitions.Concat(constraints))})";
            await create.ExecuteNonQueryAsync();
        }
        string expected = DataScalePhysicalBatchReadback.ExpectedDigest(batch);
        DataScaleBulkExecution result = await DataScaleProviderBulkTransport.ExecuteAtomicBatchAsync(
            connection, DataScaleBulkProvider.Sqlite, writes.Inserts, writes.DeferredUpdates, expected,
            (db, transaction, token) => DataScalePhysicalBatchReadback.ObserveAsync(db, transaction, DataScaleBulkProvider.Sqlite, batch, token),
            CancellationToken.None);
        Assert.Equal(DataScaleBulkCommitState.Committed, result.State);
        Assert.Equal(expected, result.SemanticDigest);
        await using DbCommand foreignKeys = connection.CreateCommand();
        foreignKeys.CommandText = "PRAGMA foreign_key_check";
        await using DbDataReader reader = await foreignKeys.ExecuteReaderAsync();
        Assert.False(await reader.ReadAsync());
        Assert.Equal(graph.Rows.Single(row => row.Kind == ArticleScaleRowKind.Article).Fields["CurrentRevisionId"],
            batch.Tables.Single(table => table.Table == schema[ArticleScaleRowKind.Article].Table).Rows[0][
                batch.Tables.Single(table => table.Table == schema[ArticleScaleRowKind.Article].Table).Columns.ToList().FindIndex(column => column.Name == schema[ArticleScaleRowKind.Article].Columns["CurrentRevisionId"])]);
    }

    [Theory]
    [InlineData(ArticleScaleVariant.Published)]
    [InlineData(ArticleScaleVariant.Scheduled)]
    [InlineData(ArticleScaleVariant.PublishedWithScheduledUpdate)]
    [InlineData(ArticleScaleVariant.Archived)]
    [InlineData(ArticleScaleVariant.Deleted)]
    public void BoundRows_ProjectEveryPersistedFieldWithoutProviderBusinessDefaults(ArticleScaleVariant variant)
    {
        var (plan, graph, identities) = Graph(variant);
        var schema = Schema();
        DataScaleArticlePhysicalBatch compiled = DataScaleArticlePhysicalProjection.Compile(
            plan, [graph], identities, schema, Principals(plan));
        Assert.Equal(graph.Rows.Count, compiled.LogicalRowCounts.Values.Sum());
        Assert.Equal(graph.Rows.Count(row => row.Kind is ArticleScaleRowKind.ArticleTaxonomyReference or ArticleScaleRowKind.ArticleAuditCoordinate),
            compiled.LogicalReferences.Count);
        foreach (DataScaleBulkTableRows table in compiled.Tables)
        {
            var (kind, binding) = schema.Single(pair => pair.Value.Table == table.Table);
            Assert.Equal(binding.Columns.Count, table.Columns.Count);
            Assert.All(table.Rows, row => Assert.Equal(table.Columns.Count, row.Count));
            if (kind == ArticleScaleRowKind.ArticleRevisionContentBlock)
            {
                Assert.Single(table.Rows);
            }
        }
        DataScaleBulkTableRows revisions = compiled.Tables.Single(table => table.Table == schema[ArticleScaleRowKind.ArticleRevision].Table);
        int creatorColumn = revisions.Columns.ToList().FindIndex(column => column.Name == schema[ArticleScaleRowKind.ArticleRevision].Columns["CreatedByAdminPrincipalId"]);
        Assert.All(revisions.Rows, row => Assert.Equal(9701L, row[creatorColumn]));
        Assert.DoesNotContain(compiled.Tables.SelectMany(table => table.Rows).SelectMany(row => row), value => value is DateTime time && time.Kind != DateTimeKind.Utc);
    }

    [Fact]
    public void MissingExternalIdentitySchemaDriftAndUnboundGraph_FailBeforeTransport()
    {
        var (plan, graph, identities) = Graph(ArticleScaleVariant.Published);
        Assert.Throws<InvalidOperationException>(() => DataScaleArticlePhysicalProjection.Compile(plan, [graph], identities, Schema(), new Dictionary<string, long>()));
        var schema = Schema();
        var columns = new Dictionary<string, string>(schema[ArticleScaleRowKind.Article].Columns);
        columns.Remove("Title");
        schema[ArticleScaleRowKind.Article] = schema[ArticleScaleRowKind.Article] with
        {
            Columns = columns
        };
        Assert.Throws<InvalidOperationException>(() => DataScaleArticlePhysicalProjection.Compile(plan, [graph], identities, schema, Principals(plan)));
        schema = Schema();
        schema[ArticleScaleRowKind.Article] = schema[ArticleScaleRowKind.Article] with
        {
            Table = "nonowned_article"
        };
        Assert.Throws<InvalidOperationException>(() => DataScaleArticlePhysicalProjection.Compile(plan, [graph], identities, schema, Principals(plan)));
        ArticleScaleArticleGraph unbound = CanonicalArticleGraphFactory.BuildArticleGraph(plan, graph.ArticleOrdinal, graph.Variant, ArticleScaleVariantContractCatalog.Get(graph.Variant));
        Assert.Throws<InvalidOperationException>(() => DataScaleArticlePhysicalProjection.Compile(plan, [unbound], identities, Schema(), Principals(plan)));
    }

    [Fact]
    public void GraphOutsidePlanVariantAllocation_IsRejected()
    {
        var (plan, _, _) = Graph(ArticleScaleVariant.Published);
        ArticleScaleArticleGraph other = CanonicalArticleGraphFactory.BuildArticleGraph(plan, 1, ArticleScaleVariant.Deleted, ArticleScaleVariantContractCatalog.Get(ArticleScaleVariant.Deleted));
        Dictionary<string, long> ids = Ids(other);
        var binding = new ArticleScaleGraphIdentityBindings(ArticleScalePlanDigest.Compute(plan), other.SemanticArticleId, ids);
        other = CanonicalArticleGraphFactory.BuildArticleGraph(plan, 1, other.Variant, ArticleScaleVariantContractCatalog.Get(other.Variant), binding);
        Assert.Throws<InvalidOperationException>(() => DataScaleArticlePhysicalProjection.Compile(plan, [other],
            new Dictionary<string, ArticleScaleGraphIdentityBindings> { [other.SemanticArticleId] = binding }, Schema(), Principals(plan)));
    }

    private static (ArticleScalePlan Plan, ArticleScaleArticleGraph Graph, Dictionary<string, ArticleScaleGraphIdentityBindings> Identities) Graph(ArticleScaleVariant variant)
    {
        ArticleScaleArtifactReference Reference(string schema, string owner, string shape)
            => new(schema, $"config/testing/{owner}", shape, "sha256:" + new string('1', 64));
        // Pure unit references, not materialized artifact or native allocator evidence.
        var artifacts = new ArticleScaleArtifactBindings(
            Reference(ArticleScaleContractIds.TemporalArtifactSchema, "resolved-temporal-roles", "data-scale.lifecycle"),
            Reference(ArticleScaleContractIds.FixtureVariantCatalogSchema, "fixture-variant-catalog", ArticleScaleContractIds.DistributionShape),
            [Reference(ArticleScaleContractIds.ContentShapeCatalogSchema, "content-shape-catalog", "script.zh-hans")],
            [Reference(ArticleScaleContractIds.MediaShapeCatalogSchema, "media-shape-catalog", "webp-landscape")],
            [Reference(ArticleScaleContractIds.FixtureVariantCatalogSchema, "fixture-variant-catalog", ArticleScaleContractIds.TaxonomyShape)]);
        ArticleScalePlan plan = ArticleScalePlanBuilder.Create("scale-s", "physical-unit", artifacts);
        int ordinal = plan.IdAllocation.ArticleOrdinalBase;
        foreach (ArticleScaleVariantAllocation allocation in plan.StateDistribution)
        {
            if (allocation.Variant == variant)
                break;
            ordinal += allocation.Count;
        }
        ArticleScaleArticleGraph diagnostic = CanonicalArticleGraphFactory.BuildArticleGraph(plan, ordinal, variant, ArticleScaleVariantContractCatalog.Get(variant));
        var binding = new ArticleScaleGraphIdentityBindings(ArticleScalePlanDigest.Compute(plan), diagnostic.SemanticArticleId, Ids(diagnostic));
        ArticleScaleArticleGraph graph = CanonicalArticleGraphFactory.BuildArticleGraph(plan, ordinal, variant, ArticleScaleVariantContractCatalog.Get(variant), binding);
        return (plan, graph, new Dictionary<string, ArticleScaleGraphIdentityBindings> { [graph.SemanticArticleId] = binding });
    }

    private static Dictionary<string, long> Ids(ArticleScaleArticleGraph graph)
    {
        var ids = graph.Rows.Where(row => row.Kind is not (ArticleScaleRowKind.ArticleBody or ArticleScaleRowKind.ArticleTaxonomyReference or ArticleScaleRowKind.ArticleAuditCoordinate))
            .Select((row, index) => (row.SemanticId, Id: 701L + index)).ToDictionary(pair => pair.SemanticId, pair => pair.Id);
        foreach (var group in graph.Rows.Where(row => row.Kind == ArticleScaleRowKind.ArticleRevisionContentBlock).GroupBy(row => row.Fields["ContentHash"]))
        {
            foreach (ArticleScaleRowPlan alias in group.Skip(1))
                ids[alias.SemanticId] = ids[group.First().SemanticId];
        }
        return ids;
    }

    private static Dictionary<string, long> Principals(ArticleScalePlan plan)
        => new()
        {
            [$"{plan.IdAllocation.NamespacePrefix}:principal/authoring-admin"] = 9701
        };

    private static Dictionary<ArticleScaleRowKind, DataScaleEntityTransportBinding> Schema()
        => DataScaleArticlePhysicalProjection.EntityModels.ToDictionary(model => model.Kind, model =>
        {
            string table = (string)model.Entity.GetCustomAttributesData().Single(attribute => attribute.AttributeType == typeof(SugarTable)).ConstructorArguments[0].Value!;
            var columns = model.Entity.GetProperties().Where(property => property.GetCustomAttribute<SugarColumn>()?.IsIgnore != true)
                .ToDictionary(property => property.Name, property => property.GetCustomAttribute<SugarColumn>()?.ColumnName ?? property.Name);
            return new DataScaleEntityTransportBinding(table, columns);
        });
}
