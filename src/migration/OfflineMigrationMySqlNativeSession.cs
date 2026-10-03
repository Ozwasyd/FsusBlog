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
        await using (var command = new MySqlCommand(
            "SELECT @@session.transaction_isolation, @@session.transaction_read_only, DATABASE()", connection, transaction))
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
            connection, transaction);
        object? count = await engineCommand.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false);
        if (count is not (long or ulong) || (count is long signed && signed != 0) || (count is ulong unsigned && unsigned != 0))
        {
            throw new NativeFailure("offline_source_mysql_transactional_tables_required");
        }
    }

    private sealed class NativeFailure(string code) : Exception(code)
    {
    }
}
