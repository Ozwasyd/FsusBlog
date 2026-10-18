using System.Data;
using System.Data.Common;

using MySqlConnector;

using SqlSugar;

namespace FsusBlog.Migration;

/// <summary>
/// Holds a real MySqlConnector consistent snapshot through the original source observer.
/// MySQL has no PostgreSQL-style exported snapshot token: this read port is not a dump
/// capture, backup authentication, complete source extractor, or provider acceptance.
/// </summary>
internal static class OfflineMigrationMySqlNativeSession
{
    private static readonly object s_ownedContextKey = new();

    // This additional capability needs actual MySQL transaction instrumentation.
    // Missing permissions/instrumentation are refusals; the owner never enables
    // Performance Schema or changes the environment required by ObserveAsync.
    internal static Task<TResult> ObserveOwnedReadAsync<TResult>(string connectionString,
        Func<OwnedReadContext, CancellationToken, Task<TResult>> observe, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(observe);
        return ReadAsync(connectionString, async (connection, transaction, token) =>
        {
            var nativeConnection = (MySqlConnection)connection;
            var nativeTransaction = (MySqlTransaction)transaction;
            CurrentTransactionProof initial = await ReadCurrentTransactionAsync(nativeConnection, nativeTransaction, token).ConfigureAwait(false);
            var context = new OwnedReadContext(s_ownedContextKey, nativeConnection, nativeTransaction, initial, token);
            try
            {
                await context.RequireBoundaryAsync(token).ConfigureAwait(false);
                TResult result = await observe(context, token).ConfigureAwait(false);
                await context.RequireBoundaryAsync(token).ConfigureAwait(false);
                return result;
            }
            finally
            {
                context.Invalidate();
            }
        }, cancellationToken);
    }

    /// <summary>
    /// Borrowed only inside the original creator's single live read-only snapshot.
    /// A parsed row, caller transaction, or retained reference cannot mint a run.
    /// </summary>
    internal sealed class OwnedReadContext
    {
        private readonly MySqlConnection _connection;
        private readonly MySqlTransaction _transaction;
        private readonly CurrentTransactionProof _initial;
        private readonly CancellationToken _creatorCancellationToken;
        private int _active = 1;

        internal OwnedReadContext(object ownerKey, MySqlConnection connection,
            MySqlTransaction transaction, CurrentTransactionProof initial, CancellationToken creatorCancellationToken)
        {
            if (!ReferenceEquals(ownerKey, s_ownedContextKey))
                throw new InvalidOperationException("offline_source_mysql_original_owned_context_required");
            _connection = connection;
            _transaction = transaction;
            _initial = initial;
            _creatorCancellationToken = creatorCancellationToken;
        }

        internal DbConnection OriginalConnection => _connection;
        internal DbTransaction OriginalTransaction => _transaction;

        // The consumer owns this scope through its entire awaited read, not just
        // boundary samples. Disposing it before row I/O would detach the creator.
        internal CancellationTokenSource CreateReadScope(CancellationToken cancellationToken)
        {
            _creatorCancellationToken.ThrowIfCancellationRequested();
            if (Volatile.Read(ref _active) != 1)
                throw new NativeFailure("offline_source_mysql_original_owned_context_required");
            return CreateBorrowedCancellationScope(_creatorCancellationToken, cancellationToken);
        }

        internal async Task RequireBoundaryAsync(CancellationToken cancellationToken)
        {
            // The creator's deadline remains authoritative even when a borrower
            // supplies a fresh token. A borrower may only shorten this operation.
            using CancellationTokenSource scope = CreateBorrowedCancellationScope(_creatorCancellationToken, cancellationToken);
            CancellationToken effectiveToken = scope.Token;
            if (Volatile.Read(ref _active) != 1 || _connection.State != ConnectionState.Open
                || !ReferenceEquals(_transaction.Connection, _connection)
                || _transaction.IsolationLevel != IsolationLevel.Snapshot)
                throw new NativeFailure("offline_source_mysql_original_owned_context_required");
            _creatorCancellationToken.ThrowIfCancellationRequested();
            await RequireNativeReadBoundaryAsync(_connection, _transaction, effectiveToken).ConfigureAwait(false);
            _creatorCancellationToken.ThrowIfCancellationRequested();
            effectiveToken.ThrowIfCancellationRequested();
            CurrentTransactionProof current = await ReadCurrentTransactionAsync(_connection, _transaction, effectiveToken).ConfigureAwait(false);
            _creatorCancellationToken.ThrowIfCancellationRequested();
            effectiveToken.ThrowIfCancellationRequested();
            if (!CurrentTransactionMatches(current, unchecked((uint)_connection.ServerThread), _initial)
                || Volatile.Read(ref _active) != 1)
                throw new NativeFailure("offline_source_mysql_owned_transaction_required");
        }

