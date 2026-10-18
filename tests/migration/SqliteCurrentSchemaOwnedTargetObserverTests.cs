using System.Data;
using System.Data.Common;

using FsusBlog.Contracts.Migration;

using Microsoft.Data.Sqlite;

using Xunit;

namespace FsusBlog.Migration.Tests;

/// <summary>
/// Real SQLite fixtures exercise the production reader on the original apply
/// session. They are source controls, not whole bootstrap or incarnation proof.
/// </summary>
public sealed class SqliteCurrentSchemaOwnedTargetObserverTests
{
    [Fact]
    public async Task EmptyDomainKeepsTheOriginalNativeConnectionTransactionAndConfiguration()
    {
        await using var fixture = await OwnedFixture.CreateAsync(string.Empty);
        SqliteCurrentSchemaCatalog before = await SqliteCurrentSchemaCatalogObserver.ReadAsync(
            fixture.Connection, fixture.Transaction, fixture.Token);
        SqliteCurrentOwnedSnapshot actual = await fixture.RequireEmptyAsync();
        Assert.Empty(actual.Complete.Objects);
        Assert.Empty(actual.Domain.Tables);
        Assert.Contains(actual.Complete.Tables, table => table.Name == "sqlite_schema");
        Assert.Equal(before.NamespaceFile, actual.Complete.NamespaceFile);
        Assert.Equal(before.SchemaVersion, actual.Complete.SchemaVersion);
        Assert.Equal(before.ForeignKeysEnabled, actual.Complete.ForeignKeysEnabled);
        Assert.Equal(before.CheckConstraintsIgnored, actual.Complete.CheckConstraintsIgnored);
        Assert.Equal(before.RecursiveTriggersEnabled, actual.Complete.RecursiveTriggersEnabled);
        Assert.Equal(before.QueryOnly, actual.Complete.QueryOnly);
        Assert.Same(fixture.Connection, fixture.Transaction.Connection);
        Assert.Equal(ConnectionState.Open, fixture.Connection.State);
        Assert.Equal(IsolationLevel.Serializable, fixture.Transaction.IsolationLevel);
    }

    [Fact]
    public async Task SoleControlIsExcludedOnlyAfterTheOriginalFullShapeValidator()
    {
        await using var fixture = await OwnedFixture.CreateAsync(string.Empty);
        await OfflineMigrationStateStore.EnsureApplyJournalAsync(
            fixture.Connection, fixture.Transaction, fixture.Token);
        SqliteCurrentOwnedSnapshot actual = await fixture.RequireEmptyAsync();
        Assert.Contains(actual.Complete.Objects, item => item.Kind == "table"
            && item.Name == OfflineMigrationStateStore.ApplyJournalTableName);
        Assert.NotEmpty(actual.Complete.Columns);
        Assert.NotEmpty(actual.Complete.Indexes);
        Assert.Empty(actual.Domain.Objects);
        Assert.Empty(actual.Domain.Tables);
        Assert.Empty(actual.Domain.Columns);
        Assert.Empty(actual.Domain.Indexes);
        Assert.Empty(actual.Domain.ForeignKeys);
        Assert.Same(fixture.Connection, fixture.Transaction.Connection);
    }

