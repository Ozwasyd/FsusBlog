using System.Data;
using System.Data.Common;

using FsusBlog.Contracts.Migration;

using Microsoft.Data.Sqlite;
using SqlSugar;

namespace FsusBlog.Migration;

/// <summary>
/// Holds one actual native SQLite file read view for the original complete source observer.
/// It does not copy a live file/WAL, mint an exported snapshot, implement backup admission,
/// or claim full content coverage merely because the connection can be opened.
/// </summary>
internal static class OfflineMigrationSqliteNativeSession
{
    internal static Task<OfflineMigrationSourceObservation> ObserveAsync(
        string connectionString,
        Func<DbConnection, DbTransaction, CancellationToken, Task<OfflineMigrationSourceObservation>> observe,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(observe);
        return ReadAsync(connectionString,
            (context, token) => observe(context.OriginalConnection, context.OriginalTransaction, token),
            cancellationToken, preserveClosedCallbackFailure: false);
    }

    /// <summary>Uses the original single native read owner with a callback-scoped, opaque context.</summary>
    internal static Task<TResult> ObserveOwnedReadAsync<TResult>(
        string connectionString,
        Func<OwnedReadContext, CancellationToken, Task<TResult>> observe,
        CancellationToken creatorCancellation)
    {
        ArgumentNullException.ThrowIfNull(observe);
        return ReadAsync(connectionString, observe, creatorCancellation, preserveClosedCallbackFailure: true);
    }

