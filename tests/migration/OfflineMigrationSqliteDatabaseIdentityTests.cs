using System.Data;

using Microsoft.Data.Sqlite;
using Xunit;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration.Tests;

/// <summary>
/// Genuine isolated SQLite identity controls when run with the pinned native FILESTAT
/// capability. Missing capability must fail positives, not skip or fabricate an inode.
/// Capability-refusal rows alone are not database/native qualification.
/// </summary>
public sealed class OfflineMigrationSqliteDatabaseIdentityTests
{
    [Fact]
    public async Task HeldMainFileProducesItsActualPhysicalIdentityWithoutClosingTheNativeDescriptor()
    {
        using var fixture = new IdentityFixture();
        await using SqliteConnection connection = await fixture.OpenAsync();
        await using SqliteTransaction transaction = connection.BeginTransaction(IsolationLevel.Serializable, deferred: true);
        using var cancellation = new CancellationTokenSource();
        await EstablishReadAsync(connection, transaction, cancellation.Token);
        using var identity = await OfflineMigrationSqliteDatabaseIdentity.CaptureAsync(connection, transaction, cancellation.Token);
        Assert.Equal(CurrentSchemaProviderKind.Sqlite, identity.Database.Provider);
        Assert.StartsWith("sqlite:", identity.Database.InstanceId);
        Assert.Equal(fixture.DatabasePath, identity.Database.DatabaseId);
        await identity.ValidateAsync(connection, transaction, cancellation.Token);
        identity.Dispose();
        // Disposing the non-owning identity wrapper must not close SQLite's held FD.
        Assert.Equal(1L, await CountAsync(connection, transaction, cancellation.Token));
        Assert.Equal(ConnectionState.Open, connection.State);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task SamePathAndBytesCannotHideReplacementOfTheHeldLeafOrAncestor(bool replaceAncestor)
    {
        using var fixture = new IdentityFixture();
        // Capture bytes before SQLite acquires its read lock. Never reopen/close the
        // original leaf during a held transaction, including in the fixture itself.
        byte[] originalBytes = File.ReadAllBytes(fixture.DatabasePath);
        await using SqliteConnection connection = await fixture.OpenAsync();
        await using SqliteTransaction transaction = connection.BeginTransaction(IsolationLevel.Serializable, deferred: true);
        using var cancellation = new CancellationTokenSource();
        await EstablishReadAsync(connection, transaction, cancellation.Token);
        using var identity = await OfflineMigrationSqliteDatabaseIdentity.CaptureAsync(connection, transaction, cancellation.Token);
        if (replaceAncestor)
        {
            Directory.Move(fixture.DatabaseDirectory, fixture.DatabaseDirectory + ".original");
            Directory.CreateDirectory(fixture.DatabaseDirectory);
        }
        else
        {
            File.Move(fixture.DatabasePath, fixture.DatabasePath + ".original");
        }
        File.WriteAllBytes(fixture.DatabasePath, originalBytes);
        Assert.Equal(originalBytes, File.ReadAllBytes(fixture.DatabasePath));
        // SQLite still reads its original held database. Its name stayed identical;
        // only the actual FD/path identity predicate can refuse the substitution.
        Assert.Equal(1L, await CountAsync(connection, transaction, cancellation.Token));
        await Assert.ThrowsAsync<InvalidOperationException>(() => identity.ValidateAsync(connection, transaction, cancellation.Token));
    }

    [Fact]
    public async Task UnrelatedDirectoryTimestampChangeDoesNotInvalidateTheHeldIncarnation()
    {
        using var fixture = new IdentityFixture();
        await using SqliteConnection connection = await fixture.OpenAsync();
        await using SqliteTransaction transaction = connection.BeginTransaction(IsolationLevel.Serializable, deferred: true);
        using var cancellation = new CancellationTokenSource();
        await EstablishReadAsync(connection, transaction, cancellation.Token);
        using var identity = await OfflineMigrationSqliteDatabaseIdentity.CaptureAsync(connection, transaction, cancellation.Token);
        File.WriteAllText(Path.Combine(fixture.DatabaseDirectory, "unrelated-note"), "not the database");
        await identity.ValidateAsync(connection, transaction, cancellation.Token);
        Assert.Equal(identity.Database, await OfflineMigrationSqliteDatabaseIdentity.ReadAsync(connection, transaction, cancellation.Token));
    }

    [Fact]
    public async Task CapturedIdentityCannotBeTransferredToAnotherActualConnection()
    {
        using var fixture = new IdentityFixture();
        await using SqliteConnection first = await fixture.OpenAsync();
        await using SqliteConnection second = await fixture.OpenAsync();
        await using SqliteTransaction firstTransaction = first.BeginTransaction(IsolationLevel.Serializable, deferred: true);
        await using SqliteTransaction secondTransaction = second.BeginTransaction(IsolationLevel.Serializable, deferred: true);
        using var cancellation = new CancellationTokenSource();
        await EstablishReadAsync(first, firstTransaction, cancellation.Token);
        await EstablishReadAsync(second, secondTransaction, cancellation.Token);
        using var identity = await OfflineMigrationSqliteDatabaseIdentity.CaptureAsync(first, firstTransaction, cancellation.Token);
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => identity.ValidateAsync(second, secondTransaction, cancellation.Token));
        Assert.Equal("offline_sqlite_identity_native_database_changed", error.Message);
    }

