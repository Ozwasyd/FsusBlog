using System.Data;
using System.Globalization;
using System.Text.RegularExpressions;

using FsusBlog.Contracts.Schema;
using FsusBlog.Migration;
using FsusBlog.Migration.Definitions;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Tests.TestInfrastructure;

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
            ArticleCreateAuthorityMigrationDefinitions.BuildMigration()
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
}

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class CurrentSchemaRuntimeRollupTablesDatabaseTests(PostgresSchemaMigrationFixture fixture)
{
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
                compiled with { CommandDigest = new string('d', 64) }, connection, transaction, CancellationToken.None));
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
        public long Id { get; set; }

        [SugarColumn(ColumnName = "name", Length = 64, IsNullable = true)]
        public string? Name { get; set; }

        [SugarColumn(ColumnName = "counter", DefaultValue = "0")]
        public int Counter { get; set; }
    }

    [Fact]
    public async Task ApplyEnsureTableSteps_CreatesStatsRollupTablesQueryableAsEmpty()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        var inspector = new SchemaModelInspector();
        db.CodeFirst.InitTables(inspector.GetManagedEntityTypes().ToArray());
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
