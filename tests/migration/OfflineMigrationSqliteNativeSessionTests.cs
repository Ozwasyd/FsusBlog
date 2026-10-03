using System.Data;
using System.Data.Common;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using Microsoft.Data.Sqlite;
using Xunit;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration.Tests;

/// <summary>
/// Uses a genuinely owned temporary SQLite database to test the native read resource port.
/// Synthetic callback payloads are explicitly not source fingerprints or migration proofs.
/// MySQL/PostgreSQL semantic provider, backup and restore acceptance remain independent.
/// </summary>
public sealed class OfflineMigrationSqliteNativeSessionTests
{
    [Fact]
    public async Task OwnedNativeFileIsReadInTheSameReadOnlySerializableTransactionThenClosed()
    {
        using var fixture = new SourceFixture();
        using var cancellation = new CancellationTokenSource();
        SqliteConnection? actualConnection = null;
        SqliteTransaction? actualTransaction = null;
        long count = -1;
        OfflineMigrationSourceObservation marker = FixtureOnlyObservation();
        OfflineMigrationSourceObservation returned = await OfflineMigrationSqliteNativeSession.ObserveAsync(
            fixture.ConnectionString, async (connection, transaction, token) =>
            {
                actualConnection = Assert.IsType<SqliteConnection>(connection);
                actualTransaction = Assert.IsType<SqliteTransaction>(transaction);
                Assert.Same(actualConnection, actualTransaction.Connection);
                Assert.Equal(IsolationLevel.Serializable, actualTransaction.IsolationLevel);
                using SqliteCommand command = actualConnection.CreateCommand();
                command.Transaction = actualTransaction;
                command.CommandText = "SELECT COUNT(*) FROM native_session_test_probe";
                count = Convert.ToInt64(await command.ExecuteScalarAsync(token), CultureInfo.InvariantCulture);
                return marker;
            }, cancellation.Token);
        Assert.Equal(1, count);
        Assert.Same(marker, returned);
        Assert.NotNull(actualConnection);
        Assert.Equal(ConnectionState.Closed, actualConnection.State);
        Assert.Null(actualConnection.Handle);
        Assert.Equal(1, fixture.CountRows());
    }

