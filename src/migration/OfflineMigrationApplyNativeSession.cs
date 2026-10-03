using System.Data;
using System.Data.Common;
using System.Runtime.ExceptionServices;

using Microsoft.Data.Sqlite;
using MySqlConnector;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration;

// One borrowed connection, never a pool, replacement connection or caller transaction.
// The executor alone owns the transactions it starts on this retained native session.
internal sealed class OfflineMigrationApplyNativeSession(DbConnection connection, CurrentSchemaProviderKind provider)
{
    private bool _sqliteModeChanged;
    private ulong? _mysqlConnectionId;
    private bool _mysqlLockAttempted;
    private bool _postgresLockCleanupRequired;
    private bool _postgresLockAcquired;

    internal static bool ConnectionMatches(DbConnection connection, CurrentSchemaProviderKind provider)
        => provider switch
        {
            CurrentSchemaProviderKind.PostgreSql => connection is not (MySqlConnection or SqliteConnection), // Preserve the original PostgreSQL port and its fixtures.
            CurrentSchemaProviderKind.MySql => connection is MySqlConnection,
            CurrentSchemaProviderKind.Sqlite => connection is SqliteConnection,
            _ => false
        };

    internal async Task<bool> AcquireAsync(CancellationToken token)
    {
        if (provider == CurrentSchemaProviderKind.PostgreSql)
            return await UseCommandAsync("SELECT pg_try_advisory_lock(hashtext(@name))", async command =>
            {
                // Custody begins before submission, not after command disposal or the
                // executor's await. An unobserved result may still have acquired the lock.
                _postgresLockCleanupRequired = true;
                object? actual = await command.ExecuteScalarAsync(token).ConfigureAwait(false);
                if (actual is not bool acquired)
                    throw new InvalidOperationException("offline_apply_postgresql_lock_unobserved");
                _postgresLockAcquired = acquired;
                _postgresLockCleanupRequired = acquired;
                return acquired;
            }).ConfigureAwait(false);
        if (provider == CurrentSchemaProviderKind.MySql)
        {
            // The driver object and isolation label alone do not prove that no bare SQL
            // transaction is active. Require native instrumentation; do not enable it.
            await RequireMySqlIdleAsync(token).ConfigureAwait(false);
            object? engines = await ScalarAsync("SELECT count(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_TYPE='BASE TABLE' AND ENGINE<>'InnoDB'", token).ConfigureAwait(false);
            if (engines is null or DBNull || Convert.ToInt64(engines) != 0)
                throw new InvalidOperationException("offline_apply_mysql_transactional_tables_required");
            _mysqlLockAttempted = true; // Delivery/result failure does not prove that GET_LOCK had no effect.
            return await ReadAsync("SELECT CONNECTION_ID(), GET_LOCK(@name, 0)", token, async reader =>
            {
                if (!await reader.ReadAsync(token).ConfigureAwait(false) || reader.IsDBNull(1))
                    throw new InvalidOperationException("offline_apply_mysql_lock_unobserved");
                ulong connectionId = reader.GetFieldValue<ulong>(0);
                bool acquired = Convert.ToInt64(reader.GetValue(1)) == 1;
                if (acquired) _mysqlConnectionId = connectionId;
                if (await reader.ReadAsync(token).ConfigureAwait(false))
                    throw new InvalidOperationException("offline_apply_mysql_lock_unobserved");
                if (!acquired) _mysqlLockAttempted = false;
                return acquired;
            }).ConfigureAwait(false);
        }

        var sqlite = (SqliteConnection)connection;
        if (SQLitePCL.raw.sqlite3_get_autocommit(sqlite.Handle) != 1)
            throw new InvalidOperationException("offline_apply_caller_transaction_active");
        await ReadAsync("PRAGMA database_list", token, async reader =>
        {
            bool main = false;
            while (await reader.ReadAsync(token).ConfigureAwait(false))
            {
                string name = reader.GetString(1);
                if (name == "main" && !main && !string.IsNullOrEmpty(reader.GetString(2))) main = true;
                else if (name != "temp") throw new InvalidOperationException("offline_apply_sqlite_main_file_required");
            }
            if (!main) throw new InvalidOperationException("offline_apply_sqlite_main_file_required");
            return true;
        }).ConfigureAwait(false);
        if (await ScalarStringAsync("PRAGMA main.locking_mode", token).ConfigureAwait(false) != "normal")
            throw new InvalidOperationException("offline_apply_sqlite_caller_lock_mode_changed");
        string? journalMode = await ScalarStringAsync("PRAGMA main.journal_mode", token).ConfigureAwait(false);
        if (journalMode is not ("delete" or "truncate" or "persist" or "wal"))
            throw new InvalidOperationException("offline_apply_sqlite_durable_journal_required");
        object? synchronous = await ScalarAsync("PRAGMA main.synchronous", token).ConfigureAwait(false);
        if (synchronous is null or DBNull || Convert.ToInt64(synchronous) is not (2 or 3))
            throw new InvalidOperationException("offline_apply_sqlite_durable_commit_required");
        _sqliteModeChanged = true; // A submitted pragma may take effect even if reading its result fails.
        if (await ScalarStringAsync("PRAGMA main.locking_mode=EXCLUSIVE", token).ConfigureAwait(false) != "exclusive")
            throw new InvalidOperationException("offline_apply_sqlite_exclusive_mode_unobserved");
        // BEGIN EXCLUSIVE acquires the real database lock without changing user rows.
        // EXCLUSIVE connection mode retains it across the later journal/unit commits.
        await ExecuteAsync("BEGIN EXCLUSIVE", token).ConfigureAwait(false);
        await ExecuteAsync("ROLLBACK", token).ConfigureAwait(false);
        return true;
    }