        internal void Invalidate() => Interlocked.Exchange(ref _active, 0);
    }

    internal static CancellationTokenSource CreateBorrowedCancellationScope(
        CancellationToken creatorCancellationToken, CancellationToken callerCancellationToken)
    {
        creatorCancellationToken.ThrowIfCancellationRequested();
        callerCancellationToken.ThrowIfCancellationRequested();
        if (!creatorCancellationToken.CanBeCanceled || !callerCancellationToken.CanBeCanceled)
            throw new InvalidOperationException("offline_source_native_operation_context_required");
        return CancellationTokenSource.CreateLinkedTokenSource(creatorCancellationToken, callerCancellationToken);
    }

    internal static Task<OfflineMigrationSourceObservation> ObserveAsync(
        string connectionString,
        Func<DbConnection, DbTransaction, CancellationToken, Task<OfflineMigrationSourceObservation>> observe,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(observe);
        return ReadAsync(connectionString, observe, cancellationToken);
    }

    // The current catalog is measured through this same original connection/
    // transaction/cleanup owner, not a second connection or a source DTO marker.
    internal static Task<MySqlCurrentSchemaCatalog> ObserveCurrentCatalogAsync(
        string connectionString, CancellationToken cancellationToken)
        => ReadAsync(connectionString, MySqlCurrentSchemaCatalogObserver.ReadAsync, cancellationToken);

    internal static Task<MySqlCurrentSchemaPhysicalObservation> ObserveCurrentPhysicalAsync(
        string connectionString, CancellationToken cancellationToken)
        => ReadAsync(connectionString, MySqlCurrentSchemaPhysicalObserver.ReadAsync, cancellationToken);

    private static async Task<TResult> ReadAsync<TResult>(
        string connectionString,
        Func<DbConnection, DbTransaction, CancellationToken, Task<TResult>> observe,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!cancellationToken.CanBeCanceled || string.IsNullOrWhiteSpace(connectionString))
        {
            throw new InvalidOperationException("offline_source_native_operation_context_required");
        }
        SqlSugarClient? database = null;
        MySqlConnection? connection = null;
        MySqlTransaction? transaction = null;
        Exception? primary = null;
        TResult result = default!;
        var transactionCleanup = OfflineMigrationPostgreSqlNativeSession.CleanupState.NotOwned;
        var connectionCleanup = OfflineMigrationPostgreSqlNativeSession.CleanupState.NotOwned;
        var adapterCleanup = OfflineMigrationPostgreSqlNativeSession.CleanupState.NotOwned;
        try
        {
            var settings = new MySqlConnectionStringBuilder(connectionString)
            {
                Pooling = false,
                AutoEnlist = false,
                PersistSecurityInfo = false,
                IgnoreCommandTransaction = false
            };
            database = new SqlSugarClient(new ConnectionConfig
            {
                DbType = SqlSugar.DbType.MySql,
                ConnectionString = settings.ConnectionString,
                IsAutoCloseConnection = false
            });
            database.Ado.IsEnableLogEvent = false;
            if (database.Ado.Connection is not MySqlConnection nativeConnection
                || database.Ado.Transaction is not null || nativeConnection.State != ConnectionState.Closed)
            {
                throw new NativeFailure("offline_source_mysql_native_adapter_required");
            }
            connection = nativeConnection;
            await connection.OpenAsync(cancellationToken).ConfigureAwait(false);
            // A private unpooled session makes these defaults observable and prevents them
            // leaking into another borrower. No business/schema data is changed.
            await using (var command = new MySqlCommand("SET SESSION TRANSACTION READ ONLY", connection))
            {
                await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
            }
            // Connector2.6.2 maps Snapshot to server REPEATABLE READ plus WITH CONSISTENT
            // SNAPSHOT. Passing RepeatableRead alone would not establish that read view here.
            transaction = await connection.BeginTransactionAsync(
                IsolationLevel.Snapshot, isReadOnly: true, cancellationToken).ConfigureAwait(false);
            database.Ado.Transaction = transaction;
            await RequireBoundaryAsync(database, connection, transaction, cancellationToken).ConfigureAwait(false);
            result = await observe(connection, transaction, cancellationToken).ConfigureAwait(false);
            await RequireBoundaryAsync(database, connection, transaction, cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
        }
        catch (Exception exception)
        {
            primary = exception;
        }
        finally
        {
            if (transaction is not null)
            {
                transactionCleanup = OfflineMigrationPostgreSqlNativeSession.CleanupState.Unverified;
                try
                {
                    await transaction.DisposeAsync().ConfigureAwait(false);
                    transactionCleanup = OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned;
                }
                catch (Exception)
                {
                    // Never replace a simultaneous primary failure with successful cleanup.
                }
            }
            if (connection is not null)
            {
                connectionCleanup = OfflineMigrationPostgreSqlNativeSession.CleanupState.Unverified;
                try
                {
                    await connection.DisposeAsync().ConfigureAwait(false);
                    connectionCleanup = OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned;
                }
                catch (Exception)
                {
                    // The original physical owner must independently establish final release.
                }
            }
            if (database is not null)
            {
                adapterCleanup = OfflineMigrationPostgreSqlNativeSession.CleanupState.Unverified;
                bool detachFailed = false;
                try
                {
                    database.Ado.Transaction = null;
                }
                catch (Exception)
                {
                    detachFailed = true;
                }
                try
                {
                    database.Dispose();
                    if (!detachFailed)
                    {
                        adapterCleanup = OfflineMigrationPostgreSqlNativeSession.CleanupState.Returned;
                    }
                }
                catch (Exception)
                {
                    // Attempt every owned disposer, retaining the failed state independently.
                }
            }
        }
        ThrowAfterCleanup(primary, transactionCleanup, connectionCleanup, adapterCleanup, cancellationToken);
        return result;
    }

