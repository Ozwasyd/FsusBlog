using System.Data;
using System.Globalization;
using System.Text.RegularExpressions;

using FsusBlog.Contracts.Schema;
using FsusBlog.Migration;
using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Algorithms.Schema;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Tests;

public sealed class CurrentSchemaRuntimeRollupTablesTests
{
    [Fact]
    public void RuntimeRollupCatalog_MatchesPostCodeFirstMigrationDdl()
    {
        ISchemaMigrationDescriptor[] descriptors =
        [
            SecurityAndProjectionMigrationDefinitions.BuildVisitLogStatsRollupMigration(),
            AuthoringAndIntegrityMigrationDefinitions.BuildAuthorAnalyticsRollupMigration(),
            LegacyIdentityMigrationDefinitions.BuildPublicArticleProjectionMigration(),
            AuthoringAndIntegrityMigrationDefinitions.BuildActiveReleaseFenceDurableWitnessMigration(),
            AuthoringAndIntegrityMigrationDefinitions.BuildActiveReleaseFencedCommitLedgerMigration(),
            PluginRegistryMigrationDefinitions.BuildMigration(),
            ThemeRegistryMigrationDefinitions.BuildMigration(),
            ThemeActivationRuntimeMigrationDefinitions.BuildMigration(),
            CustomizationMigrationDefinitions.BuildMigration(),
            AuthoringCanvasDocumentMigrationDefinitions.BuildMigration(),
            AuthorArticlePinMigrationDefinitions.BuildMigration(),
            AuthorSavedViewMigrationDefinitions.BuildMigration(),
            ArticleTemplateAuthorityMigrationDefinitions.BuildMigration(),
            ArticleCreateAuthorityMigrationDefinitions.BuildMigration(),
            AuthorRecentArticleHistoryMigrationDefinitions.BuildMigration(),
            ArticlePropertyDefinitionAuthorityMigrationDefinitions.BuildMigration(),
            ArticlePropertyDefinitionCommandHistoryMigrationDefinitions.BuildMigration(),
            TaxonomyMutationReceiptMigrationDefinitions.BuildMigration(),
            UserLocaleMutationReceiptMigrationDefinitions.BuildMigration()
        ];
        var expectedTables = new Dictionary<string, string>(StringComparer.Ordinal);
        var tableMigration = new Dictionary<string, string>(StringComparer.Ordinal);
        var expectedExtras = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (ISchemaMigrationDescriptor descriptor in descriptors)
        {
            foreach ((string tableName, string sql, bool isTable) in ExtractStatements(descriptor))
            {
                if (isTable)
                {
                    Assert.False(
                        expectedTables.ContainsKey(tableName),
                        $"duplicate CREATE TABLE for {tableName}");
                    expectedTables[tableName] = sql;
                    tableMigration[tableName] = descriptor.MigrationId;
                }
                else
                {
                    if (!expectedExtras.TryGetValue(descriptor.MigrationId, out List<string>? extras))
                    {
                        expectedExtras[descriptor.MigrationId] = extras = [];
                    }
                    extras.Add(sql);
                }
            }
        }

        Assert.Equal(
            expectedTables.Keys.Order(StringComparer.Ordinal),
            CurrentSchemaRuntimeRollupTables.TableNames.Order(StringComparer.Ordinal));
        var actualExtras = new Dictionary<string, List<string>>(StringComparer.Ordinal);
        foreach (CurrentSchemaRuntimeRollupTable table in CurrentSchemaRuntimeRollupTables.Tables)
        {
            Assert.Equal(expectedTables[table.TableName], table.CreateSql);
            string migrationId = tableMigration[table.TableName];
            if (!actualExtras.TryGetValue(migrationId, out List<string>? extras))
            {
                actualExtras[migrationId] = extras = [];
            }
            if (table.AdditionalSql is { } additional)
            {
                extras.AddRange(additional);
            }
        }
        foreach ((string migrationId, List<string> expected) in expectedExtras)
        {
            Assert.Equal(
                expected.Order(StringComparer.Ordinal),
                (actualExtras.TryGetValue(migrationId, out List<string>? actual) ? actual : [])
                    .Order(StringComparer.Ordinal));
        }
    }

