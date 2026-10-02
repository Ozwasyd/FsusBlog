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


    [Fact]
    public void OriginalFingerprintTransportSurvivesReturnedCleanupWithoutParsingItsMessage()
    {
        OfflineMigrationSourceFingerprintException primary = UnknownFingerprint();
        OfflineMigrationSourceFingerprintException refusal = Assert.Throws<OfflineMigrationSourceFingerprintException>(() =>
            OfflineMigrationSqliteNativeSession.ThrowAfterCleanup(primary, OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned,
                OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned, OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned, CancellationToken.None));
        Assert.Same(primary, refusal);
        Assert.Equal("source_fingerprint_unknown", refusal.Code);
        Assert.NotEmpty(refusal.Differences);
        Assert.Null(refusal.InnerException);
    }

    [Theory]
    [InlineData(2, 1, 1)]
    [InlineData(1, 2, 1)]
    [InlineData(1, 1, 2)]
    public void AnyUnverifiedCleanupRefusesBeforeTypedFingerprintTransport(
        int transactionValue, int connectionValue, int adapterValue)
    {
        var transaction = (OfflineMigrationPostgreSqlNativeSession.CleanupState)transactionValue;
        var connection = (OfflineMigrationPostgreSqlNativeSession.CleanupState)connectionValue;
        var adapter = (OfflineMigrationPostgreSqlNativeSession.CleanupState)adapterValue;
        OfflineMigrationSourceFingerprintException primary = UnknownFingerprint();
        InvalidOperationException refusal = Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationSqliteNativeSession.ThrowAfterCleanup(primary, transaction, connection, adapter, CancellationToken.None));
        Assert.IsNotType<OfflineMigrationSourceFingerprintException>(refusal);
        Assert.Equal(OfflineMigrationPostgreSqlNativeSession.CleanupFailureCode(primary, transaction, connection, adapter), refusal.Message);
        Assert.Null(refusal.InnerException);
    }

    [Fact]
    public void MessageLookalikeDoesNotBecomeTypedFailureOrLeakDriverText()
    {
        var primary = new InvalidOperationException("source_fingerprint_unknown: Password=private-fixture; SELECT private rows");
        InvalidOperationException refusal = Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationSqliteNativeSession.ThrowAfterCleanup(primary, OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned,
                OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned, OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned, CancellationToken.None));
        Assert.Equal("offline_source_sqlite_native_operation_failed", refusal.Message);
        Assert.Null(refusal.InnerException);
    }

    [Fact]
    public void ReturnedCleanupPreservesCancellationBeforeGenericOperationProjection()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        OperationCanceledException refusal = Assert.Throws<OperationCanceledException>(() =>
            OfflineMigrationSqliteNativeSession.ThrowAfterCleanup(new OperationCanceledException("private native data"),
                OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned, OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned,
                OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned, cancellation.Token));
        Assert.Equal("offline_source_native_operation_cancelled", refusal.Message);
        Assert.Equal(cancellation.Token, refusal.CancellationToken);
        Assert.Null(refusal.InnerException);
    }

    private static OfflineMigrationSourceFingerprintException UnknownFingerprint()
        => Assert.Throws<OfflineMigrationSourceFingerprintException>(() =>
            OfflineMigrationSourceFingerprints.RequireKnownSchema(CurrentSchemaProviderKind.Sqlite,
                OfflineMigrationSourceFingerprints.Schema(CurrentSchemaProviderKind.Sqlite, false)
                    .Add(new("table/private-fixture-name-not-for-errors", "base"))));


    [Theory]
    [InlineData(true, false)]
    [InlineData(false, true)]
    public void UnverifiedInterruptOrRegistrationStillRefusesBeforeTypedPrimary(bool registration, bool interrupt)
    {
        OfflineMigrationSourceFingerprintException primary = UnknownFingerprint();
        InvalidOperationException refusal = Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationSqliteNativeSession.ThrowAfterCleanup(primary, OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned,
                OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned, OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned, CancellationToken.None, registration, interrupt));
        Assert.IsNotType<OfflineMigrationSourceFingerprintException>(refusal);
        Assert.EndsWith(registration ? "_cancellation_registration_unverified" : "_native_interrupt_unverified", refusal.Message);
        Assert.Null(refusal.InnerException);
    }

    [Fact]
    public async Task ActualSourceCallbackKeepsTheSameTypedFingerprintAfterNativeCleanup()
    {
        using var fixture = new SourceFixture();
        using var cancellation = new CancellationTokenSource();
        SqliteConnection? actualConnection = null;
        OfflineMigrationSourceFingerprintException? original = null;
        OfflineMigrationSourceFingerprintException refusal = await Assert.ThrowsAsync<OfflineMigrationSourceFingerprintException>(() =>
            OfflineMigrationSqliteNativeSession.ObserveAsync(fixture.ConnectionString, async (connection, transaction, token) =>
            {
                actualConnection = Assert.IsType<SqliteConnection>(connection);
                try
                {
                    // This fixture's genuine probe table is not a registered legacy or
                    // empty source. The original native reader measures and refuses it.
                    _ = await OfflineMigrationSourceObserver.ReadSqliteSourceAsync(connection, transaction, token);
                }
                catch (OfflineMigrationSourceFingerprintException failure)
                {
                    original = failure;
                    throw;
                }
                throw new InvalidOperationException("unknown fixture schema must not be admitted");
            }, cancellation.Token));
        Assert.NotNull(original); // Missing FILESTAT cannot satisfy this actual callback control.
        Assert.Same(original, refusal);
        Assert.Equal("source_fingerprint_unknown", refusal.Code);
        Assert.Contains(refusal.Differences, difference => difference.Category == OfflineMigrationFingerprintCategory.Schema);
        Assert.NotNull(actualConnection);
        Assert.Equal(ConnectionState.Closed, actualConnection.State);
        Assert.Null(actualConnection.Handle);
        Assert.Equal(1, fixture.CountRows());
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
}