    internal static void ThrowAfterCleanup(Exception? primary,
        OfflineMigrationPostgreSqlNativeSession.CleanupState transactionCleanup,
        OfflineMigrationPostgreSqlNativeSession.CleanupState connectionCleanup,
        OfflineMigrationPostgreSqlNativeSession.CleanupState adapterCleanup, CancellationToken cancellationToken)
    {
        if (transactionCleanup == OfflineMigrationPostgreSqlNativeSession.CleanupState.Unverified
            || connectionCleanup == OfflineMigrationPostgreSqlNativeSession.CleanupState.Unverified
            || adapterCleanup == OfflineMigrationPostgreSqlNativeSession.CleanupState.Unverified)
        {
            throw new InvalidOperationException(OfflineMigrationPostgreSqlNativeSession.CleanupFailureCode(
                primary, transactionCleanup, connectionCleanup, adapterCleanup));
        }
        if (primary is OperationCanceledException || (primary is null && cancellationToken.IsCancellationRequested))
        {
            throw new OperationCanceledException("offline_source_native_operation_cancelled", cancellationToken);
        }
        if (primary is not null)
        {
            if (primary is OfflineMigrationSourceFingerprintException)
            {
                // No generic-message parsing or driver exception transport: preserve
                // only the original redacted type after awaited cleanup has returned.
                OfflineMigrationPostgreSqlNativeSession.ThrowAfterCleanup(primary,
                    transactionCleanup, connectionCleanup, adapterCleanup, cancellationToken);
            }
            throw new InvalidOperationException(primary is NativeFailure owned
                ? owned.Message : "offline_source_mysql_native_operation_failed");
        }
    }

    private static async Task RequireBoundaryAsync(SqlSugarClient database, MySqlConnection connection,
        MySqlTransaction transaction, CancellationToken cancellationToken)
    {
        if (connection.State != ConnectionState.Open || transaction.Connection != connection
            || transaction.IsolationLevel != IsolationLevel.Snapshot
            || !ReferenceEquals(database.Ado.Connection, connection)
            || !ReferenceEquals(database.Ado.Transaction, transaction))
        {
            throw new NativeFailure("offline_source_mysql_native_snapshot_session_required");
        }
        await RequireNativeReadBoundaryAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
    }

