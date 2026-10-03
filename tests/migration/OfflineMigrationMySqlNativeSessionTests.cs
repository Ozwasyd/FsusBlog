using System.Data.Common;

using MySqlConnector;

using Xunit;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration.Tests;

/// <summary>Pre-connection refusals only, not a mock MySQL provider acceptance lane.</summary>
public sealed class OfflineMigrationMySqlNativeSessionTests
{
    [Fact]
    public void CurrentReadOnlyProofUsesActualAccessModeRatherThanSessionDefault()
    {
        var actual = CurrentReadOnlyProof();
        Assert.True(OfflineMigrationMySqlNativeSession.CurrentTransactionMatches(actual, 19));
        // SESSION TRANSACTION READ ONLY can remain 1 while START TRANSACTION
        // READ WRITE overrides this transaction. The actual event must refuse it.
        Assert.False(OfflineMigrationMySqlNativeSession.CurrentTransactionMatches(actual with { AccessMode = "READ WRITE" }, 19));
        Assert.False(OfflineMigrationMySqlNativeSession.CurrentTransactionMatches(actual with { AccessMode = "READONLY" }, 19));
    }

    [Theory]
    [InlineData("committed")]
    [InlineData("rolled-back")]
    [InlineData("ended-active")]
    [InlineData("connection")]
    [InlineData("zero-connection")]
    [InlineData("thread")]
    [InlineData("event")]
    [InlineData("zero-thread")]
    [InlineData("zero-event")]
    [InlineData("isolation")]
    [InlineData("xa")]
    [InlineData("thread-instrumented")]
    [InlineData("instrument")]
    [InlineData("global-consumer")]
    [InlineData("thread-consumer")]
    [InlineData("current-consumer")]
    public void CurrentTransactionMustRemainTheSameActiveInstrumentedNativeEvent(string change)
    {
        var initial = CurrentReadOnlyProof();
        var current = change switch
        {
            "committed" => initial with { State = "COMMITTED" },
            "rolled-back" => initial with { State = "ROLLED BACK" },
            "ended-active" => initial with { EndEventId = 90 },
            "connection" => initial with { ConnectionId = 20 },
            "zero-connection" => initial with { ConnectionId = 0 },
            "thread" => initial with { ThreadId = 32 },
            "event" => initial with { EventId = 41 },
            "zero-thread" => initial with { ThreadId = 0 },
            "zero-event" => initial with { EventId = 0 },
            "isolation" => initial with { Isolation = "READ COMMITTED" },
            "xa" => initial with { XaState = "ACTIVE" },
            "thread-instrumented" => initial with { ThreadInstrumented = "NO" },
            "instrument" => initial with { InstrumentEnabled = "NO" },
            "global-consumer" => initial with { GlobalEnabled = "NO" },
            "thread-consumer" => initial with { ThreadEnabled = "NO" },
            "current-consumer" => initial with { CurrentEnabled = "NO" },
            _ => throw new InvalidOperationException("unknown source control")
        };
        Assert.True(OfflineMigrationMySqlNativeSession.CurrentTransactionMatches(initial, 19, initial));
        Assert.False(OfflineMigrationMySqlNativeSession.CurrentTransactionMatches(current, 19, initial));
    }

    [Fact]
    public void CallerParsedEvenValidFieldsCannotMintOriginalRunCapability()
    {
        using var connection = new MySqlConnection();
        var fields = CurrentReadOnlyProof();
        Assert.True(OfflineMigrationMySqlNativeSession.CurrentTransactionMatches(fields, 19));
        InvalidOperationException refusal = Assert.Throws<InvalidOperationException>(() =>
            new OfflineMigrationMySqlNativeSession.OwnedReadContext(new object(), connection, null!, fields));
        Assert.Equal("offline_source_mysql_original_owned_context_required", refusal.Message);
        Assert.Null(refusal.InnerException);
    }

