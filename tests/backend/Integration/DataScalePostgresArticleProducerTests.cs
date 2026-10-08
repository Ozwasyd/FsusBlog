using System.Data.Common;
using System.Diagnostics;
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

    // Diagnostic fixtures exercise this adapter, not the ordinary #2555 positive.
    // Their content/time/shape references and the existing fixture key are not an
    // authenticated assignment/content/media/temporal owner bundle or admission.
    [Theory]
    [InlineData(ArticleScaleVariant.Published)]
    [InlineData(ArticleScaleVariant.Scheduled)]
    [InlineData(ArticleScaleVariant.PublishedWithScheduledUpdate)]
    [InlineData(ArticleScaleVariant.Archived)]
    [InlineData(ArticleScaleVariant.Deleted)]
    public async Task DiagnosticResolvedHandoff_PersistsActualMapsAndPassesOriginalLiveObjects(ArticleScaleVariant variant)
    {
        var (plan, example, _) = DataScaleArticlePhysicalProjectionTests.Graph(variant);
        ArticleScaleResolvedGraphBatch resolved = DiagnosticResolved(plan, [example.ArticleOrdinal]);
        ArticleScaleArticleGraph graph = CanonicalArticleGraphFactory.BuildArticleGraph(plan, example.ArticleOrdinal,
            variant, ArticleScaleVariantContractCatalog.Get(variant), null, resolved);
        var schema = DataScaleArticlePhysicalProjectionTests.Schema();
        await using NpgsqlConnection db = await OpenAsync(schema);
        string root = Path.Combine(Path.GetTempPath(), "fsus-resolved-handoff-" + Guid.NewGuid().ToString("N"));
        try
        {
            var store = new DataScaleBatchCheckpointStore(root);
            bool consumed = await DataScalePostgresArticleProducer.ProduceAndConsumeResolvedAsync(db, plan, [graph], resolved,
                schema, DataScaleArticlePhysicalProjectionTests.Principals(plan), CurrentRun(), db.DataSource + "/" + db.Database,
                CurrentSource(), DataScaleArticleBatchAuthority.ComputeGraphDigest([graph]), s_key, store,
                async (production, originalPlan, originalResolved, live, current, key, evidence, token) =>
                {
                    Assert.Same(plan, originalPlan);
                    Assert.Same(resolved, originalResolved);
                    Assert.Same(db, live);
                    Assert.Equal(production.Authority.Identity(db, DataScaleBulkProvider.PostgreSql), current);
                    Assert.Equal(DataScaleBulkCommitState.Committed, production.Execution.Transport.State);
                    Assert.False(production.Execution.CompleteSeedAccepted);
                    await store.VerifyNativeAllocationEvidenceAsync(evidence, production.NativeAllocation, production.NativeBindings, token);
                    string address = Path.Combine(root, "native-allocation-" + evidence[7..] + ".json");
                    using JsonDocument document = JsonDocument.Parse(await File.ReadAllBytesAsync(address, token));
                    Assert.Equal(new[] { "Observations", "Bindings" }, document.RootElement.EnumerateObject().Select(item => item.Name));
                    DataScaleBatchCheckpoint persisted = await store.ReadAsync(production.Execution.Checkpoint!.Signature, current, key, token);
                    persisted.Validate(current, key.Span, DataScaleBatchCheckpointStage.Committed);
                    DataScaleArticleBatchExecution replay = await DataScaleArticleBatchWriter.WriteAsync(db, DataScaleBulkProvider.PostgreSql,
                        production.Authority, persisted, key, store.PersistAsync, token);
                    Assert.True(replay.AlreadyPresent);
                    Assert.Equal(0, replay.Transport.WriteCommands);
                    byte[] changed = await File.ReadAllBytesAsync(address, token);
                    changed[changed.Length / 2] ^= 1;
                    await File.WriteAllBytesAsync(address, changed, token);
                    await Assert.ThrowsAsync<InvalidOperationException>(() => store.VerifyNativeAllocationEvidenceAsync(evidence,
                        production.NativeAllocation, production.NativeBindings, token));
                    File.Delete(address);
                    await Assert.ThrowsAsync<FileNotFoundException>(() => store.VerifyNativeAllocationEvidenceAsync(evidence,
                        production.NativeAllocation, production.NativeBindings, token));
                    return true;
                }, CancellationToken.None);
            Assert.True(consumed);
        }
        finally
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, recursive: true);
            }
        }
    }

    [Theory]
    [InlineData("missing-resolved")]
    [InlineData("roster-mismatch")]
    [InlineData("bad-key")]
    public async Task DiagnosticResolvedHandoff_InvalidInputRefusesBeforeNativeReservation(string scenario)
    {
        var (plan, example, _) = DataScaleArticlePhysicalProjectionTests.Graph(ArticleScaleVariant.Published);
        ArticleScaleResolvedGraphBatch resolved = DiagnosticResolved(plan,
            scenario == "roster-mismatch" ? [example.ArticleOrdinal, example.ArticleOrdinal + 1] : [example.ArticleOrdinal]);
        ArticleScaleArticleGraph graph = CanonicalArticleGraphFactory.BuildArticleGraph(plan, example.ArticleOrdinal,
            example.Variant, ArticleScaleVariantContractCatalog.Get(example.Variant), null, resolved);
        var schema = DataScaleArticlePhysicalProjectionTests.Schema();
        await using NpgsqlConnection db = await OpenAsync(schema);
        string root = Path.Combine(Path.GetTempPath(), "fsus-resolved-refusal-" + Guid.NewGuid().ToString("N"));
        try
        {
            var store = new DataScaleBatchCheckpointStore(root);
            bool called = false;
            Exception? error = await Record.ExceptionAsync(() => DataScalePostgresArticleProducer.ProduceAndConsumeResolvedAsync(
                db, plan, [graph], scenario == "missing-resolved" ? null! : resolved, schema,
                DataScaleArticlePhysicalProjectionTests.Principals(plan), CurrentRun(), db.DataSource + "/" + db.Database,
                CurrentSource(), DataScaleArticleBatchAuthority.ComputeGraphDigest([graph]),
                scenario == "bad-key" ? ReadOnlyMemory<byte>.Empty : s_key, store,
                (_, _, _, _, _, _, _, _) => { called = true; return Task.FromResult(true); }, CancellationToken.None));
            if (scenario == "missing-resolved")
            {
                Assert.IsType<ArgumentNullException>(error);
            }
            else
            {
                Assert.IsType<InvalidOperationException>(error);
            }
            Assert.False(called);
            await using DbCommand sequence = db.CreateCommand();
            sequence.CommandText = "SELECT is_called FROM article_id_seq";
            Assert.Equal(false, await sequence.ExecuteScalarAsync());
            Assert.Empty(Directory.EnumerateFiles(root));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private static ArticleScaleResolvedGraphBatch DiagnosticResolved(ArticleScalePlan plan, IReadOnlyList<int> ordinals)
    {
        var inputs = new List<ArticleScaleResolvedInput>();
        int ordinal = plan.IdAllocation.ArticleOrdinalBase;
        foreach (ArticleScaleVariantAllocation allocation in plan.StateDistribution)
        {
            for (int index = 0; index < allocation.Count; index++)
            {
                inputs.Add(new(ordinal, allocation.Variant, "Diagnostic resolved title", "# Diagnostic resolved body " + ordinal,
                    "Diagnostic summary", null, 1, new[] { 1, 3 }, 1234,
                    CanonicalArticleGraphFactory.ResolveTemporalMap(ordinal, allocation.Contract), plan.Artifacts,
                    "diagnostic-only-hotness-reference"));
                ordinal++;
            }
        }
        var coverage = new ArticleScaleAssignmentCoverage(plan, "diagnostic-only-coverage",
            inputs.Select(input => new ArticleScaleOrdinalAssignment(input.ArticleOrdinal, input.Variant,
                ArticleScaleAssignmentCoverage.ComputeInputDigest(input))).ToArray());
        return new(plan, coverage, inputs.Where(input => ordinals.Contains(input.ArticleOrdinal)).ToArray());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task DiagnosticResolvedHandoff_RefusesInvalidPersistenceOrPreservesCommittedConsumerFailure(bool failConsumer)
    {
        var (plan, example, _) = DataScaleArticlePhysicalProjectionTests.Graph(ArticleScaleVariant.Published);
        ArticleScaleResolvedGraphBatch resolved = DiagnosticResolved(plan, [example.ArticleOrdinal]);
        ArticleScaleArticleGraph graph = CanonicalArticleGraphFactory.BuildArticleGraph(plan, example.ArticleOrdinal,
            example.Variant, ArticleScaleVariantContractCatalog.Get(example.Variant), null, resolved);
        var schema = DataScaleArticlePhysicalProjectionTests.Schema();
        await using NpgsqlConnection db = await OpenAsync(schema);
        string root = Path.Combine(Path.GetTempPath(), "fsus-resolved-terminal-" + Guid.NewGuid().ToString("N"));
        string target = root + "-target";
        bool called = false;
        DataScalePostgresArticleProduction? committed = null;
        try
        {
            var store = new DataScaleBatchCheckpointStore(root);
            if (!failConsumer)
            {
                Directory.Delete(root);
                Directory.CreateDirectory(target);
                Directory.CreateSymbolicLink(root, target);
            }
            Exception? error = await Record.ExceptionAsync(() => DataScalePostgresArticleProducer.ProduceAndConsumeResolvedAsync<bool>(
                db, plan, [graph], resolved, schema, DataScaleArticlePhysicalProjectionTests.Principals(plan), CurrentRun(),
                db.DataSource + "/" + db.Database, CurrentSource(), DataScaleArticleBatchAuthority.ComputeGraphDigest([graph]), s_key, store,
                (production, _, _, _, _, _, _, _) =>
                {
                    called = true;
                    committed = production;
                    throw new IOException("diagnostic consumer failure after commit");
                }, CancellationToken.None));
            Assert.Equal(failConsumer, called);
            if (failConsumer)
            {
                Assert.IsType<IOException>(error);
                Assert.Equal(DataScaleBulkCommitState.Committed, committed!.Execution.Transport.State);
                DataScaleBatchCheckpoint saved = await store.ReadAsync(committed.Execution.Checkpoint!.Signature,
                    committed.Authority.Identity(db, DataScaleBulkProvider.PostgreSql), s_key, CancellationToken.None);
                Assert.Equal(DataScaleBatchCheckpointStage.Committed, saved.Stage);
            }
            else
            {
                Assert.IsType<InvalidOperationException>(error);
                Assert.Empty(Directory.EnumerateFiles(target));
            }
            await using DbCommand rows = db.CreateCommand();
            rows.CommandText = "SELECT COUNT(*) FROM article";
            Assert.Equal(failConsumer ? 1L : 0L, await rows.ExecuteScalarAsync());
            rows.CommandText = "SELECT is_called FROM article_id_seq";
            Assert.Equal(true, await rows.ExecuteScalarAsync());
        }
        finally
        {
            if (Directory.Exists(root))
            {
                Directory.Delete(root, recursive: failConsumer);
            }
            if (Directory.Exists(target))
            {
                Directory.Delete(target, recursive: true);
            }
        }
    }

    private static string CurrentRun() => Environment.GetEnvironmentVariable("FSUSBLOG_TEST_RUN_ID") ?? "local";

    private static string CurrentSource()
    {
        using var git = new Process { StartInfo = new ProcessStartInfo("git") { RedirectStandardOutput = true, RedirectStandardError = true } };
        git.StartInfo.ArgumentList.Add("rev-parse");
        git.StartInfo.ArgumentList.Add("HEAD");
        git.Start();
        string source = git.StandardOutput.ReadToEnd().Trim();
        git.WaitForExit();
        Assert.Equal(0, git.ExitCode);
        Assert.Equal(40, source.Length);
        return source;
    }

    [Theory]
    [InlineData(ArticleScaleVariant.Published, false)]
    [InlineData(ArticleScaleVariant.Scheduled, false)]
    [InlineData(ArticleScaleVariant.PublishedWithScheduledUpdate, false)]
    [InlineData(ArticleScaleVariant.Archived, false)]
    [InlineData(ArticleScaleVariant.Deleted, false)]
    [InlineData(ArticleScaleVariant.Published, true)]
    [InlineData(ArticleScaleVariant.Scheduled, true)]
    [InlineData(ArticleScaleVariant.PublishedWithScheduledUpdate, true)]
    [InlineData(ArticleScaleVariant.Archived, true)]
    [InlineData(ArticleScaleVariant.Deleted, true)]
    public async Task NativePipeline_SealsActualSequenceIdsBeforeAtomicRowsAndSupportsOwnedReplay(ArticleScaleVariant variant, bool withTaxonomy)
    {
        var (plan, example, _) = DataScaleArticlePhysicalProjectionTests.Graph(variant);
        ArticleScaleArticleGraph diagnostic = CanonicalArticleGraphFactory.BuildArticleGraph(plan, example.ArticleOrdinal,
            variant, ArticleScaleVariantContractCatalog.Get(variant));
        var schema = DataScaleArticlePhysicalProjectionTests.Schema();
        var principals = DataScaleArticlePhysicalProjectionTests.Principals(plan);
        DataScaleArticleTaxonomySchema? taxonomy = withTaxonomy ? DataScaleArticleTaxonomyTests.TaxonomySchema() : null;
        await using NpgsqlConnection db = await OpenAsync(schema, withTaxonomy);
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
                if (taxonomy is not null)
                {
                    ((Dictionary<string, string>)taxonomy.ArticleTag.Columns)["TagId"] = "not_an_owned_column";
                    ((Dictionary<string, string>)taxonomy.Tag.Columns)["Id"] = "not_the_native_key";
                }
            }
            async Task Checkpoint(DataScaleBatchCheckpoint checkpoint, CancellationToken token)
            {
                Assert.True(allocationSaved);
                await store.PersistAsync(checkpoint, token);
            }
            DataScalePostgresArticleProduction produced = await DataScalePostgresArticleProducer.ProduceAsync(db, plan, [diagnostic],
                schema, principals, "component-native-run", "component-native-runtime",
                new string('a', 40), "canonical-component-batch", s_key, Allocation, Checkpoint, CancellationToken.None, taxonomySchema: taxonomy);
            Assert.Equal(DataScaleBulkCommitState.Committed, produced.Execution.Transport.State);
            Assert.True(produced.Execution.CleanupEligible);
            Assert.False(produced.Execution.CompleteSeedAccepted);
            if (withTaxonomy)
            {
                await using DbCommand links = db.CreateCommand();
                links.CommandText = "SELECT COUNT(*) FROM article_tag";
                Assert.Equal(2L, await links.ExecuteScalarAsync());
                Assert.DoesNotContain(produced.Authority.Batch.LogicalReferences,
                    row => row.Kind == ArticleScaleRowKind.ArticleTaxonomyReference);
            }
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

    private async Task<NpgsqlConnection> OpenAsync(IReadOnlyDictionary<ArticleScaleRowKind, DataScaleEntityTransportBinding> schema,
        bool withTaxonomy = false)
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
            if (withTaxonomy)
            {
                await using DbCommand domain = db.CreateCommand();
                domain.CommandText = "CREATE TABLE category(id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,name text,description text);"
                    + "CREATE TABLE tag(id integer GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,name text,description text);"
                    + "INSERT INTO category(name) SELECT 'category-'||n FROM generate_series(1,5) n;"
                    + "INSERT INTO tag(name) SELECT 'tag-'||n FROM generate_series(1,10) n;"
                    + "CREATE TABLE article_tag(article_id integer NOT NULL REFERENCES article(id),"
                    + "tag_id integer NOT NULL REFERENCES tag(id),PRIMARY KEY(article_id,tag_id));"
                    + "ALTER TABLE article ADD FOREIGN KEY(\"" + schema[ArticleScaleRowKind.Article].Columns["CategoryId"]
                    + "\") REFERENCES category(id)";
                await domain.ExecuteNonQueryAsync();
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