    [Fact]
    public async Task ActualWriteAttemptIsRefusedAndTheOwnedDatabaseIsUnchanged()
    {
        using var fixture = new SourceFixture();
        using var cancellation = new CancellationTokenSource();
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OfflineMigrationSqliteNativeSession.ObserveAsync(fixture.ConnectionString,
                async (connection, transaction, token) =>
                {
                    using DbCommand command = connection.CreateCommand();
                    command.Transaction = transaction;
                    command.CommandText = "DELETE FROM native_session_test_probe";
                    await command.ExecuteNonQueryAsync(token);
                    throw new InvalidOperationException("write must be rejected");
                }, cancellation.Token));
        Assert.Equal("offline_source_sqlite_native_operation_failed", error.Message);
        Assert.Null(error.InnerException);
        Assert.Equal(1, fixture.CountRows());
    }

    [Fact]
    public async Task UnknownSourcePayloadIsNotPromotedByTheResourcePort()
    {
        using var fixture = new SourceFixture();
        using var cancellation = new CancellationTokenSource();
        OfflineMigrationSourceObservation marker = FixtureOnlyObservation();
        OfflineMigrationSourceObservation returned = await OfflineMigrationSqliteNativeSession.ObserveAsync(
            fixture.ConnectionString, (_, _, _) => Task.FromResult(marker), cancellation.Token);
        Assert.Equal("native-session-fixture-only-not-a-source-extractor", returned.ExtractorId);
        // The original registry rejects this unknown extractor/catalog. A successful resource
        // port call must preserve caller bytes, not silently supply a known baseline or proof.
        Assert.Same(marker, returned);
    }

    [Fact]
    public async Task CancellationBeforeNativeCreationDoesNotOpenTheProvidedPath()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            OfflineMigrationSqliteNativeSession.ObserveAsync("not parsed after cancellation", NeverObserve, cancellation.Token));
    }

    [Fact]
    public async Task MissingOperationCancellationContextIsRefused()
    {
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OfflineMigrationSqliteNativeSession.ObserveAsync("not parsed without context", NeverObserve, CancellationToken.None));
        Assert.Equal("offline_source_native_operation_context_required", error.Message);
    }

    [Theory]
    [InlineData("Data Source=:memory:")]
    [InlineData("Data Source=")]
    public async Task TransientDatabaseCannotStandInForTheBackupBoundPersistentSource(string settings)
    {
        using var cancellation = new CancellationTokenSource();
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OfflineMigrationSqliteNativeSession.ObserveAsync(settings, NeverObserve, cancellation.Token));
        Assert.Equal("offline_source_sqlite_persistent_source_required", error.Message);
        Assert.Null(error.InnerException);
    }

    [Fact]
    public async Task InvalidPrivateSettingsDoNotLeakPasswordOrDriverText()
    {
        using var cancellation = new CancellationTokenSource();
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OfflineMigrationSqliteNativeSession.ObserveAsync(
                "Password=private-fixture-not-for-errors;UnsupportedNativeSessionFixtureOption=1", NeverObserve, cancellation.Token));
        Assert.Equal("offline_source_sqlite_native_operation_failed", error.Message);
        Assert.Null(error.InnerException);
    }

    private static Task<OfflineMigrationSourceObservation> NeverObserve(
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
        => throw new InvalidOperationException("observer must not run before argument refusal");

    [Fact]
    public async Task CallbackCannotReplaceTheHeldDatabaseUnderItsUnchangedNativeFilename()
    {
        using var fixture = new SourceFixture();
        string path = new SqliteConnectionStringBuilder(fixture.ConnectionString).DataSource;
        byte[] originalBytes = File.ReadAllBytes(path);
        bool callbackEntered = false;
        using var cancellation = new CancellationTokenSource();
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OfflineMigrationSqliteNativeSession.ObserveAsync(fixture.ConnectionString, (_, _, _) =>
            {
                callbackEntered = true;
                File.Move(path, path + ".original");
                File.WriteAllBytes(path, originalBytes);
                Assert.Equal(originalBytes, File.ReadAllBytes(path));
                return Task.FromResult(FixtureOnlyObservation());
            }, cancellation.Token));
        Assert.Equal("offline_source_sqlite_native_operation_failed", error.Message);
        Assert.Null(error.InnerException);
        Assert.True(callbackEntered, "Missing native capability is not execution of the replacement counterexample.");
    }

    private static OfflineMigrationSourceObservation FixtureOnlyObservation()
        => new(new(CurrentSchemaProviderKind.Sqlite, "not-an-admitted-instance", "not-a-source-identity"),
            "native-session-fixture-only-not-a-source-extractor", "fixture",
            [new("fixture.only", "not-known-schema")], [], [],
            Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes("not-full-content-evidence"))));

    private sealed class SourceFixture : IDisposable
    {
        private readonly string _directory = Path.Combine(Path.GetTempPath(), $"fsusblog-sqlite-native-fixture-{Guid.NewGuid():N}");

        internal string ConnectionString { get; }

        internal SourceFixture()
        {
            Directory.CreateDirectory(_directory);
            ConnectionString = new SqliteConnectionStringBuilder
            {
                DataSource = Path.Combine(_directory, "source.db"),
                Mode = SqliteOpenMode.ReadWriteCreate,
                Pooling = false
            }.ConnectionString;
            using var connection = new SqliteConnection(ConnectionString);
            connection.Open();
            using SqliteCommand command = connection.CreateCommand();
            command.CommandText = "CREATE TABLE native_session_test_probe(value INTEGER NOT NULL); INSERT INTO native_session_test_probe VALUES(1);";
            command.ExecuteNonQuery();
        }

        internal long CountRows()
        {
            var settings = new SqliteConnectionStringBuilder(ConnectionString)
            {
                Mode = SqliteOpenMode.ReadOnly,
                Pooling = false
            };
            using var connection = new SqliteConnection(settings.ConnectionString);
            connection.Open();
            using SqliteCommand command = connection.CreateCommand();
            command.CommandText = "SELECT COUNT(*) FROM native_session_test_probe";
            return Convert.ToInt64(command.ExecuteScalar(), CultureInfo.InvariantCulture);
        }

        public void Dispose()
        {
            Directory.Delete(_directory, recursive: true);
        }
    }

    [Fact]
    public void RawConnectionLabelsCannotConstructAnOwnedContext()
    {
        System.Reflection.ConstructorInfo constructor = Assert.Single(
            typeof(OfflineMigrationSqliteNativeSession.OwnedReadContext).GetConstructors(
                System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic));
        Assert.True(constructor.IsPrivate);
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationSqliteNativeSession.OwnedReadContext.CreateForOwner(new
            {
                OriginalConnection = "caller-label",
                OriginalTransaction = "caller-label",
                Database = "caller-identity"
            }));
        Assert.Equal("offline_source_sqlite_owned_read_owner_required", error.Message);
    }

    [Fact]
    public async Task GenericCallbackBorrowsTheOriginalSessionAndSnapshotWithoutPromotingItsResult()
    {
        using var fixture = new SourceFixture();
        using var creator = new CancellationTokenSource();
        object marker = new();
        bool callbackEntered = false;
        SqliteConnection? original = null;
        object result = await OfflineMigrationSqliteNativeSession.ObserveOwnedReadAsync(
            fixture.ConnectionString, async (context, token) =>
            {
                callbackEntered = true;
                original = Assert.IsType<SqliteConnection>(context.OriginalConnection);
                var transaction = Assert.IsType<SqliteTransaction>(context.OriginalTransaction);
                Assert.Same(original, transaction.Connection);
                Assert.Equal(IsolationLevel.Serializable, transaction.IsolationLevel);
                CurrentSchemaDatabaseIdentity database = context.Database;
                Assert.Equal(CurrentSchemaProviderKind.Sqlite, database.Provider);
                Assert.Equal(new SqliteConnectionStringBuilder(fixture.ConnectionString).DataSource, database.DatabaseId);
                Assert.Same(database, context.Database);
                using CancellationTokenSource scope = context.CreateCancellationScope(token);
                Assert.True(scope.Token.CanBeCanceled);
                await context.RequireBoundaryAsync(scope.Token);
                using SqliteCommand command = original.CreateCommand();
                command.Transaction = transaction;
                command.CommandText = "SELECT COUNT(*) FROM native_session_test_probe";
                Assert.Equal(1, Convert.ToInt64(await command.ExecuteScalarAsync(scope.Token), CultureInfo.InvariantCulture));
                await context.RequireBoundaryAsync(scope.Token);
                return marker;
            }, creator.Token);
        Assert.True(callbackEntered, "Missing FILESTAT is not execution of the generic callback.");
        Assert.Same(marker, result);
        Assert.NotNull(original);
        Assert.Equal(ConnectionState.Closed, original.State);
        Assert.Null(original.Handle);
    }

    [Fact]
    public async Task EscapedContextIsInvalidatedBeforeTheOriginalNativeResourcesClose()
    {
        using var fixture = new SourceFixture();
        using var creator = new CancellationTokenSource();
        OfflineMigrationSqliteNativeSession.OwnedReadContext? escaped = null;
        int result = await OfflineMigrationSqliteNativeSession.ObserveOwnedReadAsync(
            fixture.ConnectionString, async (context, token) =>
            {
                await context.RequireBoundaryAsync(token);
                escaped = context;
                return 7;
            }, creator.Token);
        Assert.Equal(7, result);
        Assert.NotNull(escaped);
        Assert.Throws<InvalidOperationException>(() => escaped.OriginalConnection);
        Assert.Throws<InvalidOperationException>(() => escaped.OriginalTransaction);
        Assert.Throws<InvalidOperationException>(() => escaped.Database);
        Assert.Throws<InvalidOperationException>(() => escaped.CreateCancellationScope(CancellationToken.None));
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            escaped.RequireBoundaryAsync(CancellationToken.None));
        Assert.Equal("offline_source_sqlite_owned_read_context_closed", error.Message);
    }

    [Fact]
    public async Task GenericPortRequiresTheOriginalCreatorCancellationContext()
    {
        bool entered = false;
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OfflineMigrationSqliteNativeSession.ObserveOwnedReadAsync(
                "not parsed without creator context", (_, _) =>
                {
                    entered = true;
                    return Task.FromResult(7);
                }, CancellationToken.None));
        Assert.Equal("offline_source_native_operation_context_required", error.Message);
        Assert.False(entered);
    }

    [Fact]
    public async Task CreatorCancellationCannotBeReplacedWithANewBorrowerToken()
    {
        using var fixture = new SourceFixture();
        using var creator = new CancellationTokenSource();
        bool entered = false;
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            OfflineMigrationSqliteNativeSession.ObserveOwnedReadAsync<int>(
                fixture.ConnectionString, async (context, token) =>
                {
                    entered = true;
                    await context.RequireBoundaryAsync(token);
                    using CancellationTokenSource existing = context.CreateCancellationScope(CancellationToken.None);
                    creator.Cancel();
                    Assert.True(existing.IsCancellationRequested);
                    using var fresh = new CancellationTokenSource();
                    Assert.ThrowsAny<OperationCanceledException>(() => context.CreateCancellationScope(fresh.Token));
                    await Assert.ThrowsAnyAsync<OperationCanceledException>(() => context.RequireBoundaryAsync(fresh.Token));
                    return 7;
                }, creator.Token));
        Assert.True(entered, "Missing FILESTAT must not pass a creator-cancellation control.");
    }

    [Fact]
    public async Task BorrowerCancellationIsLinkedWithoutCancellingOrReplacingTheCreator()
    {
        using var fixture = new SourceFixture();
        using var creator = new CancellationTokenSource();
        int result = await OfflineMigrationSqliteNativeSession.ObserveOwnedReadAsync(
            fixture.ConnectionString, async (context, token) =>
            {
                await context.RequireBoundaryAsync(token);
                using var borrower = new CancellationTokenSource();
                using CancellationTokenSource linked = context.CreateCancellationScope(borrower.Token);
                borrower.Cancel();
                Assert.True(linked.IsCancellationRequested);
                Assert.False(creator.IsCancellationRequested);
                await Assert.ThrowsAnyAsync<OperationCanceledException>(() => context.RequireBoundaryAsync(borrower.Token));
                await context.RequireBoundaryAsync(CancellationToken.None);
                return 7;
            }, creator.Token);
        Assert.Equal(7, result);
    }

    [Fact]
    public async Task GenericBoundaryRejectsChangedQueryOnlyAfterAValidOwnedRead()
    {
        using var fixture = new SourceFixture();
        using var creator = new CancellationTokenSource();
        bool entered = false;
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OfflineMigrationSqliteNativeSession.ObserveOwnedReadAsync(
                fixture.ConnectionString, async (context, token) =>
                {
                    entered = true;
                    await context.RequireBoundaryAsync(token);
                    using CancellationTokenSource scope = context.CreateCancellationScope(token);
                    using DbCommand command = context.OriginalConnection.CreateCommand();
                    command.Transaction = context.OriginalTransaction;
                    command.CommandText = "PRAGMA query_only = OFF";
                    await command.ExecuteNonQueryAsync(scope.Token);
                    await context.RequireBoundaryAsync(scope.Token);
                    return 7;
                }, creator.Token));
        Assert.True(entered, "Missing FILESTAT is not the changed-boundary refusal.");
        Assert.Equal("offline_source_sqlite_query_only_required", error.Message);
        Assert.Null(error.InnerException);
    }

    [Fact]
    public async Task GenericBoundaryRejectsAReplacedMainLeafEvenWithIdenticalBytes()
    {
        using var fixture = new SourceFixture();
        using var creator = new CancellationTokenSource();
        string path = new SqliteConnectionStringBuilder(fixture.ConnectionString).DataSource;
        byte[] original = File.ReadAllBytes(path);
        bool entered = false;
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OfflineMigrationSqliteNativeSession.ObserveOwnedReadAsync(
                fixture.ConnectionString, async (context, token) =>
                {
                    entered = true;
                    await context.RequireBoundaryAsync(token);
                    File.Move(path, path + ".original");
                    File.WriteAllBytes(path, original);
                    Assert.Equal(original, File.ReadAllBytes(path));
                    await context.RequireBoundaryAsync(token);
                    return 7;
                }, creator.Token));
        Assert.True(entered, "Missing FILESTAT is not execution of the replacement.");
        Assert.Equal("offline_source_sqlite_native_operation_failed", error.Message);
        Assert.Null(error.InnerException);
    }

    [Fact]
    public async Task GenericClosedFingerprintFailurePreservesItsOriginalIdentityAfterCleanup()
    {
        using var fixture = new SourceFixture();
        using var creator = new CancellationTokenSource();
        OfflineMigrationSourceFingerprintException primary =
            OfflineMigrationSourceFingerprintException.Ambiguous(["fixture-first", "fixture-second"]);
        SqliteConnection? original = null;
        OfflineMigrationSourceFingerprintException returned = await Assert.ThrowsAsync<OfflineMigrationSourceFingerprintException>(() =>
            OfflineMigrationSqliteNativeSession.ObserveOwnedReadAsync<int>(
                fixture.ConnectionString, async (context, token) =>
                {
                    original = Assert.IsType<SqliteConnection>(context.OriginalConnection);
                    await context.RequireBoundaryAsync(token);
                    throw primary;
                }, creator.Token));
        Assert.Same(primary, returned);
        Assert.NotNull(original);
        Assert.Equal(ConnectionState.Closed, original.State);
        Assert.Null(original.Handle);
    }

    [Fact]
    public async Task GenericUnknownCallbackFailureRemainsRedactedNotSuccessful()
    {
        using var fixture = new SourceFixture();
        using var creator = new CancellationTokenSource();
        bool entered = false;
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OfflineMigrationSqliteNativeSession.ObserveOwnedReadAsync<int>(
                fixture.ConnectionString, async (context, token) =>
                {
                    entered = true;
                    await context.RequireBoundaryAsync(token);
                    throw new InvalidOperationException("private-callback-credential-and-row-text");
                }, creator.Token));
        Assert.True(entered, "Missing FILESTAT is not the unknown-callback refusal.");
        Assert.Equal("offline_source_sqlite_native_operation_failed", error.Message);
        Assert.Null(error.InnerException);
    }
}