    internal async ValueTask<DbTransaction> BeginAsync(CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        if (provider == CurrentSchemaProviderKind.MySql)
        {
            await RequireMySqlLockAsync(token).ConfigureAwait(false);
            await RequireMySqlIdleAsync(token).ConfigureAwait(false);
            return await ((MySqlConnection)connection).BeginTransactionAsync(
                IsolationLevel.RepeatableRead, isReadOnly: false, token).ConfigureAwait(false);
        }
        if (provider == CurrentSchemaProviderKind.Sqlite)
        {
            if (!_sqliteModeChanged || await ScalarStringAsync("PRAGMA main.locking_mode", token).ConfigureAwait(false) != "exclusive"
                || SQLitePCL.raw.sqlite3_get_autocommit(((SqliteConnection)connection).Handle) != 1)
                throw new InvalidOperationException("offline_apply_sqlite_original_lock_required");
            token.ThrowIfCancellationRequested();
            // Non-deferred SERIALIZABLE starts an immediate writer on the already held file.
            return ((SqliteConnection)connection).BeginTransaction(IsolationLevel.Serializable, deferred: false);
        }
        return await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead, token).ConfigureAwait(false);
    }

    internal async Task<bool> ReleaseAsync(CancellationToken token)
    {
        if (provider == CurrentSchemaProviderKind.PostgreSql)
        {
            // A submitted but unobserved result does not prove ownership of one
            // acquired increment. Do not decrement a caller's pre-existing lock.
            if (!_postgresLockAcquired)
                throw new InvalidOperationException("offline_apply_postgresql_lock_ownership_unobserved");
            return await UseCommandAsync("SELECT pg_advisory_unlock(hashtext(@name))", async command =>
            {
                object? actual = await command.ExecuteScalarAsync(token).ConfigureAwait(false);
                if (actual is not bool released)
                    throw new InvalidOperationException("offline_apply_postgresql_unlock_unobserved");
                if (released)
                {
                    _postgresLockAcquired = false;
                    _postgresLockCleanupRequired = false;
                }
                return released;
            }).ConfigureAwait(false);
        }
        if (provider == CurrentSchemaProviderKind.MySql)
        {
            await RequireMySqlLockAsync(token).ConfigureAwait(false);
            bool released = await ScalarBooleanAsync("SELECT RELEASE_LOCK(@name)", token).ConfigureAwait(false);
            if (released)
            {
                _mysqlConnectionId = null;
                _mysqlLockAttempted = false;
            }
            return released;
        }
        if (!_sqliteModeChanged) return true;
        var sqlite = (SqliteConnection)connection;
        if (SQLitePCL.raw.sqlite3_get_autocommit(sqlite.Handle) != 1)
            throw new InvalidOperationException("offline_apply_sqlite_transaction_terminal_unknown");
        if (await ScalarStringAsync("PRAGMA main.locking_mode=NORMAL", token).ConfigureAwait(false) != "normal")
            return false;
        // Changing the pragma alone does not release SQLite's retained file lock.
        _ = await ScalarAsync("SELECT count(*) FROM main.sqlite_schema", token).ConfigureAwait(false);
        _sqliteModeChanged = false;
        return true;
    }

    internal bool CleanupRequired => _postgresLockCleanupRequired || _sqliteModeChanged || _mysqlLockAttempted || _mysqlConnectionId is not null;

    private async Task RequireMySqlIdleAsync(CancellationToken token)
    {
        await ReadAsync("""
            SELECT t.INSTRUMENTED, i.ENABLED, g.ENABLED, h.ENABLED, c.ENABLED,
                EXISTS(SELECT 1 FROM performance_schema.events_transactions_current x
                    WHERE x.THREAD_ID=t.THREAD_ID AND x.STATE='ACTIVE' AND x.END_EVENT_ID IS NULL)
            FROM performance_schema.threads t
            JOIN performance_schema.setup_instruments i ON i.NAME='transaction'
            JOIN performance_schema.setup_consumers g ON g.NAME='global_instrumentation'
            JOIN performance_schema.setup_consumers h ON h.NAME='thread_instrumentation'
            JOIN performance_schema.setup_consumers c ON c.NAME='events_transactions_current'
            WHERE t.PROCESSLIST_ID=CONNECTION_ID()
            """, token, async reader =>
        {
            if (!await reader.ReadAsync(token).ConfigureAwait(false)
                || Enumerable.Range(0, 5).Any(index => reader.IsDBNull(index) || reader.GetString(index) != "YES")
                || Convert.ToBoolean(reader.GetValue(5)) || await reader.ReadAsync(token).ConfigureAwait(false))
                throw new InvalidOperationException("offline_apply_mysql_idle_native_session_required");
            return true;
        }).ConfigureAwait(false);
    }

    private async Task RequireMySqlLockAsync(CancellationToken token)
    {
        await ReadAsync("SELECT CONNECTION_ID(), IS_USED_LOCK(@name)", token, async reader =>
        {
            if (_mysqlConnectionId is null || !await reader.ReadAsync(token).ConfigureAwait(false)
                || reader.IsDBNull(1) || reader.GetFieldValue<ulong>(0) != _mysqlConnectionId
                || Convert.ToUInt64(reader.GetValue(1)) != _mysqlConnectionId || await reader.ReadAsync(token).ConfigureAwait(false))
                throw new InvalidOperationException("offline_apply_mysql_original_lock_required");
            return true;
        }).ConfigureAwait(false);
    }

    private DbCommand Command(string sql) => OfflineMigrationStateStore.NativeCommand(connection, null, sql);
    private static void Parameter(DbCommand command, string name, object value)
        => OfflineMigrationStateStore.Parameter(command, name, value);
    private async Task<bool> ScalarBooleanAsync(string sql, CancellationToken token)
    {
        object? value = await UseCommandAsync(sql, command => command.ExecuteScalarAsync(token)).ConfigureAwait(false);
        return value is not null && value is not DBNull && Convert.ToInt64(value) == 1;
    }
    private async Task<string?> ScalarStringAsync(string sql, CancellationToken token)
    {
        return await ScalarAsync(sql, token).ConfigureAwait(false) as string;
    }
    private async Task ExecuteAsync(string sql, CancellationToken token)
    {
        await UseCommandAsync(sql, command => command.ExecuteNonQueryAsync(token)).ConfigureAwait(false);
    }

    private Task<object?> ScalarAsync(string sql, CancellationToken token)
        => UseCommandAsync(sql, command => command.ExecuteScalarAsync(token));

    // Capture primary failures before reader/command disposal. A disposal error is
    // separately retained on the original exception using the existing Core marker.
    private Task<T> ReadAsync<T>(string sql, CancellationToken token, Func<DbDataReader, Task<T>> read)
        => UseCommandAsync(sql, async command =>
        {
            DbDataReader reader = await command.ExecuteReaderAsync(token).ConfigureAwait(false);
            Exception? first = null;
            T result = default!;
            try { result = await read(reader).ConfigureAwait(false); }
            catch (Exception failure) { first = failure; }
            try { await reader.DisposeAsync().ConfigureAwait(false); }
            catch (Exception cleanup)
            {
                first ??= cleanup;
                first.Data[OfflineMigrationStateStore.JournalCleanupFailuresKey] = "offline_apply_journal_command_disposal_failed";
            }
            if (first is not null) ExceptionDispatchInfo.Capture(first).Throw();
            return result;
        });

    private async Task<T> UseCommandAsync<T>(string sql, Func<DbCommand, Task<T>> execute)
    {
        DbCommand command = Command(sql);
        Exception? first = null;
        T result = default!;
        try
        {
            if (sql.Contains("@name", StringComparison.Ordinal)) Parameter(command, "@name", OfflineMigrationHost.StateLockConstant);
            result = await execute(command).ConfigureAwait(false);
        }
        catch (Exception failure) { first = failure; }
        try { await command.DisposeAsync().ConfigureAwait(false); }
        catch (Exception cleanup)
        {
            first ??= cleanup;
            first.Data[OfflineMigrationStateStore.JournalCleanupFailuresKey] = "offline_apply_journal_command_disposal_failed";
        }
        if (first is not null) ExceptionDispatchInfo.Capture(first).Throw();
        return result;
    }
}
