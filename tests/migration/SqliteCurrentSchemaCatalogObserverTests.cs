using System.Data;

using Microsoft.Data.Sqlite;
using Xunit;

namespace FsusBlog.Migration.Tests;

/// <summary>
/// Source fixtures invoke the actual SQLite provider and production catalog observer.
/// An isolated in-memory fixture is not production incarnation or whole-bootstrap proof.
/// </summary>
public sealed class SqliteCurrentSchemaCatalogObserverTests
{
    [Fact]
    public async Task EmptyMainIsObservedWithoutInventingTargetOrIncarnation()
    {
        await using var fixture = await CatalogFixture.CreateAsync("");
        SqliteCurrentSchemaCatalog actual = await fixture.ReadAsync();
        Assert.Empty(actual.Objects);
        Assert.Empty(actual.Columns);
        Assert.Empty(actual.Indexes);
        Assert.Empty(actual.ForeignKeys);
        Assert.Empty(actual.SequenceValues);
        Assert.Equal("", actual.NamespaceFile);
        Assert.Contains(actual.Tables, table => table.Name == "sqlite_schema");
        Assert.Equal("UTF-8", actual.Encoding);
    }

    [Fact]
    public async Task PhysicalColumnsConstraintsAndTriggerBodiesAreNotDropped()
    {
        await using var fixture = await CatalogFixture.CreateAsync("""
            CREATE TABLE parent(id INTEGER PRIMARY KEY, code TEXT UNIQUE);
            CREATE TABLE child(
                id INTEGER PRIMARY KEY,
                parent_id INTEGER NOT NULL REFERENCES parent(id) ON DELETE CASCADE,
                label TEXT COLLATE NOCASE DEFAULT 'pending' CHECK(length(label) > 0),
                derived TEXT GENERATED ALWAYS AS (upper(label)) STORED);
            CREATE TRIGGER immutable_child BEFORE UPDATE ON child
                BEGIN SELECT RAISE(ABORT, 'immutable'); END;
            CREATE VIEW child_labels AS SELECT label FROM child;
            """);
        SqliteCurrentSchemaCatalog actual = await fixture.ReadAsync();
        SqliteColumnMetadata label = Assert.Single(actual.Columns.Where(column => column.Table == "child" && column.Name == "label"));
        Assert.Equal("TEXT", label.DeclaredType);
        Assert.Equal("'pending'", label.DefaultSql);
        Assert.Contains(actual.Columns, column => column.Table == "child" && column.Name == "derived" && column.HiddenKind == 3);
        SqliteForeignKeyMetadata foreignKey = Assert.Single(actual.ForeignKeys);
        Assert.Equal("parent", foreignKey.TargetTable);
        Assert.Equal("parent_id", foreignKey.SourceColumn);
        Assert.Equal("CASCADE", foreignKey.OnDelete);
        Assert.Contains(actual.Objects, item => item.Kind == "table" && item.Name == "child" && item.Sql!.Contains("CHECK(length(label) > 0)"));
        Assert.Contains(actual.Objects, item => item.Kind == "trigger" && item.Sql!.Contains("RAISE(ABORT, 'immutable')"));
        Assert.Contains(actual.Objects, item => item.Kind == "view" && item.Name == "child_labels");
        Assert.Empty(actual.ForeignKeyViolations);
    }

    [Fact]
    public async Task ExpressionPartialDescendingAndAuxiliaryIndexFactsAreMeasured()
    {
        await using var fixture = await CatalogFixture.CreateAsync("""
            CREATE TABLE item(id INTEGER PRIMARY KEY, name TEXT);
            CREATE UNIQUE INDEX idx_expression ON item(lower(name) COLLATE NOCASE DESC) WHERE name IS NOT NULL;
            """);
        SqliteCurrentSchemaCatalog actual = await fixture.ReadAsync();
        SqliteIndexMetadata index = Assert.Single(actual.Indexes);
        Assert.True(index.Unique);
        Assert.True(index.Partial);
        Assert.Equal("c", index.Origin);
        Assert.Contains(index.Columns, column => column.Key && column.ColumnId == -2 && column.Name is null
            && column.Descending && column.Collation == "NOCASE");
        Assert.Contains(index.Columns, column => !column.Key && column.ColumnId == -1);
        Assert.Contains(actual.Objects, item => item.Name == "idx_expression" && item.Sql!.Contains("WHERE name IS NOT NULL"));
    }