    private static IEnumerable<(string TableName, string Sql, bool IsTable)> ExtractStatements(
        ISchemaMigrationDescriptor descriptor)
    {
        string? firstTable = null;
        var pendingExtras = new List<string>();
        foreach (SchemaMigrationStep step in descriptor.Steps)
        {
            switch (step)
            {
                case EnsureTableStep ensureTable:
                    firstTable ??= ensureTable.TableName;
                    yield return (ensureTable.TableName, ensureTable.CreateSql, true);
                    break;
                case CreateIndexStep createIndex:
                    pendingExtras.Add(createIndex.CreateSql);
                    break;
                case RawSqlStep raw:
                    foreach (string statement in SplitStatements(raw.Sql))
                    {
                        if (Regex.Match(statement, @"CREATE TABLE IF NOT EXISTS (\w+)") is { Success: true } tableMatch)
                        {
                            firstTable ??= tableMatch.Groups[1].Value;
                            yield return (tableMatch.Groups[1].Value, statement, true);
                        }
                        else
                        {
                            pendingExtras.Add(statement);
                        }
                    }
                    break;
                case EnsureColumnStep ensureColumn:
                    pendingExtras.Add(
                        $"ALTER TABLE {ensureColumn.TableName} ADD COLUMN IF NOT EXISTS {ensureColumn.ColumnName} {ensureColumn.ColumnDefinition};");
                    break;
            }
        }
        Assert.NotNull(firstTable);
        foreach (string extra in pendingExtras)
        {
            yield return (firstTable, extra, false);
        }
    }

    private static IEnumerable<string> SplitStatements(string sql)
    {
        var current = new List<string>();
        bool inDollarBody = false;
        foreach (string line in sql.Split('\n'))
        {
            current.Add(line);
            if (Regex.Matches(line, @"\$\$").Count % 2 == 1)
            {
                inDollarBody = !inDollarBody;
            }
            if (line.TrimEnd().EndsWith(';') && !inDollarBody)
            {
                yield return string.Join('\n', current).Trim('\n');
                current.Clear();
            }
        }
        string rest = string.Join('\n', current).Trim('\n');
        if (rest.Length > 0)
        {
            yield return rest;
        }
    }

    [Fact]
    public void RuntimeRollupCatalog_CoversStatsEndpointTables()
    {
        Assert.Contains("daily_read_stats", CurrentSchemaRuntimeRollupTables.TableNames, StringComparer.Ordinal);
        Assert.Contains("region_read_stats", CurrentSchemaRuntimeRollupTables.TableNames, StringComparer.Ordinal);
        Assert.Contains("event_type_read_stats", CurrentSchemaRuntimeRollupTables.TableNames, StringComparer.Ordinal);
        Assert.Contains("author_daily_read_stats", CurrentSchemaRuntimeRollupTables.TableNames, StringComparer.Ordinal);
    }

