using System.Data.Common;
using System.Reflection;
using System.Security.Cryptography;
using System.Text.Json;

using FsusBlog.Server.Services.Fixtures.DataScale;
using FsusBlog.Server.Tests.Unit;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

/// <summary>Real PostgreSQL component sequences and transactions; the small model schema is not a qualified seed lane.</summary>
[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class DataScalePostgresArticleProducerTests(PostgresSchemaMigrationFixture fixture)
{
    private static readonly byte[] s_key = SHA256.HashData("isolated-native-producer-component-key"u8);

    [Theory]
    [InlineData(ArticleScaleVariant.Published)]
    [InlineData(ArticleScaleVariant.Scheduled)]
    [InlineData(ArticleScaleVariant.PublishedWithScheduledUpdate)]
    [InlineData(ArticleScaleVariant.Archived)]
    [InlineData(ArticleScaleVariant.Deleted)]
    public async Task NativePipeline_SealsActualSequenceIdsBeforeAtomicRowsAndSupportsOwnedReplay(ArticleScaleVariant variant)
    {
        var (plan, example, _) = DataScaleArticlePhysicalProjectionTests.Graph(variant);
        ArticleScaleArticleGraph diagnostic = CanonicalArticleGraphFactory.BuildArticleGraph(plan, example.ArticleOrdinal,
            variant, ArticleScaleVariantContractCatalog.Get(variant));
        var schema = DataScaleArticlePhysicalProjectionTests.Schema();
        var principals = DataScaleArticlePhysicalProjectionTests.Principals(plan);
        await using NpgsqlConnection db = await OpenAsync(schema);
        string root = Path.Combine(Path.GetTempPath(), "fsus-native-batch-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(root);
        try
        {
            var store = new DataScaleBatchCheckpointStore(root);
            bool allocationSaved = false;
            async Task Allocation(IReadOnlyList<DataScaleNativeIdentityObservation> observations,
                IReadOnlyDictionary<string, ArticleScaleGraphIdentityBindings> bindings, CancellationToken token)
            {
                await using DbCommand count = db.CreateCommand();
                count.CommandText = "SELECT COUNT(*) FROM article";
                Assert.Equal(0L, await count.ExecuteScalarAsync(token));
                byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(new
                {
                    Observations = observations,
                    Bindings = bindings
                });
                await using (var file = new FileStream(Path.Combine(root, "native-allocation.json"), FileMode.CreateNew))
                {
                    await file.WriteAsync(bytes, token);
                    file.Flush(flushToDisk: true);
                }
                allocationSaved = true;
                // Caller mutation after the awaited native allocation must not change product inputs.
                ((Dictionary<string, string>)schema[ArticleScaleRowKind.Article].Columns)["Title"] = "not_an_owned_column";
                principals[$"{plan.IdAllocation.NamespacePrefix}:principal/authoring-admin"] = 111111;
            }
            async Task Checkpoint(DataScaleBatchCheckpoint checkpoint, CancellationToken token)
            {
                Assert.True(allocationSaved);
                await store.PersistAsync(checkpoint, token);
            }
            DataScalePostgresArticleProduction produced = await DataScalePostgresArticleProducer.ProduceAsync(db, plan, [diagnostic],
                schema, principals, "component-native-run", "component-native-runtime",
                new string('a', 40), "canonical-component-batch", s_key, Allocation, Checkpoint, CancellationToken.None);
            Assert.Equal(DataScaleBulkCommitState.Committed, produced.Execution.Transport.State);
            Assert.True(produced.Execution.CleanupEligible);
            Assert.False(produced.Execution.CompleteSeedAccepted);
            Assert.All(produced.NativeAllocation, observation => Assert.NotEmpty(observation.OwnedSequence));
            Assert.All(produced.NativeBindings.Values.SelectMany(binding => binding.Ids.Values), id => Assert.True(id > 0));
            ArticleScaleArticleGraph graph = Assert.Single(produced.Graphs);
            CanonicalArticleGraphVerifier.VerifyArticleGraph(plan, graph).ThrowIfInvalid();
            Assert.Equal(1L, produced.NativeBindings[graph.SemanticArticleId].Resolve(graph.SemanticArticleId));
            await using (DbCommand creator = db.CreateCommand())
            {
                creator.CommandText = "SELECT created_by_admin_principal_id FROM article_revision LIMIT 1";
                Assert.Equal(9701L, await creator.ExecuteScalarAsync());
            }
            DataScaleBatchCheckpoint current = await store.ReadAsync(produced.Execution.Checkpoint!.Signature,
                produced.Authority.Identity(db, DataScaleBulkProvider.PostgreSql), s_key, CancellationToken.None);
            DataScaleArticleBatchExecution replay = await DataScaleArticleBatchWriter.WriteAsync(db, DataScaleBulkProvider.PostgreSql,
                produced.Authority, current, s_key, store.PersistAsync, CancellationToken.None);
            Assert.True(replay.AlreadyPresent);
            Assert.Equal(0, replay.Transport.WriteCommands);
            await using DbTransaction transaction = await db.BeginTransactionAsync();
            Assert.Equal(DataScalePhysicalRecoveryState.Exact, (await DataScaleArticleBatchWriter.ValidateCleanupAsync(db, transaction,
                DataScaleBulkProvider.PostgreSql, produced.Authority, current, s_key, CancellationToken.None)).State);
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public async Task NativeAllocationReceiptFailure_WritesNoProductRowsAndDoesNotUndoSequenceFacts()
    {
        var (plan, example, _) = DataScaleArticlePhysicalProjectionTests.Graph(ArticleScaleVariant.Published);
        var diagnostic = CanonicalArticleGraphFactory.BuildArticleGraph(plan, example.ArticleOrdinal, example.Variant,
            ArticleScaleVariantContractCatalog.Get(example.Variant));
        var schema = DataScaleArticlePhysicalProjectionTests.Schema();
        await using NpgsqlConnection db = await OpenAsync(schema);
        await Assert.ThrowsAsync<IOException>(() => DataScalePostgresArticleProducer.ProduceAsync(db, plan, [diagnostic], schema,
            DataScaleArticlePhysicalProjectionTests.Principals(plan), "component-run", "component-runtime", new string('a', 40),
            "canonical-batch", s_key, (_, _, _) => Task.FromException(new IOException("injected native receipt failure")),
            (_, _) => throw new InvalidOperationException("must not write product checkpoint"), CancellationToken.None));
        foreach (DataScaleEntityTransportBinding binding in schema.Values)
        {
            await using DbCommand count = db.CreateCommand();
            count.CommandText = "SELECT COUNT(*) FROM \"" + binding.Table + "\"";
            Assert.Equal(0L, await count.ExecuteScalarAsync());
        }
        await using DbCommand sequence = db.CreateCommand();
        sequence.CommandText = "SELECT is_called FROM article_id_seq";
        Assert.Equal(true, await sequence.ExecuteScalarAsync());
    }

    [Fact]
    public async Task MissingOwnedSequenceInLaterTable_RefusesBeforeFirstNativeReservation()
    {
        string database = await fixture.CreateDatabaseAsync();
        await using var db = new NpgsqlConnection(fixture.BuildDatabaseConnectionString(database));
        await db.OpenAsync();
        await using (DbCommand schema = db.CreateCommand())
        {
            schema.CommandText = "CREATE TABLE admitted_identity(id bigint GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY);"
                + "CREATE TABLE snowflake_comment(id bigint PRIMARY KEY)";
            await schema.ExecuteNonQueryAsync();
        }
        await using DbTransaction transaction = await db.BeginTransactionAsync();
        var requests = new DataScaleNativeIdentityTableRequest[]
        {
            new("admitted_identity", new("id", System.Data.DbType.Int64), [new("article-role", ["article-role"])]),
            new("snowflake_comment", new("id", System.Data.DbType.Int64), [new("comment-role", ["comment-role"])])
        };
        await Assert.ThrowsAsync<InvalidOperationException>(() => DataScalePostgresIdentityReservation.ReserveAsync(db,
            transaction, requests, CancellationToken.None));
        await transaction.RollbackAsync();
        await using DbCommand untouched = db.CreateCommand();
        untouched.CommandText = "SELECT is_called FROM admitted_identity_id_seq";
        Assert.Equal(false, await untouched.ExecuteScalarAsync());
    }

    private async Task<NpgsqlConnection> OpenAsync(IReadOnlyDictionary<ArticleScaleRowKind, DataScaleEntityTransportBinding> schema)
    {
        string database = await fixture.CreateDatabaseAsync();
        var db = new NpgsqlConnection(fixture.BuildDatabaseConnectionString(database));
        try
        {
            await db.OpenAsync();
            foreach (var model in DataScaleArticlePhysicalProjection.EntityModels)
            {
                var definitions = model.Entity.GetProperties().Where(property => property.GetCustomAttribute<SugarColumn>()?.IsIgnore != true)
                    .Select(property =>
                    {
                        Type type = Nullable.GetUnderlyingType(property.PropertyType) ?? property.PropertyType;
                        SugarColumn? column = property.GetCustomAttribute<SugarColumn>();
                        string sqlType = type == typeof(int) || type.IsEnum ? "integer" : type == typeof(long) ? "bigint"
                            : type == typeof(bool) ? "boolean" : type == typeof(DateTime) ? "timestamp(6) with time zone" : "text";
                        return "\"" + schema[model.Kind].Columns[property.Name] + "\" " + sqlType
                            + (column?.IsIdentity == true ? " GENERATED BY DEFAULT AS IDENTITY" : "")
                            + (column?.IsNullable == true ? "" : " NOT NULL")
                            + (column?.IsPrimaryKey == true ? " PRIMARY KEY" : "");
                    });
                await using DbCommand create = db.CreateCommand();
                create.CommandText = "CREATE TABLE \"" + schema[model.Kind].Table + "\"(" + string.Join(',', definitions) + ")";
                await create.ExecuteNonQueryAsync();
            }
            // Immediate cycle constraints are exercised by the actual shared deferred-write transport.
            await using DbCommand constraints = db.CreateCommand();
            constraints.CommandText = "ALTER TABLE article ADD FOREIGN KEY(current_revision_id) REFERENCES article_revision(id),"
                + "ADD FOREIGN KEY(current_publication_id) REFERENCES article_publication(id);"
                + "ALTER TABLE article_revision ADD FOREIGN KEY(content_block_id) REFERENCES article_revision_content_block(id);"
                + "ALTER TABLE article_responsibility_snapshot ADD FOREIGN KEY(previous_snapshot_id) REFERENCES article_responsibility_snapshot(id)";
            await constraints.ExecuteNonQueryAsync();
            return db;
        }
        catch
        {
            await db.DisposeAsync();
            throw;
        }
    }
}
