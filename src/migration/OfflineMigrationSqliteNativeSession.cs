using System.Data;
using System.Data.Common;

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
        return ReadAsync(connectionString, observe, cancellationToken);
    }

    private static async Task<OfflineMigrationSourceObservation> ReadAsync(
        string connectionString,
        Func<DbConnection, DbTransaction, CancellationToken, Task<OfflineMigrationSourceObservation>> observe,
        CancellationToken cancellationToken)
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
        OfflineMigrationSourceObservation result = default!;
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
            result = await observe(connection, transaction, cancellationToken).ConfigureAwait(false);
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
        ThrowAfterCleanup(primary, transactionCleanup, connectionCleanup, adapterCleanup, cancellationToken,
            registrationUnverified, interrupt?.Failed == true);
        return result;
    }

    internal static void ThrowAfterCleanup(Exception? primary,
        OfflineMigrationPostgreSqlNativeSession.CleanupState transactionCleanup,
        OfflineMigrationPostgreSqlNativeSession.CleanupState connectionCleanup,
        OfflineMigrationPostgreSqlNativeSession.CleanupState adapterCleanup, CancellationToken cancellationToken,
        bool registrationUnverified = false, bool nativeInterruptUnverified = false)
    {
        if (registrationUnverified || nativeInterruptUnverified
            || transactionCleanup == OfflineMigrationPostgreSqlNativeSession.CleanupState.Unverified
            || connectionCleanup == OfflineMigrationPostgreSqlNativeSession.CleanupState.Unverified
            || adapterCleanup == OfflineMigrationPostgreSqlNativeSession.CleanupState.Unverified)
        {
            string code = OfflineMigrationPostgreSqlNativeSession.CleanupFailureCode(
                primary, transactionCleanup, connectionCleanup, adapterCleanup);
            throw new InvalidOperationException(code + (registrationUnverified
                ? "_cancellation_registration_unverified" : nativeInterruptUnverified ? "_native_interrupt_unverified" : ""));
        }
        if (primary is OperationCanceledException || (primary is null && cancellationToken.IsCancellationRequested))
        {
            throw new OperationCanceledException("offline_source_native_operation_cancelled", cancellationToken);
        }
        if (primary is not null)
        {
            if (primary is OfflineMigrationSourceFingerprintException)
            {
                // Only the original redacted typed transport may cross this boundary;
                // reuse the PG owner's exact rethrow after all actual cleanup returns.
                OfflineMigrationPostgreSqlNativeSession.ThrowAfterCleanup(primary,
                    transactionCleanup, connectionCleanup, adapterCleanup, cancellationToken);
            }
            throw new InvalidOperationException(primary is NativeFailure owned
                ? owned.Message : "offline_source_sqlite_native_operation_failed");
        }
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