    [Fact]
    public void RuntimeRollupCatalog_RequiresHistoryBeforeCommandAndKeepsOriginalReceiptOwner()
    {
        string[] names = [.. CurrentSchemaRuntimeRollupTables.TableNames];
        int owner = Array.IndexOf(names, "article_property_definition_owner");
        int receipt = Array.IndexOf(names, "article_property_definition_receipt");
        int history = Array.IndexOf(names, "article_property_definition_history");
        int command = Array.IndexOf(names, "article_property_definition_command");

        Assert.True(owner >= 0 && receipt >= 0);
        Assert.True(history > owner && history > receipt);
        Assert.True(command > history);
        CurrentSchemaRuntimeRollupTable commandTable = Assert.Single(
            CurrentSchemaRuntimeRollupTables.Tables,
            table => table.TableName == "article_property_definition_command");
        Assert.Contains("REFERENCES article_property_definition_history(owner_user_id, site_scope)", commandTable.CreateSql, StringComparison.Ordinal);
        Assert.Contains("REFERENCES article_property_definition_receipt(receipt_id)", commandTable.CreateSql, StringComparison.Ordinal);
        Assert.DoesNotContain("INSERT", commandTable.CreateSql, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("UPDATE", commandTable.CreateSql, StringComparison.OrdinalIgnoreCase);
    }
}

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class CurrentSchemaRuntimeRollupTablesDatabaseTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task CompleteRuntimeObserver_BorrowsActualCallerRrButCannotAdmitOrOwnItsTerminal()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        var inspector = new SchemaModelInspector();
        PostgresSqlSugarTestClient.InitTables(db, inspector.GetManagedEntityTypes().ToArray());
        await CurrentSchemaRuntimeRollupTables.ApplyEnsureTableStepsAsync(db, CancellationToken.None);
        await db.Ado.BeginTranAsync(IsolationLevel.RepeatableRead);
        System.Data.IDbTransaction callerTransaction = db.Ado.Transaction;
        try
        {
            await PgCurrentSchemaControlShape.EnsureApplyJournalAsync(
                (System.Data.Common.DbConnection)db.Ado.Connection,
                (System.Data.Common.DbTransaction)callerTransaction, CancellationToken.None);
            var observer = new CurrentSchemaReadObserver(db, inspector);
            CurrentSchemaReadObservation observation = await observer.ReadAsync(CancellationToken.None);
            CurrentSchemaProjection entity = CurrentSchemaCanonicalAuthority.Generate(
                inspector.BuildCanonicalModel(inspector.GetManagedEntityTypes()));
            CurrentSchemaIdentity complete = CurrentSchemaOwnedTargetProjection.Observe(
                entity, CurrentSchemaOwnedProjectionExporter.DescribeRequiredRecipes());
            Assert.NotEqual(entity.Identity, complete);
            Assert.Equal(complete, observation.CanonicalIdentity);
            SchemaModelSnapshot snapshot = await inspector.ReadActualModelAsync(db, CancellationToken.None);
            Assert.Equal(CurrentSchemaCanonicalAuthority.ComputeObservationDigest(snapshot.Tables), observation.ActualDigest);
            Assert.Same(callerTransaction, db.Ado.Transaction);

            InvalidOperationException rejected = await Assert.ThrowsAsync<InvalidOperationException>(
                () => observer.ReadAdmissionAsync(CancellationToken.None));
            Assert.Equal("current_schema_provider_snapshot_unavailable", rejected.Message);
            Assert.Same(callerTransaction, db.Ado.Transaction);
            Assert.Equal(1, await db.Ado.GetIntAsync("SELECT 1;"));
        }
        finally
        {
            await db.Ado.RollbackTranAsync();
        }
    }

    [Theory]
    [InlineData("default")]
    [InlineData("default-null")]
    [InlineData("collation")]
    [InlineData("check")]
    [InlineData("index")]
    [InlineData("same-shape-standalone-index")]
    [InlineData("trigger")]
    [InlineData("same-name-wrong-shape")]
    [InlineData("unknown-history")]
    [InlineData("no-inherit")]
    [InlineData("row-security")]
    [InlineData("rule")]
    [InlineData("unowned-function")]
    [InlineData("unowned-sequence")]
    public async Task CompleteRuntimeObserver_RequiresActualCurrentControlShapeButNeverParsesJournalPayload(string drift)
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        var inspector = new SchemaModelInspector();
        PostgresSqlSugarTestClient.InitTables(db, inspector.GetManagedEntityTypes().ToArray());
        await CurrentSchemaRuntimeRollupTables.ApplyEnsureTableStepsAsync(db, CancellationToken.None);
        await db.Ado.BeginTranAsync(IsolationLevel.RepeatableRead);
        System.Data.IDbTransaction caller = db.Ado.Transaction;
        try
        {
            await PgCurrentSchemaControlShape.EnsureApplyJournalAsync(
                (System.Data.Common.DbConnection)db.Ado.Connection,
                (System.Data.Common.DbTransaction)caller, CancellationToken.None);
            const string Journal = CurrentSchemaControlShape.ApplyJournalTableName;
            await db.Ado.ExecuteCommandAsync($"INSERT INTO public.{Journal} (plan_digest,database_digest,invocation_id,sequence,entry_digest,parent_digest,entry_payload) VALUES ('a','b','fixture',1,'c','d','not JSON and not a migration receipt');");
            var observer = new CurrentSchemaReadObserver(db, inspector);
            CurrentSchemaReadObservation valid = await observer.ReadAsync(CancellationToken.None);
            Assert.Equal(CurrentSchemaCanonicalAuthority.ModelVersion, valid.CanonicalIdentity.ModelVersion);
            Assert.Equal(1, await db.Ado.GetIntAsync($"SELECT count(*) FROM public.{Journal};"));
            string sql = drift switch
            {
                "default" => $"ALTER TABLE public.{Journal} ALTER COLUMN entry_payload SET DEFAULT 'changed';",
                // PostgreSQL folds a TEXT NULL default away. Varchar retains a
                // real typed pg_attrdef fact for the original rejection check.
                "default-null" => $"ALTER TABLE public.{Journal} ALTER COLUMN entry_digest SET DEFAULT NULL;",
                "collation" => $"ALTER TABLE public.{Journal} ALTER COLUMN entry_payload TYPE text COLLATE \"C\";",
                "check" => $"ALTER TABLE public.{Journal} DROP CONSTRAINT {Journal}_sequence_check; ALTER TABLE public.{Journal} ADD CONSTRAINT {Journal}_sequence_check CHECK (sequence >= 0);",
                "index" => $"ALTER TABLE public.{Journal} DROP CONSTRAINT {Journal}_entry_digest_key; CREATE UNIQUE INDEX {Journal}_entry_digest_key ON public.{Journal} (entry_digest DESC);",
                "same-shape-standalone-index" => $"ALTER TABLE public.{Journal} DROP CONSTRAINT {Journal}_entry_digest_key; CREATE UNIQUE INDEX {Journal}_entry_digest_key ON public.{Journal} (entry_digest ASC);",
                "trigger" => $"CREATE FUNCTION public.control_fixture_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'unexpected_control_effect'; END; $$; CREATE TRIGGER control_fixture_trigger BEFORE UPDATE OR DELETE ON public.{Journal} FOR EACH ROW EXECUTE FUNCTION public.control_fixture_guard();",
                "same-name-wrong-shape" => $"DROP TABLE public.{Journal}; CREATE TABLE public.{Journal} (plan_digest varchar(64) NOT NULL);",
                "unknown-history" => "CREATE TABLE public.__fsus_schema_unregistered_history (value text NOT NULL);",
                "no-inherit" => $"ALTER TABLE public.{Journal} DROP CONSTRAINT {Journal}_sequence_check; ALTER TABLE public.{Journal} ADD CONSTRAINT {Journal}_sequence_check CHECK (sequence > 0) NO INHERIT;",
                "row-security" => $"ALTER TABLE public.{Journal} ENABLE ROW LEVEL SECURITY;",
                "rule" => $"CREATE RULE unexpected_control_rule AS ON UPDATE TO public.{Journal} DO INSTEAD NOTHING;",
                "unowned-function" => "CREATE FUNCTION public.unexpected_current_function() RETURNS integer LANGUAGE sql AS 'SELECT 1';",
                "unowned-sequence" => "CREATE SEQUENCE public.unexpected_current_sequence;",
                _ => throw new InvalidOperationException("Unknown native control drift.")
            };
            await db.Ado.ExecuteCommandAsync(sql);
            if (drift == "default-null")
                Assert.Equal("NULL::character varying", await db.Ado.GetStringAsync($"""
                    SELECT pg_get_expr(d.adbin,d.adrelid)
                    FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid=d.adrelid AND a.attnum=d.adnum
                    WHERE d.adrelid='public.{Journal}'::regclass AND a.attname='entry_digest';
                    """));
            await Assert.ThrowsAsync<CurrentSchemaMismatchException>(() => observer.ReadAsync(CancellationToken.None));
            if (drift == "same-shape-standalone-index")
            {
                Assert.Equal(3, await db.Ado.GetIntAsync($"SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.{Journal}'::regclass AND contype IN ('p','u','f','c');"));
                int serverVersion = await db.Ado.GetIntAsync("SELECT current_setting('server_version_num')::integer;");
                Assert.Equal(serverVersion >= 180000 ? CurrentSchemaControlShape.DescribeApplyJournal().Columns.Count : 0,
                    await db.Ado.GetIntAsync($"SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.{Journal}'::regclass AND contype = 'n';"));
                await Assert.ThrowsAsync<InvalidOperationException>(() => PgCurrentSchemaControlShape.ValidateApplyJournalAsync(
                    (System.Data.Common.DbConnection)db.Ado.Connection,
                    (System.Data.Common.DbTransaction)caller, CancellationToken.None));
            }
            Assert.Same(caller, db.Ado.Transaction);
            Assert.Equal(1, await db.Ado.GetIntAsync("SELECT 1;"));
        }
        finally
        {
            await db.Ado.RollbackTranAsync();
        }
    }

    [Theory]
    [InlineData(IsolationLevel.ReadCommitted)]
    [InlineData(IsolationLevel.Serializable)]
    public async Task CompleteRuntimeObserver_RejectsNonRrCallerWithoutDisposingIt(IsolationLevel isolation)
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        await db.Ado.BeginTranAsync(isolation);
        System.Data.IDbTransaction callerTransaction = db.Ado.Transaction;
        try
        {
            var observer = new CurrentSchemaReadObserver(db, new SchemaModelInspector());
            CurrentSchemaMismatchException rejected = await Assert.ThrowsAsync<CurrentSchemaMismatchException>(
                () => observer.ReadAsync(CancellationToken.None));
            Assert.Equal("fsusblog.current-schema.mismatch.unreadable", rejected.MismatchRef);
            await Assert.ThrowsAsync<InvalidOperationException>(
                () => new SchemaModelInspector().ReadActualModelAsync(db, CancellationToken.None));
            Assert.Same(callerTransaction, db.Ado.Transaction);
            Assert.Equal(1, await db.Ado.GetIntAsync("SELECT 1;"));
        }
        finally
        {
            await db.Ado.RollbackTranAsync();
        }
    }

    [Fact]
    public async Task NativeCatalogObserver_OriginalServerParityUsesSamePhysicalModelsAndObservationDigest()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        var inspector = new SchemaModelInspector();
        PostgresSqlSugarTestClient.InitTables(db, inspector.GetManagedEntityTypes().ToArray());
        await CurrentSchemaRuntimeRollupTables.ApplyEnsureTableStepsAsync(db, CancellationToken.None);
        SchemaModelSnapshot original = await inspector.ReadActualModelAsync(db, CancellationToken.None);
        await using var connection = new NpgsqlConnection(db.CurrentConnectionConfig.ConnectionString);
        await connection.OpenAsync();
        await using NpgsqlTransaction transaction = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead);
        SchemaModelSnapshot native = await PgCurrentSchemaCatalogObserver.ReadAsync(connection, transaction, CancellationToken.None);
        Assert.Empty(SchemaModelComparer.Compare(original, native));
        Assert.Empty(SchemaModelComparer.Compare(native, original));
        Assert.Equal(CurrentSchemaCanonicalAuthority.ComputeObservationDigest(original.Tables),
            CurrentSchemaCanonicalAuthority.ComputeObservationDigest(native.Tables));
        await using NpgsqlCommand stillActive = connection.CreateCommand();
        stillActive.Transaction = transaction;
        stillActive.CommandText = "SELECT 1;";
        Assert.Equal(1, Convert.ToInt32(await stillActive.ExecuteScalarAsync()));
        await transaction.RollbackAsync();
    }

    [Fact]
    public async Task NativeCatalogObserver_ReusesCallerRepeatableReadSnapshotAcrossConcurrentCatalogChange()
    {
        string database = await fixture.CreateDatabaseAsync();
        string connectionString = fixture.BuildDatabaseConnectionString(database);
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync();
        await using NpgsqlTransaction transaction = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead);
        SchemaModelSnapshot before = await PgCurrentSchemaCatalogObserver.ReadAsync(connection, transaction, CancellationToken.None);
        await using (var other = new NpgsqlConnection(connectionString))
        {
            await other.OpenAsync();
            await using NpgsqlCommand create = other.CreateCommand();
            create.CommandText = "CREATE TABLE native_catalog_external_probe(id integer PRIMARY KEY);";
            await create.ExecuteNonQueryAsync();
        }
        SchemaModelSnapshot sameSnapshot = await PgCurrentSchemaCatalogObserver.ReadAsync(connection, transaction, CancellationToken.None);
        Assert.Equal(CurrentSchemaCanonicalAuthority.ComputeObservationDigest(before.Tables),
            CurrentSchemaCanonicalAuthority.ComputeObservationDigest(sameSnapshot.Tables));
        Assert.DoesNotContain("native_catalog_external_probe", sameSnapshot.Tables.Keys);
        await transaction.RollbackAsync();
        await using NpgsqlTransaction fresh = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead);
        SchemaModelSnapshot newSnapshot = await PgCurrentSchemaCatalogObserver.ReadAsync(connection, fresh, CancellationToken.None);
        Assert.Contains("native_catalog_external_probe", newSnapshot.Tables.Keys);
        Assert.NotEmpty(SchemaModelComparer.Compare(before, newSnapshot));
        await fresh.RollbackAsync();
    }

    [Fact]
    public async Task NativeCatalogObserver_RejectsWrongTransactionClosedConnectionAndCancellationBeforeQueries()
    {
        string database = await fixture.CreateDatabaseAsync();
        string connectionString = fixture.BuildDatabaseConnectionString(database);
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync();
        await using (NpgsqlTransaction wrongIsolation = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted))
        {
            Assert.Contains("native_catalog_transaction_mismatch", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
                PgCurrentSchemaCatalogObserver.ReadAsync(connection, wrongIsolation, CancellationToken.None))).Message);
            await wrongIsolation.RollbackAsync();
        }
        await using NpgsqlTransaction transaction = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead);
        await using var closed = new NpgsqlConnection(connectionString);
        Assert.Contains("native_catalog_transaction_mismatch", (await Assert.ThrowsAsync<InvalidOperationException>(() =>
            PgCurrentSchemaCatalogObserver.ReadAsync(closed, transaction, CancellationToken.None))).Message);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            PgCurrentSchemaCatalogObserver.ReadAsync(connection, transaction, cancellation.Token));
        await transaction.RollbackAsync();
    }

    [Fact]
    public async Task CompiledCurrentRecipes_MatchOriginalPostgresRecipeEffectsAndImmutableGuards()
    {
        string originalDatabase = await fixture.CreateDatabaseAsync();
        string compiledDatabase = await fixture.CreateDatabaseAsync();
        string originalConnection = fixture.BuildDatabaseConnectionString(originalDatabase);
        string compiledConnection = fixture.BuildDatabaseConnectionString(compiledDatabase);
        var inspector = new SchemaModelInspector();
        IReadOnlyList<Type> entityTypes = inspector.GetManagedEntityTypes();
        using (var original = new SqlSugarClient(new ConnectionConfig
        {
            ConnectionString = originalConnection,
            DbType = SqlSugar.DbType.PostgreSQL,
            IsAutoCloseConnection = true
        }))
        {
            PostgresSqlSugarTestClient.InitTables(original, entityTypes.ToArray());
            await CurrentSchemaRuntimeRollupTables.ApplyEnsureTableStepsAsync(original, CancellationToken.None);
        }
        CurrentSchemaProjection projection = CurrentSchemaCanonicalAuthority.Generate(inspector.BuildCanonicalModel(entityTypes));
        var owner = new CurrentSchemaProducerIdentity(new string('a', 40), CurrentSchemaOwnedProjectionExporter.ProducerId,
            new string('b', 64), new string('c', 64));
        var input = new CurrentSchemaBootstrapInput(projection, owner, CurrentSchemaOwnedProjectionExporter.DescribeRequiredRecipes());
        CompiledCurrentSchemaBootstrap compiled = CurrentSchemaBootstrapCompiler.Compile(input, owner,
            SchemaProviderKind.PostgreSql, CurrentSchemaBootstrapCompiler.OwnedInputDigest(input));
        await using (var connection = new NpgsqlConnection(compiledConnection))
        {
            await connection.OpenAsync();
            await using NpgsqlTransaction transaction = await connection.BeginTransactionAsync();
            await CurrentSchemaBootstrapCompiler.ExecuteAsync(compiled, connection, transaction, CancellationToken.None);
            await transaction.CommitAsync();
        }
        IReadOnlyList<string> originalFacts = await fixture.CaptureSchemaSnapshotAsync(originalConnection);
        IReadOnlyList<string> compiledFacts = await fixture.CaptureSchemaSnapshotAsync(compiledConnection);
        foreach (string fact in originalFacts.Except(compiledFacts, StringComparer.Ordinal))
            Console.WriteLine("Original schema fact missing from compiled: " + fact);
        foreach (string fact in compiledFacts.Except(originalFacts, StringComparer.Ordinal))
            Console.WriteLine("Compiled schema fact absent from original: " + fact);
        Assert.Equal(originalFacts, compiledFacts);
        foreach (string connectionString in new[] { originalConnection, compiledConnection })
        {
            await using var connection = new NpgsqlConnection(connectionString);
            await connection.OpenAsync();
            await using NpgsqlCommand seed = connection.CreateCommand();
            seed.CommandText = "SELECT state, last_article_id, rate_per_second FROM public_article_projection_backfill WHERE scope='global';";
            await using (NpgsqlDataReader reader = await seed.ExecuteReaderAsync())
            {
                Assert.True(await reader.ReadAsync());
                Assert.Equal("paused", reader.GetString(0));
                Assert.Equal(0, reader.GetInt32(1));
                Assert.InRange(reader.GetInt32(2), 1, 1000);
            }
            await using NpgsqlCommand guard = connection.CreateCommand();
            guard.CommandText = "SELECT prosrc FROM pg_proc WHERE proname IN ('article_create_immutable_guard','article_template_immutable_guard') ORDER BY proname;";
            await using NpgsqlDataReader guards = await guard.ExecuteReaderAsync();
            int count = 0;
            while (await guards.ReadAsync())
            {
                Assert.Contains("RAISE EXCEPTION", guards.GetString(0));
                count++;
            }
            Assert.Equal(2, count);
            await guards.DisposeAsync();
            await using NpgsqlCommand insert = connection.CreateCommand();
            insert.CommandText = "INSERT INTO article_create_request(request_id,owner_admin_principal_id,request_digest,receipt_id,created_at_utc) VALUES (@request,1,@digest,@receipt,now());";
            insert.Parameters.AddWithValue("request", Guid.NewGuid());
            insert.Parameters.AddWithValue("digest", new string('a', 64));
            insert.Parameters.AddWithValue("receipt", Guid.NewGuid());
            await insert.ExecuteNonQueryAsync();
            await using NpgsqlCommand update = connection.CreateCommand();
            update.CommandText = "UPDATE article_create_request SET created_at_utc=now();";
            PostgresException refusal = await Assert.ThrowsAsync<PostgresException>(() => update.ExecuteNonQueryAsync());
            Assert.Equal("P0001", refusal.SqlState);
            Assert.Contains("article_create_immutable_row", refusal.MessageText);
        }
    }

    [Fact]
    public async Task CompiledEntitySubset_MaterializesExactOriginalExtractorFactsOnRealPostgres()
    {
        string database = await fixture.CreateDatabaseAsync();
        string connectionString = fixture.BuildDatabaseConnectionString(database);
        CurrentSchemaCanonicalModel canonical = CurrentSchemaEntityExtractor.Extract([typeof(CompiledBootstrapProbe)]);
        CompiledCurrentSchemaBootstrap compiled = CurrentSchemaBootstrapCompiler.CompileEntityProjection(
            CurrentSchemaCanonicalAuthority.Generate(canonical), SchemaProviderKind.PostgreSql);
        await using (var connection = new NpgsqlConnection(connectionString))
        {
            await connection.OpenAsync();
            await using NpgsqlTransaction transaction = await connection.BeginTransactionAsync();
            await CurrentSchemaBootstrapCompiler.ExecuteAsync(compiled, connection, transaction, CancellationToken.None);
            await transaction.CommitAsync();
        }
        using var db = new SqlSugarClient(new ConnectionConfig
        {
            ConnectionString = connectionString,
            DbType = SqlSugar.DbType.PostgreSQL,
            IsAutoCloseConnection = true
        });
        SchemaModelSnapshot actual = await new SchemaModelInspector().ReadActualModelAsync(db, CancellationToken.None);
        SchemaModelSnapshot expected = CurrentSchemaCanonicalAuthority.ProjectProvider(canonical, SchemaProviderKind.PostgreSql);
        Assert.Empty(SchemaModelComparer.Compare(expected, actual));
        Assert.True(await fixture.IndexExistsAsync(connectionString, "ix_compiled_bootstrap_probe_name"));
    }

    [Fact]
    public async Task CompiledEntitySubset_DriftRefusesBeforeAnyRealPostgresWrite()
    {
        string database = await fixture.CreateDatabaseAsync();
        string connectionString = fixture.BuildDatabaseConnectionString(database);
        IReadOnlyList<string> before = await fixture.CaptureSchemaSnapshotAsync(connectionString);
        CurrentSchemaCanonicalModel canonical = CurrentSchemaEntityExtractor.Extract([typeof(CompiledBootstrapProbe)]);
        CompiledCurrentSchemaBootstrap compiled = CurrentSchemaBootstrapCompiler.CompileEntityProjection(
            CurrentSchemaCanonicalAuthority.Generate(canonical), SchemaProviderKind.PostgreSql);
        await using (var connection = new NpgsqlConnection(connectionString))
        {
            await connection.OpenAsync();
            await using NpgsqlTransaction transaction = await connection.BeginTransactionAsync();
            await Assert.ThrowsAsync<InvalidOperationException>(() => CurrentSchemaBootstrapCompiler.ExecuteAsync(
                compiled with
                {
                    CommandDigest = new string('d', 64)
                }, connection, transaction, CancellationToken.None));
            await transaction.RollbackAsync();
        }
        Assert.Equal(before, await fixture.CaptureSchemaSnapshotAsync(connectionString));
    }

    [Fact]
    public async Task CompiledEntitySubset_LeavesRollbackOwnedByOriginalCallerTransaction()
    {
        string database = await fixture.CreateDatabaseAsync();
        string connectionString = fixture.BuildDatabaseConnectionString(database);
        IReadOnlyList<string> before = await fixture.CaptureSchemaSnapshotAsync(connectionString);
        CurrentSchemaCanonicalModel canonical = CurrentSchemaEntityExtractor.Extract([typeof(CompiledBootstrapProbe)]);
        CompiledCurrentSchemaBootstrap compiled = CurrentSchemaBootstrapCompiler.CompileEntityProjection(
            CurrentSchemaCanonicalAuthority.Generate(canonical), SchemaProviderKind.PostgreSql);
        await using (var connection = new NpgsqlConnection(connectionString))
        {
            await connection.OpenAsync();
            await using NpgsqlTransaction transaction = await connection.BeginTransactionAsync();
            await CurrentSchemaBootstrapCompiler.ExecuteAsync(compiled, connection, transaction, CancellationToken.None);
            await using NpgsqlCommand observation = connection.CreateCommand();
            observation.Transaction = transaction;
            observation.CommandText = "SELECT COUNT(*) FROM pg_catalog.pg_class relation JOIN pg_catalog.pg_namespace ns ON ns.oid=relation.relnamespace WHERE ns.nspname='public' AND relation.relname='compiled_bootstrap_probe'";
            Assert.Equal(1L, Convert.ToInt64(await observation.ExecuteScalarAsync()));
            await transaction.RollbackAsync();
        }
        Assert.Equal(before, await fixture.CaptureSchemaSnapshotAsync(connectionString));
    }

    [SugarTable("compiled_bootstrap_probe")]
    [SugarIndex("ix_compiled_bootstrap_probe_name", nameof(Name), OrderByType.Asc)]
    private sealed class CompiledBootstrapProbe
    {
        [SugarColumn(ColumnName = "id", IsPrimaryKey = true, IsIdentity = true)]
        public long Id
        {
            get; set;
        }

        [SugarColumn(ColumnName = "name", Length = 64, IsNullable = true)]
        public string? Name
        {
            get; set;
        }

        [SugarColumn(ColumnName = "counter", DefaultValue = "0")]
        public int Counter
        {
            get; set;
        }
    }

    [Fact]
    public async Task ApplyEnsureTableSteps_CreatesStatsRollupTablesQueryableAsEmpty()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        var inspector = new SchemaModelInspector();
        PostgresSqlSugarTestClient.InitTables(db, inspector.GetManagedEntityTypes().ToArray());
        await CurrentSchemaRuntimeRollupTables.ApplyEnsureTableStepsAsync(db, CancellationToken.None);

        DataTable stats = await db.Ado.GetDataTableAsync("""
            SELECT
                COALESCE((SELECT SUM(total_reads)::bigint FROM daily_read_stats), 0)::bigint AS "TotalReads",
                COALESCE((SELECT SUM(read_count)::bigint FROM event_type_read_stats WHERE event_type = 'article_read'), 0)::bigint AS "ArticleReads",
                COALESCE((SELECT SUM(read_count)::bigint FROM region_read_stats), 0)::bigint AS "RegionReads";
            """);
        Assert.Equal(1, stats.Rows.Count);
        Assert.Equal(0L, Convert.ToInt64(stats.Rows[0]["TotalReads"], CultureInfo.InvariantCulture));
        Assert.Equal(0L, Convert.ToInt64(stats.Rows[0]["ArticleReads"], CultureInfo.InvariantCulture));
        Assert.Equal(0L, Convert.ToInt64(stats.Rows[0]["RegionReads"], CultureInfo.InvariantCulture));
        Assert.Equal(0, await db.Ado.GetIntAsync("SELECT COUNT(1) FROM author_daily_read_stats;"));
    }
}