    // A raw pair has neither creator custody nor current transaction evidence.
    // Preserve pre-access argument priority, but never admit it as an owned run.
    internal static Task RequireBorrowedBoundaryAsync(DbConnection connection,
        DbTransaction transaction, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!cancellationToken.CanBeCanceled)
            throw new InvalidOperationException("offline_source_native_operation_context_required");
        ArgumentNullException.ThrowIfNull(connection);
        ArgumentNullException.ThrowIfNull(transaction);
        throw new InvalidOperationException("offline_source_mysql_original_owned_context_required");
    }

    private static async Task RequireNativeReadBoundaryAsync(MySqlConnection nativeConnection,
        MySqlTransaction nativeTransaction, CancellationToken cancellationToken)
    {
        await using (var command = new MySqlCommand(
            "SELECT @@session.transaction_isolation, @@session.transaction_read_only, DATABASE()", nativeConnection, nativeTransaction))
        {
            await using MySqlDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
            if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
                || reader.GetString(0) != "REPEATABLE-READ" || reader.GetInt64(1) != 1
                || reader.IsDBNull(2) || string.IsNullOrEmpty(reader.GetString(2))
                || await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                throw new NativeFailure("offline_source_mysql_read_only_database_required");
            }
        }
        // RR alone does not snapshot MyISAM/nontransactional tables. The observer owns exact
        // catalog vocabulary; this port only refuses an engine outside its actual read view.
        await using var engineCommand = new MySqlCommand(
            "SELECT COUNT(*) FROM INFORMATION_SCHEMA.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' AND (ENGINE IS NULL OR ENGINE <> 'InnoDB')",
            nativeConnection, nativeTransaction);
        object? count = await engineCommand.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false);
        if (count is not (long or ulong) || (count is long signed && signed != 0) || (count is ulong unsigned && unsigned != 0))
        {
            throw new NativeFailure("offline_source_mysql_transactional_tables_required");
        }
    }

    // All flags are measured in the same query as the current native event: a
    // retained last-event row with disabled instrumentation is not a live proof.
    internal const string CurrentTransactionSql = """
        SELECT CONNECTION_ID(), t.THREAD_ID, x.EVENT_ID, x.END_EVENT_ID,
            x.STATE, x.ACCESS_MODE, x.ISOLATION_LEVEL, x.XA_STATE,
            t.INSTRUMENTED, i.ENABLED, g.ENABLED, h.ENABLED, c.ENABLED, DATABASE()
        FROM performance_schema.threads AS t
        JOIN performance_schema.events_transactions_current AS x ON x.THREAD_ID = t.THREAD_ID
        JOIN performance_schema.setup_instruments AS i ON i.NAME = 'transaction'
        JOIN performance_schema.setup_consumers AS g ON g.NAME = 'global_instrumentation'
        JOIN performance_schema.setup_consumers AS h ON h.NAME = 'thread_instrumentation'
        JOIN performance_schema.setup_consumers AS c ON c.NAME = 'events_transactions_current'
        WHERE t.PROCESSLIST_ID = CONNECTION_ID() AND x.EVENT_NAME = 'transaction'
        """;

    internal sealed record CurrentTransactionProof(ulong ConnectionId, ulong ThreadId, ulong EventId,
        ulong? EndEventId, string State, string AccessMode, string Isolation, string? XaState,
        string ThreadInstrumented, string InstrumentEnabled, string GlobalEnabled,
        string ThreadEnabled, string CurrentEnabled, string? DatabaseName);

    // Pure field validation is testable, but does not create an OwnedReadContext.
    internal static bool CurrentTransactionMatches(CurrentTransactionProof current,
        ulong nativeConnectionId, CurrentTransactionProof? initial = null)
        => current.ConnectionId != 0 && current.ConnectionId == nativeConnectionId && current.ThreadId != 0 && current.EventId != 0
            && current.EndEventId is null && current.State == "ACTIVE" && current.AccessMode == "READ ONLY"
            && current.Isolation == "REPEATABLE READ" && current.XaState is null
            && current.ThreadInstrumented == "YES" && current.InstrumentEnabled == "YES"
            && current.GlobalEnabled == "YES" && current.ThreadEnabled == "YES" && current.CurrentEnabled == "YES"
            && !string.IsNullOrEmpty(current.DatabaseName)
            && (initial is null || (current.ConnectionId == initial.ConnectionId
                && current.ThreadId == initial.ThreadId && current.EventId == initial.EventId
                && string.Equals(current.DatabaseName, initial.DatabaseName, StringComparison.Ordinal)));

    private static async Task<CurrentTransactionProof> ReadCurrentTransactionAsync(MySqlConnection connection,
        MySqlTransaction transaction, CancellationToken cancellationToken)
    {
        try
        {
            await using var command = new MySqlCommand(CurrentTransactionSql, connection, transaction);
            await using MySqlDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
            if (reader.FieldCount != 14 || !await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                throw new NativeFailure("offline_source_mysql_owned_transaction_observation_unavailable");
            var current = new CurrentTransactionProof(reader.GetUInt64(0), reader.GetUInt64(1), reader.GetUInt64(2),
                reader.IsDBNull(3) ? null : reader.GetUInt64(3), reader.GetString(4), reader.GetString(5), reader.GetString(6),
                reader.IsDBNull(7) ? null : reader.GetString(7), reader.GetString(8), reader.GetString(9),
                reader.GetString(10), reader.GetString(11), reader.GetString(12),
                reader.IsDBNull(13) ? null : reader.GetString(13));
            if (await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
                || !CurrentTransactionMatches(current, unchecked((uint)connection.ServerThread)))
                throw new NativeFailure("offline_source_mysql_owned_transaction_required");
            return current;
        }
        catch (OperationCanceledException)
        {
            throw;
        }
        catch (NativeFailure)
        {
            throw;
        }
        catch (Exception)
        {
            // Permissions, absent MySQL capability, and malformed result types
            // do not leak server text or become a caller-provided proof.
            throw new NativeFailure("offline_source_mysql_owned_transaction_observation_unavailable");
        }
    }

    private sealed class NativeFailure(string code) : Exception(code)
    {
    }
}