    [Theory]
    [InlineData("CREATE TABLE business(value TEXT)")]
    [InlineData("CREATE TABLE __fsus_schema_history(value TEXT)")]
    [InlineData("CREATE TABLE __fsus_schema_online_state(value TEXT)")]
    [InlineData("CREATE TABLE __fsus_schema_backfill_progress(value TEXT)")]
    [InlineData("CREATE TABLE __fsus_schema_offline_apply_journal_other(value TEXT)")]
    [InlineData("CREATE VIEW foreign_view AS SELECT 1 AS value")]
    [InlineData("CREATE TABLE business(value TEXT); CREATE INDEX foreign_index ON business(value)")]
    [InlineData("CREATE TABLE business(value TEXT); CREATE TRIGGER foreign_guard BEFORE UPDATE ON business BEGIN SELECT RAISE(ABORT, 'foreign'); END")]
    [InlineData("CREATE TABLE business(id INTEGER PRIMARY KEY AUTOINCREMENT); DROP TABLE business")]
    public async Task ForeignHistoryViewsIndexesTriggersAndAllocatorStateAreNotEmpty(string sql)
    {
        await using var fixture = await OwnedFixture.CreateAsync(sql);
        SqliteCurrentOwnedSnapshot measured = await fixture.ReadAsync();
        Assert.NotEmpty(measured.Domain.Objects);
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(
            () => fixture.RequireEmptyAsync());
        Assert.Equal("sqlite_current_owned_empty_business_domain_required", failure.Message);
        Assert.Same(fixture.Connection, fixture.Transaction.Connection);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task ControlNamedViewOrWrongTableCannotBeHidden(bool view)
    {
        string name = OfflineMigrationStateStore.ApplyJournalTableName;
        await using var fixture = await OwnedFixture.CreateAsync(view
            ? $"CREATE VIEW \"{name}\" AS SELECT 1 AS value"
            : $"CREATE TABLE \"{name}\"(value TEXT)");
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(
            () => fixture.RequireEmptyAsync());
        Assert.Equal("offline_apply_journal_physical_shape_changed", failure.Message);
    }

    [Theory]
    [InlineData("CREATE INDEX extra_control_index ON {0}(plan_digest)")]
    [InlineData("CREATE TRIGGER extra_control_guard BEFORE UPDATE ON {0} BEGIN SELECT RAISE(ABORT, 'extra'); END")]
    public async Task AddedControlEffectsFailBeforeAnyControlExclusion(string sql)
    {
        await using var fixture = await OwnedFixture.CreateAsync(string.Empty);
        await OfflineMigrationStateStore.EnsureApplyJournalAsync(
            fixture.Connection, fixture.Transaction, fixture.Token);
        await fixture.ExecuteAsync(string.Format(System.Globalization.CultureInfo.InvariantCulture,
            sql, "\"" + OfflineMigrationStateStore.ApplyJournalTableName + "\""));
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(
            () => fixture.ReadAsync());
        Assert.Equal("offline_apply_journal_physical_shape_changed", failure.Message);
    }

    [Fact]
    public async Task ValidControlDoesNotHideOtherObjectsOrTheirNativeDetails()
    {
        await using var fixture = await OwnedFixture.CreateAsync("""
            CREATE TABLE business(id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT CHECK(length(value) > 0));
            CREATE INDEX native_index ON business(value DESC) WHERE value IS NOT NULL;
            CREATE TRIGGER native_guard BEFORE UPDATE ON business BEGIN SELECT RAISE(FAIL, 'actual_message'); END;
            INSERT INTO business(id, value) VALUES(17, 'observed');
            """);
        await OfflineMigrationStateStore.EnsureApplyJournalAsync(
            fixture.Connection, fixture.Transaction, fixture.Token);
        SqliteCurrentOwnedSnapshot actual = await fixture.ReadAsync();
        Assert.Contains(actual.Domain.Objects, item => item.Name == "business" && item.Sql!.Contains("CHECK(length(value) > 0)"));
        Assert.Contains(actual.Domain.Objects, item => item.Name == "native_guard" && item.Sql!.Contains("RAISE(FAIL, 'actual_message')"));
        SqliteIndexMetadata index = Assert.Single(actual.Domain.Indexes.Where(item => item.Name == "native_index"));
        Assert.True(index.Partial);
        Assert.Contains(index.Columns, column => column.Key && column.Descending);
        Assert.Equal(17, Assert.Single(actual.Domain.SequenceValues).Value);
        Assert.DoesNotContain(actual.Domain.Columns, item => item.Table == OfflineMigrationStateStore.ApplyJournalTableName);
        Assert.Contains(actual.Complete.Columns, item => item.Table == OfflineMigrationStateStore.ApplyJournalTableName);
        await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.RequireEmptyAsync());
    }

    [Fact]
    public async Task ObservationDoesNotCommitOrDisposeTheCallersControlChanges()
    {
        await using var fixture = await OwnedFixture.CreateAsync(string.Empty);
        await OfflineMigrationStateStore.EnsureApplyJournalAsync(
            fixture.Connection, fixture.Transaction, fixture.Token);
        _ = await fixture.RequireEmptyAsync();
        await fixture.Transaction.RollbackAsync(fixture.Token);
        await using SqliteCommand command = fixture.Connection.CreateCommand();
        command.CommandText = "SELECT count(*) FROM main.sqlite_schema WHERE name=$name";
        command.Parameters.AddWithValue("$name", OfflineMigrationStateStore.ApplyJournalTableName);
        Assert.Equal(0L, await command.ExecuteScalarAsync(fixture.Token));
        Assert.Equal(ConnectionState.Open, fixture.Connection.State);
    }