    [Fact]
    public async Task DatabaseTimestampOnlyChangeDoesNotInventANewIncarnation()
    {
        using var fixture = new IdentityFixture();
        await using SqliteConnection connection = await fixture.OpenAsync();
        await using SqliteTransaction transaction = connection.BeginTransaction(IsolationLevel.Serializable, deferred: true);
        using var cancellation = new CancellationTokenSource();
        await EstablishReadAsync(connection, transaction, cancellation.Token);
        using var identity = await OfflineMigrationSqliteDatabaseIdentity.CaptureAsync(connection, transaction, cancellation.Token);
        DateTime previous = File.GetLastWriteTimeUtc(fixture.DatabasePath);
        File.SetLastWriteTimeUtc(fixture.DatabasePath, previous.AddYears(-1));
        Assert.NotEqual(previous, File.GetLastWriteTimeUtc(fixture.DatabasePath));
        await identity.ValidateAsync(connection, transaction, cancellation.Token);
        Assert.Equal(1L, await CountAsync(connection, transaction, cancellation.Token));
    }

    [Fact]
    public async Task ClosedOrCancelledConnectionCannotSupplyAReceiptIdentity()
    {
        using var fixture = new IdentityFixture();
        await using SqliteConnection connection = await fixture.OpenAsync();
        await using SqliteTransaction transaction = connection.BeginTransaction(IsolationLevel.Serializable, deferred: true);
        using var cancellation = new CancellationTokenSource();
        await EstablishReadAsync(connection, transaction, cancellation.Token);
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(
            () => OfflineMigrationSqliteDatabaseIdentity.ReadAsync(connection, transaction, cancellation.Token));
        connection.Close();
        using var live = new CancellationTokenSource();
        await Assert.ThrowsAsync<InvalidOperationException>(
            () => OfflineMigrationSqliteDatabaseIdentity.ReadAsync(connection, transaction, live.Token));
    }

    [Fact]
    public async Task InMemoryConnectionDoesNotBecomeAPersistentMainDatabase()
    {
        await using var connection = new SqliteConnection("Data Source=:memory:;Pooling=False");
        await connection.OpenAsync();
        await using SqliteTransaction transaction = connection.BeginTransaction(IsolationLevel.Serializable, deferred: true);
        using var cancellation = new CancellationTokenSource();
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(
            () => OfflineMigrationSqliteDatabaseIdentity.ReadAsync(connection, transaction, cancellation.Token));
        Assert.Equal("offline_sqlite_identity_persistent_main_required", error.Message);
    }

    [Theory]
    [InlineData(12, 0)]
    [InlineData(-1, 0)]
    [InlineData(0, 7)]
    public void MissingOrUnknownNativeCapabilityCannotBecomeAnIdentity(int result, int stringError)
    {
        // Exercise the same pure refusal predicate, not an injected native FD or JSON.
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(
            () => OfflineMigrationSqliteDatabaseIdentity.RequireActualFileStatCapability(result, stringError));
        Assert.Equal("offline_sqlite_identity_filestat_capability_unavailable", error.Message);
    }

    private static async Task EstablishReadAsync(SqliteConnection connection, SqliteTransaction transaction, CancellationToken token)
    {
        await using SqliteCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT COUNT(*) FROM main.sqlite_schema";
        _ = await command.ExecuteScalarAsync(token);
    }

    private static async Task<long> CountAsync(SqliteConnection connection, SqliteTransaction transaction, CancellationToken token)
    {
        await using SqliteCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "SELECT COUNT(*) FROM identity_probe";
        return Convert.ToInt64(await command.ExecuteScalarAsync(token));
    }

    private sealed class IdentityFixture : IDisposable
    {
        private readonly string _root = Path.Combine(Path.GetTempPath(), "fsusblog-sqlite-identity-" + Guid.NewGuid().ToString("N"));
        internal string DatabaseDirectory => Path.Combine(_root, "database");
        internal string DatabasePath => Path.Combine(DatabaseDirectory, "source.sqlite");

        internal IdentityFixture()
        {
            Directory.CreateDirectory(DatabaseDirectory);
            using var connection = new SqliteConnection(new SqliteConnectionStringBuilder
            {
                DataSource = DatabasePath,
                Pooling = false
            }.ConnectionString);
            connection.Open();
            using SqliteCommand command = connection.CreateCommand();
            command.CommandText = "CREATE TABLE identity_probe(id INTEGER PRIMARY KEY); INSERT INTO identity_probe VALUES (1)";
            command.ExecuteNonQuery();
        }

        internal async Task<SqliteConnection> OpenAsync()
        {
            var connection = new SqliteConnection(new SqliteConnectionStringBuilder
            {
                DataSource = DatabasePath,
                Mode = SqliteOpenMode.ReadOnly,
                Cache = SqliteCacheMode.Private,
                Pooling = false
            }.ConnectionString);
            try
            {
                await connection.OpenAsync();
                return connection;
            }
            catch
            {
                await connection.DisposeAsync();
                throw;
            }
        }

        public void Dispose() => Directory.Delete(_root, recursive: true);
    }
}
