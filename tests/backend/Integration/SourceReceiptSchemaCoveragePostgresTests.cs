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
[Collection(nameof(SchemaMigrationPostgresCollectionA))]
public sealed class SourceReceiptSchemaCoveragePostgresTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task OriginalControlTable_PreservesNativeNotNullAndRefusesItsRemoval()
    {
        string database = await fixture.CreateDatabaseAsync();
        await using var connection = new NpgsqlConnection(fixture.BuildDatabaseConnectionString(database));
        await connection.OpenAsync();
        await using NpgsqlTransaction transaction = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead);
        await PgCurrentSchemaControlShape.EnsureApplyJournalAsync(connection, transaction, default);
        await PgCurrentSchemaControlShape.ValidateApplyJournalAsync(connection, transaction, default);
        await using var change = new NpgsqlCommand($"ALTER TABLE {CurrentSchemaControlShape.ApplyJournalTableName} ALTER COLUMN entry_payload DROP NOT NULL;",
            connection, transaction);
        await change.ExecuteNonQueryAsync();
        await Assert.ThrowsAsync<InvalidOperationException>(() =>
            PgCurrentSchemaControlShape.ValidateApplyJournalAsync(connection, transaction, default));
        await transaction.RollbackAsync();
    }

    [Theory]
    [InlineData("taxonomy_mutation_receipt", "P0001")]
    [InlineData("user_locale_mutation_receipt", "55000")]
    public async Task OriginalReceiptRecipeComponent_PreservesNativeFactsAndRejectsGuardDrift(string table, string sqlState)
    {
        // This isolates the two actual leaf recipes. Its synthetic producer
        // identity is not evidence that the still blocked full owner export works.
        CurrentSchemaRuntimeRollupTable original = Assert.Single(CurrentSchemaRuntimeRollupTables.Tables,
            recipe => recipe.TableName == table);
        var owner = new CurrentSchemaProducerIdentity(new string('a', 40), CurrentSchemaOwnedProjectionExporter.ProducerId,
            new string('b', 64), new string('c', 64));
        CurrentSchemaProjection projection = CurrentSchemaCanonicalAuthority.Generate(
            new SchemaModelInspector().BuildCanonicalModel([typeof(Category)]));
        var input = new CurrentSchemaBootstrapInput(projection, owner,
            [new(table, SchemaProviderKind.PostgreSql, new string('a', 64), CurrentSchemaRecipeFactExtractor.Extract(original))]);
        CompiledCurrentSchemaBootstrap compiled = CurrentSchemaBootstrapCompiler.Compile(input, owner,
            SchemaProviderKind.PostgreSql, CurrentSchemaBootstrapCompiler.OwnedInputDigest(input));
        string originalDatabase = await fixture.CreateDatabaseAsync();
        string compiledDatabase = await fixture.CreateDatabaseAsync();
        string originalConnection = fixture.BuildDatabaseConnectionString(originalDatabase);
        string compiledConnection = fixture.BuildDatabaseConnectionString(compiledDatabase);
        using (SqlSugarClient db = PostgresSqlSugarTestClient.Create(originalConnection))
        {
            db.CodeFirst.InitTables<Category>();
        }
        await using (var connection = new NpgsqlConnection(originalConnection))
        {
            await connection.OpenAsync();
            foreach (string sql in new[] { original.CreateSql }.Concat(original.AdditionalSql ?? []))
            {
                await using var command = new NpgsqlCommand(sql, connection);
                await command.ExecuteNonQueryAsync();
            }
        }
        await using (var connection = new NpgsqlConnection(compiledConnection))
        {
            await connection.OpenAsync();
            await using NpgsqlTransaction transaction = await connection.BeginTransactionAsync();
            await CurrentSchemaBootstrapCompiler.ExecuteAsync(compiled, connection, transaction, default);
            await transaction.CommitAsync();
        }
        CurrentSchemaRecipeOperation trigger = Assert.Single(input.RequiredRecipes[0].SemanticDescription!.AdditionalOperations,
            operation => operation.Kind == CurrentSchemaRecipeOperationKind.CreateImmutableTrigger);
        string column = table == "taxonomy_mutation_receipt" ? "target_id" : "account_id";
        foreach (string connectionString in new[] { originalConnection, compiledConnection })
        {
            Assert.Empty(await CompareNativeAsync(connectionString, input));
            await using var connection = new NpgsqlConnection(connectionString);
            await connection.OpenAsync();
            foreach (string sql in new[] { $"UPDATE {table} SET {column}={column};", $"DELETE FROM {table};", $"TRUNCATE {table};" })
            {
                await using var command = new NpgsqlCommand(sql, connection);
                PostgresException error = await Assert.ThrowsAsync<PostgresException>(() => command.ExecuteNonQueryAsync());
                Assert.Equal(sqlState, error.SqlState);
            }
            await using var weaken = new NpgsqlCommand($"""
                DROP TRIGGER {trigger.Name} ON {table};
                CREATE TRIGGER {trigger.Name} BEFORE UPDATE OR DELETE ON {table}
                    FOR EACH ROW EXECUTE FUNCTION {trigger.Function}();
                """, connection);
            await weaken.ExecuteNonQueryAsync();
            Assert.Contains(await CompareNativeAsync(connectionString, input),
                error => error == "effect_changed:" + table + "." + trigger.Name);
        }
    }

    [Theory]
    [InlineData("taxonomy_mutation_receipt")]
    [InlineData("user_locale_mutation_receipt")]
    public async Task ActualReceiptTableAndGuardMustBeRepresentedByTheOriginalCurrentSchemaOwner(string table)
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(User), typeof(UserLocalePreference), typeof(Category), typeof(Tag));
        Assert.Equal(table, await db.Ado.GetStringAsync("SELECT to_regclass(@Table)::text;", new SugarParameter("@Table", table)));
        Assert.True(await db.Ado.GetIntAsync("""
            SELECT count(*) FROM pg_trigger
            WHERE tgrelid = to_regclass(@Table) AND NOT tgisinternal;
            """, new SugarParameter("@Table", table)) > 0);
        Assert.Contains(CurrentSchemaOwnedProjectionExporter.DescribeRequiredRecipes(), recipe => recipe.TableName == table);
        CurrentSchemaRecipeFacts facts = Assert.Single(CurrentSchemaOwnedProjectionExporter.DescribeRequiredRecipes(),
            recipe => recipe.TableName == table).SemanticDescription!;
        Assert.NotEmpty(facts.Table.Constraints);
        CurrentSchemaRecipeOperation guard = Assert.Single(facts.AdditionalOperations,
            operation => operation.Kind == CurrentSchemaRecipeOperationKind.DefineImmutableGuard);
        Assert.Equal(table == "user_locale_mutation_receipt" ? "55000" : null, guard.SqlState);
        CurrentSchemaRecipeOperation trigger = Assert.Single(facts.AdditionalOperations,
            operation => operation.Kind == CurrentSchemaRecipeOperationKind.CreateImmutableTrigger);
        Assert.Equal(new(CurrentSchemaTriggerLevel.Statement,
            CurrentSchemaTriggerEvents.Update | CurrentSchemaTriggerEvents.Delete | CurrentSchemaTriggerEvents.Truncate), trigger.Trigger);
        if (table == "taxonomy_mutation_receipt")
            Assert.Equal("int32-array", facts.Table.Columns["affected_article_ids"].DataType);
    }

    [Theory]
    [InlineData("taxonomy_mutation_receipt", "P0001")]
    [InlineData("user_locale_mutation_receipt", "55000")]
    public async Task OriginalAndCompiledReceipts_PreserveNativeFactsAndRejectGuardDrift(string table, string sqlState)
    {
        CurrentSchemaBootstrapInput input = await CurrentSchemaOwnedProjectionExporter.ExportAsync(default);
        CompiledCurrentSchemaBootstrap compiled = CurrentSchemaBootstrapCompiler.Compile(input, input.Producer,
            SchemaProviderKind.PostgreSql, CurrentSchemaBootstrapCompiler.OwnedInputDigest(input));
        string originalDatabase = await fixture.CreateDatabaseAsync();
        string compiledDatabase = await fixture.CreateDatabaseAsync();
        string originalConnection = fixture.BuildDatabaseConnectionString(originalDatabase);
        string compiledConnection = fixture.BuildDatabaseConnectionString(compiledDatabase);
        using (SqlSugarClient original = PostgresSqlSugarTestClient.Create(originalConnection))
        {
            var inspector = new SchemaModelInspector();
            PostgresSqlSugarTestClient.InitTables(original, inspector.GetManagedEntityTypes().ToArray());
            await CurrentSchemaRuntimeRollupTables.ApplyEnsureTableStepsAsync(original, default);
        }
        await using (var connection = new NpgsqlConnection(compiledConnection))
        {
            await connection.OpenAsync();
            await using NpgsqlTransaction transaction = await connection.BeginTransactionAsync();
            await CurrentSchemaBootstrapCompiler.ExecuteAsync(compiled, connection, transaction, default);
            await transaction.CommitAsync();
        }
        CurrentSchemaRecipeFacts recipe = Assert.Single(input.RequiredRecipes, reference => reference.TableName == table).SemanticDescription!;
        CurrentSchemaRecipeOperation trigger = Assert.Single(recipe.AdditionalOperations,
            operation => operation.Kind == CurrentSchemaRecipeOperationKind.CreateImmutableTrigger);
        string column = table == "taxonomy_mutation_receipt" ? "target_id" : "account_id";
        foreach (string connectionString in new[] { originalConnection, compiledConnection })
        {
            Assert.Empty(await CompareNativeAsync(connectionString, input));
            await using var connection = new NpgsqlConnection(connectionString);
            await connection.OpenAsync();
            foreach (string sql in new[] { $"UPDATE {table} SET {column}={column};", $"DELETE FROM {table};", $"TRUNCATE {table};" })
            {
                await using var command = new NpgsqlCommand(sql, connection);
                PostgresException error = await Assert.ThrowsAsync<PostgresException>(() => command.ExecuteNonQueryAsync());
                Assert.Equal(sqlState, error.SqlState);
            }
            await using var weaken = new NpgsqlCommand($"""
                DROP TRIGGER {trigger.Name} ON {table};
                CREATE TRIGGER {trigger.Name} BEFORE UPDATE OR DELETE ON {table}
                    FOR EACH ROW EXECUTE FUNCTION {trigger.Function}();
                """, connection);
            await weaken.ExecuteNonQueryAsync();
            Assert.Contains(await CompareNativeAsync(connectionString, input),
                error => error == "effect_changed:" + table + "." + trigger.Name);
        }
    }

    private static async Task<IReadOnlyList<string>> CompareNativeAsync(string connectionString, CurrentSchemaBootstrapInput input)
    {
        await using var connection = new NpgsqlConnection(connectionString);
        await connection.OpenAsync();
        await using NpgsqlTransaction transaction = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead);
        await PgCurrentSchemaControlShape.EnsureApplyJournalAsync(connection, transaction, default);
        PgCurrentSchemaNativeObservation actual = await PgCurrentSchemaNativeObserver.ReadAsync(connection, transaction, default);
        CurrentSchemaCompletePhysicalProjection expected = CurrentSchemaCanonicalAuthority.ProjectOwnedTarget(input, SchemaProviderKind.PostgreSql);
        IReadOnlyList<string> errors = PgCurrentSchemaNativeObserver.Compare(expected, actual.Tables, actual.Effects);
        if (errors.Count != 0)
            Console.WriteLine("Complete native comparison differences:\n" + string.Join("\n", errors));
        await transaction.RollbackAsync();
        return errors;
    }
}