    [Fact]
    public async Task CancellationIsNotConvertedIntoEmptyDomainSuccess()
    {
        await using var fixture = await OwnedFixture.CreateAsync(string.Empty);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            SqliteCurrentSchemaOwnedTargetObserver.RequireEmptyDomainAsync(
                fixture.Connection, fixture.Transaction, cancellation.Token));
        Assert.Same(fixture.Connection, fixture.Transaction.Connection);
    }

    [Fact]
    public async Task TransactionFromAnotherNativeConnectionIsRefused()
    {
        await using var fixture = await OwnedFixture.CreateAsync(string.Empty);
        await using var other = new SqliteConnection("Data Source=:memory:");
        await other.OpenAsync(fixture.Token);
        await using SqliteTransaction otherTransaction = other.BeginTransaction(IsolationLevel.Serializable);
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            SqliteCurrentSchemaOwnedTargetObserver.ReadOwnedDomainAsync(
                fixture.Connection, otherTransaction, fixture.Token));
        Assert.Equal("sqlite_current_catalog_native_serializable_session_required", failure.Message);
        Assert.Same(fixture.Connection, fixture.Transaction.Connection);
    }

    [Fact]
    public async Task CompletedTransactionIsNotReplacedWithANewTransaction()
    {
        await using var fixture = await OwnedFixture.CreateAsync(string.Empty);
        await fixture.Transaction.RollbackAsync(fixture.Token);
        InvalidOperationException failure = await Assert.ThrowsAsync<InvalidOperationException>(() => fixture.ReadAsync());
        Assert.Equal("sqlite_current_catalog_native_serializable_session_required", failure.Message);
        Assert.Equal(ConnectionState.Open, fixture.Connection.State);
    }

    private sealed class OwnedFixture : IAsyncDisposable
    {
        private readonly string _directory = Directory.CreateTempSubdirectory("fsusblog-sqlite-owned-domain-").FullName;
        private readonly CancellationTokenSource _cancellation = new(TimeSpan.FromSeconds(10));
        private OfflineMigrationApplyNativeSession? _session;
        private DbTransaction? _transaction;

        private OwnedFixture()
        {
            Connection = new SqliteConnection(new SqliteConnectionStringBuilder
            {
                DataSource = Path.Combine(_directory, "owned.db"),
                Pooling = false,
                DefaultTimeout = 1
            }.ToString());
        }

        internal SqliteConnection Connection
        {
            get;
        }
        internal DbTransaction Transaction => _transaction!;
        internal CancellationToken Token => _cancellation.Token;

        internal static async Task<OwnedFixture> CreateAsync(string sql)
        {
            var fixture = new OwnedFixture();
            try
            {
                await fixture.Connection.OpenAsync(fixture.Token);
                if (sql.Length != 0)
                {
                    await using SqliteCommand command = fixture.Connection.CreateCommand();
                    command.CommandText = sql;
                    await command.ExecuteNonQueryAsync(fixture.Token);
                }
                fixture._session = new(fixture.Connection, CurrentSchemaProviderKind.Sqlite);
                Assert.True(await fixture._session.AcquireAsync(fixture.Token));
                fixture._transaction = await fixture._session.BeginAsync(fixture.Token);
                return fixture;
            }
            catch
            {
                await fixture.DisposeAsync();
                throw;
            }
        }

        internal Task<SqliteCurrentOwnedSnapshot> ReadAsync()
            => SqliteCurrentSchemaOwnedTargetObserver.ReadOwnedDomainAsync(Connection, Transaction, Token);

        internal Task<SqliteCurrentOwnedSnapshot> RequireEmptyAsync()
            => SqliteCurrentSchemaOwnedTargetObserver.RequireEmptyDomainAsync(Connection, Transaction, Token);

        internal async Task ExecuteAsync(string sql)
        {
            await using DbCommand command = OfflineMigrationStateStore.NativeCommand(Connection, Transaction, sql);
            await command.ExecuteNonQueryAsync(Token);
        }

        public async ValueTask DisposeAsync()
        {
            try
            {
                if (_transaction is not null)
                {
                    await _transaction.DisposeAsync();
                }
            }
            finally
            {
                try
                {
                    if (_session?.CleanupRequired == true)
                    {
                        await _session.ReleaseAsync(Token);
                    }
                }
                finally
                {
                    try
                    {
                        await Connection.DisposeAsync();
                    }
                    finally
                    {
                        _cancellation.Dispose();
                        Directory.Delete(_directory, recursive: true);
                    }
                }
            }
        }
    }
}