    [Fact]
    public async Task StrictWithoutRowIdAndGeneratedColumnsKeepTheirActualFlags()
    {
        await using var fixture = await CatalogFixture.CreateAsync("""
            CREATE TABLE typed(id INTEGER PRIMARY KEY, value TEXT,
                generated TEXT GENERATED ALWAYS AS (upper(value)) VIRTUAL) STRICT, WITHOUT ROWID;
            """);
        SqliteCurrentSchemaCatalog actual = await fixture.ReadAsync();
        SqliteTableMetadata table = Assert.Single(actual.Tables.Where(item => item.Name == "typed"));
        Assert.True(table.Strict);
        Assert.True(table.WithoutRowId);
        Assert.Equal(3, table.ColumnCount);
        Assert.Contains(actual.Columns, column => column.Table == "typed" && column.HiddenKind == 2);
        Assert.Contains(actual.Indexes, index => index.Table == "typed" && index.Origin == "pk");
    }

    [Fact]
    public async Task RealAutoincrementWatermarkIsMeasuredNotSynthesizedAsSequenceRecipe()
    {
        await using var fixture = await CatalogFixture.CreateAsync("""
            CREATE TABLE item(id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT);
            INSERT INTO item(id, value) VALUES(17, 'actual');
            DELETE FROM item;
            """);
        SqliteSequenceValue sequence = Assert.Single((await fixture.ReadAsync()).SequenceValues);
        Assert.Equal("item", sequence.Table);
        Assert.Equal(17, sequence.Value);
    }

    [Fact]
    public async Task ViolatedForeignKeyIsMeasuredRatherThanTurnedIntoVerifiedStatus()
    {
        await using var fixture = await CatalogFixture.CreateAsync("""
            PRAGMA foreign_keys = OFF;
            CREATE TABLE parent(id INTEGER PRIMARY KEY);
            CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id));
            INSERT INTO child VALUES(3, 999);
            """);
        SqliteCurrentSchemaCatalog actual = await fixture.ReadAsync();
        Assert.False(actual.ForeignKeysEnabled);
        SqliteForeignKeyViolation violation = Assert.Single(actual.ForeignKeyViolations);
        Assert.Equal("child", violation.Table);
        Assert.Equal(3L, violation.RowId);
        Assert.Equal("parent", violation.Parent);
    }

    [Fact]
    public async Task CallerTransactionAndPragmasAreNotCommittedOrChanged()
    {
        await using var fixture = await CatalogFixture.CreateAsync("CREATE TABLE item(id INTEGER PRIMARY KEY);");
        await fixture.ExecuteAsync("INSERT INTO item VALUES(7)", inTransaction: true);
        SqliteCurrentSchemaCatalog actual = await fixture.ReadAsync();
        Assert.False(actual.QueryOnly);
        Assert.Same(fixture.Connection, fixture.Transaction.Connection);
        await fixture.ExecuteAsync("INSERT INTO item VALUES(8)", inTransaction: true);
        await fixture.Transaction.RollbackAsync();
        await using SqliteCommand command = fixture.Connection.CreateCommand();
        command.CommandText = "SELECT COUNT(*) FROM item";
        Assert.Equal(0L, await command.ExecuteScalarAsync());
    }

