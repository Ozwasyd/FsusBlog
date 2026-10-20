using System.Data;

using FsusBlog.Contracts.Schema;
using FsusBlog.Migration;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Shared.Algorithms.Schema;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Tests.Integration;

[Trait("Category", "Integration")]
[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class CurrentSchemaIndexExpressionPostgresTests(PostgresSchemaMigrationFixture fixture)
{
    private const string Index = "ix_author_recent_history_entry_order";
    private const string Table = "author_recent_history_entry";
    private const string OriginalExpression = "GREATEST(last_opened_at_utc,last_edited_at_utc,last_activated_at_utc)";

    [Fact]
    public async Task OriginalHistoryRecipesAndBothCompilers_PreserveTheActualExpressionKey()
    {
        CurrentSchemaBootstrapInput input = Input();
        string original = await CreateOriginalAsync();
        string compiled = fixture.BuildDatabaseConnectionString(await fixture.CreateDatabaseAsync());
        await using (var connection = new NpgsqlConnection(compiled))
        {
            await connection.OpenAsync();
            await using NpgsqlTransaction transaction = await connection.BeginTransactionAsync();
            await CurrentSchemaBootstrapCompiler.ExecuteAsync(CurrentSchemaBootstrapCompiler.Compile(input, input.Producer,
                SchemaProviderKind.PostgreSql, CurrentSchemaBootstrapCompiler.OwnedInputDigest(input)), connection, transaction, default);
            await transaction.CommitAsync();
        }
        foreach (string connectionString in new[] { original, compiled })
        {
            await using var connection = new NpgsqlConnection(connectionString);
            await connection.OpenAsync();
            await using NpgsqlTransaction transaction = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead);
            await PgCurrentSchemaControlShape.EnsureApplyJournalAsync(connection, transaction, default);
            PgCurrentSchemaNativeObservation actual = await PgCurrentSchemaNativeObserver.ReadAsync(connection, transaction, default);
            Assert.Empty(PgCurrentSchemaNativeObserver.Compare(Target(input), actual.Tables, actual.Effects));
            SchemaIndexKeyModel key = actual.Tables.Tables[Table].IndexDefinitions[Index].Keys[2];
            Assert.Equal(string.Empty, key.Column);
            Assert.Equal(new[] { "last_opened_at_utc", "last_edited_at_utc", "last_activated_at_utc" }, SchemaIndexExpressions.Columns(key.Expression!));
            Assert.Equal("desc", key.Direction);
            Assert.Equal("first", key.NullPlacement);
            Assert.Equal("default", key.OperatorClass);
            Assert.Equal("default", key.Collation);
            PgCurrentIndexExpression raw = Assert.Single(actual.Effects.IndexExpressions);
            Assert.Equal(2, raw.Position);
            Assert.Equal("timestamp without time zone", raw.PhysicalType);
            Assert.Equal(6, raw.Columns.Length);
            Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaNativeObserver.Compare(Target(input), actual.Tables,
                actual.Effects with
                {
                    IndexExpressions = []
                }));
            Assert.Throws<InvalidOperationException>(() => PgCurrentSchemaNativeObserver.Compare(Target(input), actual.Tables,
                actual.Effects with
                {
                    IndexExpressions = [raw with { Columns = ["last_opened_at_utc"] }]
                }));
            await transaction.RollbackAsync();
        }

        // The entity compiler consumes the same typed index fact independently
        // of the recipe compiler; no alternate expression-to-SQL mapping exists.
        CurrentSchemaCompletePhysicalProjection target = Target(input);
        var semantic = new SchemaTableModel(Table, target.Tables.Tables[Table].Columns, [Index],
            new Dictionary<string, SchemaIndexModel> { [Index] = target.Tables.Tables[Table].IndexDefinitions[Index] });
        CurrentSchemaProjection projection = CurrentSchemaCanonicalAuthority.Generate(CurrentSchemaCanonicalAuthority.Create(
            new Dictionary<string, SchemaTableModel> { [Table] = semantic }, new string('a', 64)));
        Assert.Contains(CurrentSchemaBootstrapCompiler.CompileEntityProjection(projection, SchemaProviderKind.PostgreSql).Commands,
            command => command.Sql.Contains("GREATEST", StringComparison.Ordinal));
    }

    [Theory]
    [InlineData("expression")]
    [InlineData("cast")]
    [InlineData("sort")]
    [InlineData("nulls")]
    [InlineData("collation")]
    [InlineData("opclass")]
    public async Task ActualIndexDrift_IsNotTheOriginalOwnerFact(string drift)
    {
        CurrentSchemaBootstrapInput input = Input();
        await using var connection = new NpgsqlConnection(await CreateOriginalAsync());
        await connection.OpenAsync();
        await using NpgsqlTransaction transaction = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead);
        await PgCurrentSchemaControlShape.EnsureApplyJournalAsync(connection, transaction, default);
        PgCurrentSchemaNativeObservation before = await PgCurrentSchemaNativeObserver.ReadAsync(connection, transaction, default);
        Assert.Empty(PgCurrentSchemaNativeObserver.Compare(Target(input), before.Tables, before.Effects));
        string expression = drift switch
        {
            "expression" => "GREATEST(last_edited_at_utc,last_opened_at_utc,last_activated_at_utc)",
            "cast" => "GREATEST(last_opened_at_utc::timestamp(0),last_edited_at_utc,last_activated_at_utc)",
            _ => OriginalExpression
        };
        string order = drift == "sort" ? "ASC" : "DESC";
        string nulls = drift == "nulls" ? "NULLS LAST" : "NULLS FIRST";
        string scope = drift == "collation" ? "site_scope COLLATE \"C\"" : "site_scope";
        if (drift == "opclass")
        {
            await using var custom = new NpgsqlCommand("""
                CREATE OPERATOR CLASS public.history_timestamp_ops FOR TYPE timestamp USING btree AS
                    OPERATOR 1 <, OPERATOR 2 <=, OPERATOR 3 =, OPERATOR 4 >=, OPERATOR 5 >,
                    FUNCTION 1 pg_catalog.timestamp_cmp(timestamp, timestamp);
                """, connection, transaction);
            await custom.ExecuteNonQueryAsync();
        }
        string opclass = drift == "opclass" ? "public.history_timestamp_ops" : "";
        await using var change = new NpgsqlCommand($"""
            DROP INDEX {Index};
            CREATE INDEX {Index} ON {Table}(owner_admin_principal_id,{scope},({expression}) {opclass} {order} {nulls},article_id DESC);
            """, connection, transaction);
        await change.ExecuteNonQueryAsync();
        PgCurrentSchemaNativeObservation after = await PgCurrentSchemaNativeObserver.ReadAsync(connection, transaction, default);
        Assert.Contains(PgCurrentSchemaNativeObserver.Compare(Target(input), after.Tables, after.Effects),
            error => error.StartsWith("index mismatch " + Table + "." + Index, StringComparison.Ordinal));
        await transaction.RollbackAsync();
    }

    [Fact]
    public async Task CatalogAndEffectReaders_UseTheSameOriginalRrAcrossConcurrentIndexCreation()
    {
        CurrentSchemaBootstrapInput input = Input();
        string connectionString = await CreateOriginalAsync();
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync();
        await using (NpgsqlTransaction setup = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead))
        {
            await PgCurrentSchemaControlShape.EnsureApplyJournalAsync(connection, setup, default);
            await setup.CommitAsync();
        }
        await using (NpgsqlTransaction transaction = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead))
        {
            SchemaModelSnapshot catalog = await PgCurrentSchemaCatalogObserver.ReadAsync(connection, transaction, default);
            await using (var writer = new NpgsqlConnection(connectionString))
            {
                await writer.OpenAsync();
                await using var create = new NpgsqlCommand($"CREATE INDEX history_concurrent_expression ON {Table}(({OriginalExpression}) DESC);", writer);
                await create.ExecuteNonQueryAsync();
            }
            PgCurrentSchemaEffectObservation effects = await PgCurrentSchemaEffectObserver.ReadAsync(connection, transaction, default);
            Assert.Single(effects.IndexExpressions);
            Assert.Empty(PgCurrentSchemaNativeObserver.Compare(Target(input), catalog, effects));
            await transaction.RollbackAsync();
        }
        await using NpgsqlTransaction fresh = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead);
        PgCurrentSchemaNativeObservation changed = await PgCurrentSchemaNativeObserver.ReadAsync(connection, fresh, default);
        Assert.Equal(2, changed.Effects.IndexExpressions.Count);
        Assert.NotEmpty(PgCurrentSchemaNativeObserver.Compare(Target(input), changed.Tables, changed.Effects));
        await fresh.RollbackAsync();
    }

    private static CurrentSchemaRuntimeRollupTable[] Recipes()
        => CurrentSchemaRuntimeRollupTables.Tables.Where(static recipe => recipe.TableName is "author_recent_history_collection" or Table).ToArray();

    private static CurrentSchemaBootstrapInput Input()
    {
        // Component SQL fidelity uses a synthetic owner; full actual owner export
        // remains exercised by the unchanged four receipt cases and original suite.
        var owner = new CurrentSchemaProducerIdentity(new string('a', 40), CurrentSchemaOwnedProjectionExporter.ProducerId,
            new string('b', 64), new string('c', 64));
        CurrentSchemaProjection projection = CurrentSchemaCanonicalAuthority.Generate(new SchemaModelInspector().BuildCanonicalModel([typeof(AdminPrincipal)]));
        return new(projection, owner, Recipes().Select(static recipe => new CurrentSchemaRequiredRecipeReference(recipe.TableName,
            SchemaProviderKind.PostgreSql, new string('a', 64), CurrentSchemaRecipeFactExtractor.Extract(recipe))).ToArray());
    }

    private async Task<string> CreateOriginalAsync()
    {
        string connectionString = fixture.BuildDatabaseConnectionString(await fixture.CreateDatabaseAsync());
        using (SqlSugarClient db = PostgresSqlSugarTestClient.Create(connectionString))
        {
            db.CodeFirst.InitTables<AdminPrincipal>();
        }
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync();
        foreach (CurrentSchemaRuntimeRollupTable recipe in Recipes())
        {
            foreach (string sql in new[] { recipe.CreateSql }.Concat(recipe.AdditionalSql ?? []))
            {
                await using var command = new NpgsqlCommand(sql, connection);
                await command.ExecuteNonQueryAsync();
            }
        }
        return connectionString;
    }

    private static CurrentSchemaCompletePhysicalProjection Target(CurrentSchemaBootstrapInput input)
        => CurrentSchemaCanonicalAuthority.ProjectOwnedTarget(input, SchemaProviderKind.PostgreSql);
}