    private static async Task<TResult> ReadAsync<TResult>(
        string connectionString,
        Func<OwnedReadContext, CancellationToken, Task<TResult>> observe,
        CancellationToken cancellationToken,
        bool preserveClosedCallbackFailure)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!cancellationToken.CanBeCanceled || string.IsNullOrWhiteSpace(connectionString))
        {
            throw new InvalidOperationException("offline_source_native_operation_context_required");
        }
        SqlSugarClient? database = null;
        SqliteConnection? connection = null;
        SqliteTransaction? transaction = null;
        CancellationTokenRegistration? cancellationRegistration = null;
        NativeInterrupt? interrupt = null;
        bool registrationUnverified = false;
        Exception? primary = null;
        TResult result = default!;
        var transactionCleanup = OfflineMigrationPostgreSqlNativeSession.CleanupState.NotOwned;
        var connectionCleanup = OfflineMigrationPostgreSqlNativeSession.CleanupState.NotOwned;
        var adapterCleanup = OfflineMigrationPostgreSqlNativeSession.CleanupState.NotOwned;
        try
        {
            var settings = new SqliteConnectionStringBuilder(connectionString)
            {
                Mode = SqliteOpenMode.ReadOnly,
                Cache = SqliteCacheMode.Private,
                Pooling = false
            };
            if (string.IsNullOrWhiteSpace(settings.DataSource) || settings.DataSource == ":memory:")
            {
                throw new NativeFailure("offline_source_sqlite_persistent_source_required");
            }
            database = new SqlSugarClient(new ConnectionConfig
            {
                DbType = SqlSugar.DbType.Sqlite,
                ConnectionString = settings.ConnectionString,
                IsAutoCloseConnection = false
            });
            database.Ado.IsEnableLogEvent = false;
            if (database.Ado.Connection is not SqliteConnection nativeConnection
                || nativeConnection.GetType() != typeof(SqliteConnection)
                || database.Ado.Transaction is not null || nativeConnection.State != ConnectionState.Closed)
            {
                throw new NativeFailure("offline_source_sqlite_native_adapter_required");
            }
            connection = nativeConnection;
            await connection.OpenAsync(cancellationToken).ConfigureAwait(false);
            SQLitePCL.sqlite3 handle = connection.Handle
                ?? throw new NativeFailure("offline_source_sqlite_native_handle_required");
            string nativeFilename = RequireNativeFilename(handle);
            interrupt = new NativeInterrupt(handle);
            // Microsoft.Data.Sqlite's async APIs execute synchronously. A real interrupt
            // addresses running native SQL; a passed token alone is not native cancellation.
            // Busy waits, file I/O and disposal still need actual outer physical enforcement.
            cancellationRegistration = cancellationToken.UnsafeRegister(
                static state => ((NativeInterrupt)state!).Request(), interrupt);
            cancellationToken.ThrowIfCancellationRequested();
            await using (var command = connection.CreateCommand())
            {
                command.CommandText = "PRAGMA query_only = ON";
                await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
            }
            transaction = connection.BeginTransaction(IsolationLevel.Serializable, deferred: true);
            database.Ado.Transaction = transaction;
            // A real main-file read establishes the deferred view even for an empty database.
            await using (var command = connection.CreateCommand())
            {
                command.Transaction = transaction;
                command.CommandText = "SELECT COUNT(*) FROM main.sqlite_schema";
                _ = await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false);
            }
            await RequireBoundaryAsync(database, connection, transaction, handle, nativeFilename, cancellationToken).ConfigureAwait(false);
            using OfflineMigrationSqliteDatabaseIdentity.Snapshot identity = await OfflineMigrationSqliteDatabaseIdentity.CaptureAsync(
                connection, transaction, cancellationToken).ConfigureAwait(false);
            var ownedState = new OwnedReadState(database, connection, transaction, handle, nativeFilename, identity, cancellationToken);
            OwnedReadContext context = OwnedReadContext.CreateForOwner(ownedState);
            try
            {
                result = await observe(context, cancellationToken).ConfigureAwait(false);
            }
            finally
            {
                await ownedState.InvalidateAsync().ConfigureAwait(false);
            }
            await identity.ValidateAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
            await RequireBoundaryAsync(database, connection, transaction, handle, nativeFilename, cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
        }
        catch (Exception exception)
        {
            primary = exception;
        }
        finally
        {
            // The callback can touch the native handle. Await actual unregister/callback
            // terminal before any native close, never race it with a tokenless Dispose task.
            if (cancellationRegistration is { } registration)
            {
                try
                {
                    await registration.DisposeAsync().ConfigureAwait(false);
                }
                catch (Exception)
                {
                    registrationUnverified = true;
                }
            }
            if (registrationUnverified)
            {
                // If callback release is unknown, retain native handles for the original
                // physical owner rather than racing a still-running interrupt with close.
                transactionCleanup = transaction is null ? OfflineMigrationPostgreSqlNativeSession.CleanupState.NotOwned
                    : OfflineMigrationPostgreSqlNativeSession.CleanupState.Unverified;
                connectionCleanup = connection is null ? OfflineMigrationPostgreSqlNativeSession.CleanupState.NotOwned
                    : OfflineMigrationPostgreSqlNativeSession.CleanupState.Unverified;
                adapterCleanup = database is null ? OfflineMigrationPostgreSqlNativeSession.CleanupState.NotOwned
                    : OfflineMigrationPostgreSqlNativeSession.CleanupState.Unverified;
            }
            else
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
                        // Keep primary cancellation distinct from unverified native cleanup.
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
                        // The original physical owner must establish terminal file/handle release.
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
                        // No successful result until every attempted native disposer returned.
                    }
                }
            }
        }
        if (registrationUnverified || interrupt?.Failed == true
            || transactionCleanup == OfflineMigrationPostgreSqlNativeSession.CleanupState.Unverified
            || connectionCleanup == OfflineMigrationPostgreSqlNativeSession.CleanupState.Unverified
            || adapterCleanup == OfflineMigrationPostgreSqlNativeSession.CleanupState.Unverified)
        {
            string code = OfflineMigrationPostgreSqlNativeSession.CleanupFailureCode(
                primary, transactionCleanup, connectionCleanup, adapterCleanup);
            throw new InvalidOperationException(code + (registrationUnverified
                ? "_cancellation_registration_unverified" : interrupt?.Failed == true ? "_native_interrupt_unverified" : ""));
        }
        if (primary is OperationCanceledException || (primary is null && cancellationToken.IsCancellationRequested))
        {
            throw new OperationCanceledException("offline_source_native_operation_cancelled", cancellationToken);
        }
        if (primary is not null)
        {
            if (preserveClosedCallbackFailure && primary is OfflineMigrationSourceFingerprintException fingerprint)
            {
                // The same original closed/redacted failure is legitimate only
                // after all native cleanup returned. Other callback/driver text
                // remains private, and the legacy ObserveAsync mapping is unchanged.
                System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(fingerprint).Throw();
            }
            throw new InvalidOperationException(primary is NativeFailure owned
                ? owned.Message : "offline_source_sqlite_native_operation_failed");
        }
        return result;
    }

    private static async Task RequireBoundaryAsync(SqlSugarClient database, SqliteConnection connection,
        SqliteTransaction transaction, SQLitePCL.sqlite3 handle, string nativeFilename, CancellationToken cancellationToken)
    {
        if (connection.State != ConnectionState.Open || transaction.Connection != connection
            || transaction.IsolationLevel != IsolationLevel.Serializable
            || !ReferenceEquals(connection.Handle, handle)
            || !ReferenceEquals(database.Ado.Connection, connection)
            || !ReferenceEquals(database.Ado.Transaction, transaction)
            || SQLitePCL.raw.sqlite3_db_readonly(handle, "main") != 1
            || !string.Equals(RequireNativeFilename(handle), nativeFilename, StringComparison.Ordinal))
        {
            throw new NativeFailure("offline_source_sqlite_native_read_only_session_required");
        }
        await using (var command = connection.CreateCommand())
        {
            command.Transaction = transaction;
            command.CommandText = "PRAGMA query_only";
            object? enabled = await command.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false);
            if (enabled is not long queryOnly || queryOnly != 1)
            {
                throw new NativeFailure("offline_source_sqlite_query_only_required");
            }
        }
        await using var databases = connection.CreateCommand();
        databases.Transaction = transaction;
        databases.CommandText = "PRAGMA database_list";
        await using SqliteDataReader reader = await databases.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
            || reader.GetString(1) != "main"
            || !string.Equals(reader.GetString(2), nativeFilename, StringComparison.Ordinal)
            || await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            throw new NativeFailure("offline_source_sqlite_single_persistent_database_required");
        }
    }

    private static string RequireNativeFilename(SQLitePCL.sqlite3 handle)
    {
        // This is the actual VFS filename of the open main database, not caller settings.
        // A stable name is not native descriptor/inode-generation proof: physical source
        // incarnation and restored/live backup binding still require the original verifier.
        string? filename = SQLitePCL.raw.sqlite3_db_filename(handle, "main").utf8_to_string();
        if (string.IsNullOrEmpty(filename) || !Path.IsPathFullyQualified(filename))
        {
            throw new NativeFailure("offline_source_sqlite_native_filename_required");
        }
        return filename;
    }

    // This state has no public/internal construction path outside this owner.
    // Its snapshot is never handed to a borrower for disposal or substitution.
    private sealed class OwnedReadState(
        SqlSugarClient database,
        SqliteConnection connection,
        SqliteTransaction transaction,
        SQLitePCL.sqlite3 handle,
        string nativeFilename,
        OfflineMigrationSqliteDatabaseIdentity.Snapshot snapshot,
        CancellationToken creatorCancellation)
    {
        private readonly SemaphoreSlim _boundaryGate = new(1, 1);
        private int _active = 1;

        internal DbConnection Connection
        {
            get
            {
                RequireActive();
                return connection;
            }
        }

        internal DbTransaction Transaction
        {
            get
            {
                RequireActive();
                return transaction;
            }
        }

        internal CurrentSchemaDatabaseIdentity Database
        {
            get
            {
                RequireActive();
                return snapshot.Database;
            }
        }

        internal CancellationTokenSource CreateCancellationScope(CancellationToken borrowerCancellation)
        {
            RequireActive();
            return CancellationTokenSource.CreateLinkedTokenSource(creatorCancellation, borrowerCancellation);
        }

        internal async Task RequireBoundaryAsync(CancellationToken borrowerCancellation)
        {
            using CancellationTokenSource scope = CreateCancellationScope(borrowerCancellation);
            await _boundaryGate.WaitAsync(scope.Token).ConfigureAwait(false);
            try
            {
                RequireActive();
                await OfflineMigrationSqliteNativeSession.RequireBoundaryAsync(
                    database, connection, transaction, handle, nativeFilename, scope.Token).ConfigureAwait(false);
                await snapshot.ValidateAsync(connection, transaction, scope.Token).ConfigureAwait(false);
                await OfflineMigrationSqliteNativeSession.RequireBoundaryAsync(
                    database, connection, transaction, handle, nativeFilename, scope.Token).ConfigureAwait(false);
                RequireActive();
                scope.Token.ThrowIfCancellationRequested();
            }
            finally
            {
                _boundaryGate.Release();
            }
        }

        internal async Task InvalidateAsync()
        {
            Interlocked.Exchange(ref _active, 0);
            // Do not close the original snapshot/native handle under a boundary
            // operation which already entered. Creator cancellation remains
            // registered until the original owner has awaited this terminal.
            await _boundaryGate.WaitAsync(CancellationToken.None).ConfigureAwait(false);
            _boundaryGate.Release();
        }

        private void RequireActive()
        {
            if (Volatile.Read(ref _active) == 0)
            {
                throw new InvalidOperationException("offline_source_sqlite_owned_read_context_closed");
            }
            creatorCancellation.ThrowIfCancellationRequested();
        }
    }

    /// <summary>Callback-scoped access to this owner's original held native read view.</summary>
    internal sealed class OwnedReadContext
    {
        private readonly OwnedReadState _state;

        private OwnedReadContext(OwnedReadState state) => _state = state;

        // The private state type can only be constructed by the original owner;
        // raw connection/transaction labels or an arbitrary object cannot mint this context.
        internal static OwnedReadContext CreateForOwner(object state)
            => state is OwnedReadState owned
                ? new OwnedReadContext(owned)
                : throw new InvalidOperationException("offline_source_sqlite_owned_read_owner_required");

        internal DbConnection OriginalConnection => _state.Connection;

        internal DbTransaction OriginalTransaction => _state.Transaction;

        internal CurrentSchemaDatabaseIdentity Database => _state.Database;

        /// <summary>Links the stored creator deadline with the current borrower cancellation.</summary>
        internal CancellationTokenSource CreateCancellationScope(CancellationToken borrowerCancellation)
            => _state.CreateCancellationScope(borrowerCancellation);

        /// <summary>Rechecks actual FILESTAT identity and the original read-only native boundary.</summary>
        internal Task RequireBoundaryAsync(CancellationToken borrowerCancellation)
            => _state.RequireBoundaryAsync(borrowerCancellation);
    }

    private sealed class NativeInterrupt(SQLitePCL.sqlite3 handle)
    {
        private int _failed;

        internal bool Failed => Volatile.Read(ref _failed) != 0;

        internal void Request()
        {
            try
            {
                SQLitePCL.raw.sqlite3_interrupt(handle);
            }
            catch (Exception)
            {
                // Cancellation callbacks cannot leak driver text or terminate another owner.
                Interlocked.Exchange(ref _failed, 1);
            }
        }
    }

    private sealed class NativeFailure(string code) : Exception(code)
    {
    }
}