    [Fact]
    public async Task NamesAreBoundAsNativeParametersNotExecutableSql()
    {
        await using var fixture = await CatalogFixture.CreateAsync("""
            CREATE TABLE "a'); DROP TABLE sentinel;--"("odd'column" TEXT);
            CREATE TABLE sentinel(id INTEGER PRIMARY KEY);
            """);
        SqliteCurrentSchemaCatalog actual = await fixture.ReadAsync();
        Assert.Contains(actual.Columns, column => column.Table == "a'); DROP TABLE sentinel;--" && column.Name == "odd'column");
        Assert.Contains(actual.Tables, table => table.Name == "sentinel");
    }

    [Fact]
    public async Task SameColumnShapeWithDifferentCheckEffectsRemainsDistinguishable()
    {
        await using var positive = await CatalogFixture.CreateAsync("CREATE TABLE item(value INTEGER CHECK(value > 0));");
        await using var negative = await CatalogFixture.CreateAsync("CREATE TABLE item(value INTEGER CHECK(value < 0));");
        SqliteCurrentSchemaCatalog first = await positive.ReadAsync();
        SqliteCurrentSchemaCatalog second = await negative.ReadAsync();
        Assert.Equal(first.Columns.ToArray(), second.Columns.ToArray());
        Assert.NotEqual(Assert.Single(first.Objects).Sql, Assert.Single(second.Objects).Sql);
    }

    [Theory]
    [InlineData("ATTACH DATABASE ':memory:' AS extra;")]
    [InlineData("CREATE TEMP TABLE hidden(id INTEGER);")]
    public async Task NonMainNamespacesAreRefusedNotSilentlySkipped(string setup)
    {
        await using var fixture = await CatalogFixture.CreateAsync(setup);
        await AssertCodeAsync("sqlite_current_catalog_single_main_namespace_required", () => fixture.ReadAsync());
    }

    [Fact]
    public async Task VirtualAndShadowTablesAreRefusedBeforeExtensionIntrospection()
    {
        await using var fixture = await CatalogFixture.CreateAsync("CREATE VIRTUAL TABLE search USING fts5(content);");
        await AssertCodeAsync("sqlite_current_catalog_table_kind_not_supported", () => fixture.ReadAsync());
    }

    [Fact]
    public async Task OversizeOriginalMetadataIsRefusedInsteadOfReturningTruncatedFacts()
    {
        string value = new('x', OfflineMigrationSourceObserver.MaximumCellCharacters + 1);
        await using var fixture = await CatalogFixture.CreateAsync($"CREATE TABLE item(value TEXT DEFAULT '{value}');");
        await AssertCodeAsync("sqlite_current_catalog_metadata_budget_exceeded", () => fixture.ReadAsync());
    }

    [Fact]
    public async Task CompleteInventoryCannotExceedOriginalAggregateRowBudget()
    {
        string setup = string.Join('\n', Enumerable.Range(0, OfflineMigrationSourceObserver.MaximumMetadataRows / 2)
            .Select(index => $"CREATE TABLE t{index}(id INTEGER);"));
        await using var fixture = await CatalogFixture.CreateAsync(setup);
        await AssertCodeAsync("sqlite_current_catalog_metadata_budget_exceeded", () => fixture.ReadAsync());
    }

    [Fact]
    public async Task DifferentConnectionTransactionIsRefusedByRealNativeSessionCheck()
    {
        await using var first = await CatalogFixture.CreateAsync("");
        await using var second = await CatalogFixture.CreateAsync("");
        await AssertCodeAsync("sqlite_current_catalog_native_serializable_session_required", () =>
            SqliteCurrentSchemaCatalogObserver.ReadAsync(first.Connection, second.Transaction, CancellationToken.None));
    }

    [Fact]
    public async Task ClosedOriginalTransactionIsRefusedWithoutOpeningReplacement()
    {
        await using var fixture = await CatalogFixture.CreateAsync("");
        await fixture.Transaction.RollbackAsync();
        await AssertCodeAsync("sqlite_current_catalog_native_serializable_session_required", () => fixture.ReadAsync());
    }