    [Fact]
    public void CurrentTransactionQueryBindsServerIdentityAndActualEventNotSessionReadOnly()
    {
        string sql = OfflineMigrationMySqlNativeSession.CurrentTransactionSql;
        Assert.Contains("SELECT CONNECTION_ID(), t.THREAD_ID, x.EVENT_ID, x.END_EVENT_ID", sql);
        Assert.Contains("x.STATE, x.ACCESS_MODE, x.ISOLATION_LEVEL, x.XA_STATE", sql);
        Assert.Contains("WHERE t.PROCESSLIST_ID = CONNECTION_ID() AND x.EVENT_NAME = 'transaction'", sql);
        Assert.Contains("i.NAME = 'transaction'", sql);
        Assert.Contains("g.NAME = 'global_instrumentation'", sql);
        Assert.Contains("h.NAME = 'thread_instrumentation'", sql);
        Assert.Contains("c.NAME = 'events_transactions_current'", sql);
        Assert.DoesNotContain("@@session.transaction_read_only", sql);
    }

    [Fact]
    public async Task OwnedReadEntryCancellationCannotMintAContextOrOpenNativeResources()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            OfflineMigrationMySqlNativeSession.ObserveOwnedReadAsync<int>("not parsed after cancellation",
                (_, _) => throw new InvalidOperationException("callback must not run"), cancellation.Token));
    }

    [Fact]
    public async Task OwnedReadEntryRequiresTheOriginalCancellationScope()
    {
        InvalidOperationException refusal = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OfflineMigrationMySqlNativeSession.ObserveOwnedReadAsync<int>("not parsed without context",
                (_, _) => throw new InvalidOperationException("callback must not run"), default));
        Assert.Equal("offline_source_native_operation_context_required", refusal.Message);
    }

    private static OfflineMigrationMySqlNativeSession.CurrentTransactionProof CurrentReadOnlyProof()
        => new(19, 31, 40, null, "ACTIVE", "READ ONLY", "REPEATABLE READ", null,
            "YES", "YES", "YES", "YES", "YES");

    [Fact]
    public async Task ArbitraryRawPairCannotAcquireOriginalFactoryCustody()
    {
        using var cancellation = new CancellationTokenSource();
        using var connection = new MySqlConnection();
        using var transaction = new CallerLabelledTransaction(connection);
        InvalidOperationException refusal = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OfflineMigrationMySqlNativeSession.RequireBorrowedBoundaryAsync(connection, transaction, cancellation.Token));
        Assert.Equal("offline_source_mysql_original_owned_context_required", refusal.Message);
        Assert.Null(refusal.InnerException);
    }

    private sealed class CallerLabelledTransaction(DbConnection connection) : DbTransaction
    {
        public override System.Data.IsolationLevel IsolationLevel => System.Data.IsolationLevel.Snapshot;
        protected override DbConnection DbConnection => connection;
        public override void Commit() => throw new NotSupportedException();
        public override void Rollback() => throw new NotSupportedException();
    }

    [Fact]
    public async Task BorrowedBoundaryCancellationPrecedesNativeAccess()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            OfflineMigrationMySqlNativeSession.RequireBorrowedBoundaryAsync(null!, null!, cancellation.Token));
    }

    [Fact]
    public async Task BorrowedBoundaryMissingCancellationScopeCannotReachNativeSql()
    {
        InvalidOperationException refusal = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OfflineMigrationMySqlNativeSession.RequireBorrowedBoundaryAsync(null!, null!, default));
        Assert.Equal("offline_source_native_operation_context_required", refusal.Message);
        Assert.Null(refusal.InnerException);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task BorrowedBoundaryRequiresBothActualNativeResources(bool missingConnection)
    {
        using var cancellation = new CancellationTokenSource();
        using var connection = new MySqlConnection();
        ArgumentNullException refusal = await Assert.ThrowsAsync<ArgumentNullException>(() =>
            OfflineMigrationMySqlNativeSession.RequireBorrowedBoundaryAsync(missingConnection ? null! : connection, null!, cancellation.Token));
        Assert.Equal(missingConnection ? "connection" : "transaction", refusal.ParamName);
    }

    [Fact]
    public async Task CancelledCallerDoesNotCreateANativeConnection()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            OfflineMigrationMySqlNativeSession.ObserveAsync("not parsed after cancellation", NeverObserve, cancellation.Token));
    }

    [Fact]
    public async Task MissingOwnerCancellationContextIsRefused()
    {
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OfflineMigrationMySqlNativeSession.ObserveAsync("not parsed without context", NeverObserve, CancellationToken.None));
        Assert.Equal("offline_source_native_operation_context_required", error.Message);
    }

    [Theory]
    [InlineData("")]
    [InlineData(" ")]
    public async Task EmptyConnectionSettingsAreRefusedBeforeDriverCreation(string settings)
    {
        using var cancellation = new CancellationTokenSource();
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OfflineMigrationMySqlNativeSession.ObserveAsync(settings, NeverObserve, cancellation.Token));
        Assert.Equal("offline_source_native_operation_context_required", error.Message);
    }

    [Fact]
    public async Task BadPrivateConnectionOptionsCannotLeakCredentialsOrDriverMessages()
    {
        using var cancellation = new CancellationTokenSource();
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OfflineMigrationMySqlNativeSession.ObserveAsync(
                "Password=private-fixture-not-for-errors;UnsupportedNativeSessionFixtureOption=1", NeverObserve, cancellation.Token));
        Assert.Equal("offline_source_mysql_native_operation_failed", error.Message);
        Assert.Null(error.InnerException);
    }


    [Fact]
    public void OriginalFingerprintTransportSurvivesReturnedCleanupWithoutParsingItsMessage()
    {
        OfflineMigrationSourceFingerprintException primary = UnknownFingerprint();
        OfflineMigrationSourceFingerprintException refusal = Assert.Throws<OfflineMigrationSourceFingerprintException>(() =>
            OfflineMigrationMySqlNativeSession.ThrowAfterCleanup(primary, OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned,
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
            OfflineMigrationMySqlNativeSession.ThrowAfterCleanup(primary, transaction, connection, adapter, CancellationToken.None));
        Assert.IsNotType<OfflineMigrationSourceFingerprintException>(refusal);
        Assert.Equal(OfflineMigrationPostgreSqlNativeSession.CleanupFailureCode(primary, transaction, connection, adapter), refusal.Message);
        Assert.Null(refusal.InnerException);
    }

    [Fact]
    public void MessageLookalikeDoesNotBecomeTypedFailureOrLeakDriverText()
    {
        var primary = new InvalidOperationException("source_fingerprint_unknown: Password=private-fixture; SELECT private rows");
        InvalidOperationException refusal = Assert.Throws<InvalidOperationException>(() =>
            OfflineMigrationMySqlNativeSession.ThrowAfterCleanup(primary, OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned,
                OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned, OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned, CancellationToken.None));
        Assert.Equal("offline_source_mysql_native_operation_failed", refusal.Message);
        Assert.Null(refusal.InnerException);
    }

    [Fact]
    public void ReturnedCleanupPreservesCancellationBeforeGenericOperationProjection()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        OperationCanceledException refusal = Assert.Throws<OperationCanceledException>(() =>
            OfflineMigrationMySqlNativeSession.ThrowAfterCleanup(new OperationCanceledException("private native data"),
                OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned, OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned,
                OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned, cancellation.Token));
        Assert.Equal("offline_source_native_operation_cancelled", refusal.Message);
        Assert.Equal(cancellation.Token, refusal.CancellationToken);
        Assert.Null(refusal.InnerException);
    }

    private static OfflineMigrationSourceFingerprintException UnknownFingerprint()
        => Assert.Throws<OfflineMigrationSourceFingerprintException>(() =>
            OfflineMigrationSourceFingerprints.RequireKnownSchema(CurrentSchemaProviderKind.MySql,
                OfflineMigrationSourceFingerprints.Schema(CurrentSchemaProviderKind.MySql, false)
                    .Add(new("table/private-fixture-name-not-for-errors", "base"))));

    [Fact]
    public async Task CurrentCatalogEntryHonorsCancellationBeforeCreatingItsOriginalNativeConnection()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            OfflineMigrationMySqlNativeSession.ObserveCurrentCatalogAsync("not parsed after cancellation", cancellation.Token));
    }

    [Fact]
    public async Task CurrentCatalogEntryCannotBorrowAnUnownedOperationContext()
    {
        InvalidOperationException refusal = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            OfflineMigrationMySqlNativeSession.ObserveCurrentCatalogAsync("not parsed without context", CancellationToken.None));
        Assert.Equal("offline_source_native_operation_context_required", refusal.Message);
        Assert.Null(refusal.InnerException);
    }

    private static Task<OfflineMigrationSourceObservation> NeverObserve(
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
        => throw new InvalidOperationException("observer must not run before argument refusal");
}