    [Fact]
    public async Task CancelledCallerIsRejectedBeforeAnyCatalogRead()
    {
        await using var fixture = await CatalogFixture.CreateAsync("");
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            SqliteCurrentSchemaCatalogObserver.ReadAsync(fixture.Connection, fixture.Transaction, cancellation.Token));
        Assert.Same(fixture.Connection, fixture.Transaction.Connection);
    }

    [Theory]
    [InlineData("seq = 'garbage'")]
    [InlineData("seq = 1.5")]
    [InlineData("seq = NULL")]
    [InlineData("name = 123")]
    public async Task AutoincrementStorageTypesAreRejectedBeforeNativeNumericCoercion(string mutation)
    {
        await using var fixture = await CatalogFixture.CreateAsync($"""
            CREATE TABLE item(id INTEGER PRIMARY KEY AUTOINCREMENT);
            INSERT INTO item VALUES(1);
            UPDATE sqlite_sequence SET {mutation};
            """);
        await AssertCodeAsync("sqlite_current_catalog_sequence_storage_type_invalid", () => fixture.ReadAsync());
    }

    [Theory]
    [InlineData(long.MaxValue)]
    [InlineData(-3L)]
    public async Task NativeIntegerSequenceFactsRemainExactWithoutInventingExpectedValues(long value)
    {
        await using var fixture = await CatalogFixture.CreateAsync("""
            CREATE TABLE item(id INTEGER PRIMARY KEY AUTOINCREMENT);
            INSERT INTO item VALUES(1);
            """);
        await using (SqliteCommand command = fixture.Connection.CreateCommand())
        {
            command.Transaction = fixture.Transaction;
            command.CommandText = "UPDATE sqlite_sequence SET seq = $value";
            command.Parameters.AddWithValue("$value", value);
            await command.ExecuteNonQueryAsync();
        }
        SqliteSequenceValue actual = Assert.Single((await fixture.ReadAsync()).SequenceValues);
        Assert.Equal("item", actual.Table);
        Assert.Equal(value, actual.Value);
    }

    private static async Task AssertCodeAsync(string expected, Func<Task<SqliteCurrentSchemaCatalog>> action)
    {
        InvalidOperationException actual = await Assert.ThrowsAsync<InvalidOperationException>(action);
        Assert.Equal(expected, actual.Message);
    }

    private sealed class CatalogFixture(SqliteConnection connection, SqliteTransaction transaction) : IAsyncDisposable
    {
        internal SqliteConnection Connection { get; } = connection;
        internal SqliteTransaction Transaction { get; } = transaction;

        internal static async Task<CatalogFixture> CreateAsync(string setup)
        {
            var connection = new SqliteConnection("Data Source=:memory:;Pooling=False");
            try
            {
                await connection.OpenAsync();
                if (setup.Length != 0)
                {
                    await using SqliteCommand command = connection.CreateCommand();
                    command.CommandText = setup;
                    await command.ExecuteNonQueryAsync();
                }
                return new(connection, connection.BeginTransaction(IsolationLevel.Serializable, deferred: true));
            }
            catch
            {
                await connection.DisposeAsync();
                throw;
            }
        }

        internal Task<SqliteCurrentSchemaCatalog> ReadAsync() =>
            SqliteCurrentSchemaCatalogObserver.ReadAsync(Connection, Transaction, CancellationToken.None);

        internal async Task ExecuteAsync(string sql, bool inTransaction)
        {
            await using SqliteCommand command = Connection.CreateCommand();
            command.Transaction = inTransaction ? Transaction : null;
            command.CommandText = sql;
            await command.ExecuteNonQueryAsync();
        }

        public async ValueTask DisposeAsync()
        {
            try
            {
                await Transaction.DisposeAsync();
            }
            finally
            {
                await Connection.DisposeAsync();
            }
        }
    }
}
