using System.Data;
using System.Data.Common;
using System.Runtime.ExceptionServices;

using Microsoft.Data.Sqlite;

using MySqlConnector;

using Npgsql;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration;

// One borrowed connection, never a pool, replacement connection or caller transaction.
// The executor alone owns the transactions it starts on this retained native session.
internal sealed class OfflineMigrationApplyNativeSession(DbConnection connection, CurrentSchemaProviderKind provider,
    CancellationToken creatorToken = default, Func<CancellationToken>? cleanupToken = null,
    OfflineMigrationPostgreSqlWriteLock? postgreSqlWriteLock = null)
{
    // The source owner supplies its canonical family namespace/key. This port only
    // holds that existing lock before the offline lock and before any RR snapshot.
    private bool _postgresWriteLockAcquired;
    private bool _postgresWriteLockCleanupRequired;
    private bool _postgresOfflineLockAttempted;
    private bool _sqliteModeChanged;
    private ulong? _mysqlConnectionId;
    private bool _mysqlLockAttempted;
    private bool _postgresLockCleanupRequired;
    private bool _postgresLockAcquired;
    private int? _postgresProcessId;
    private DbTransaction? _originalTransaction;
    private NativeReadProof? _originalTransactionProof;
    private CurrentSchemaDatabaseIdentity? _originalDatabase;
    private OwnedReadContext? _activeReadContext;
    private int _readScopeActive;
    private OfflineMigrationPostgreSqlWriteLock? PostgreSqlWriteLock => postgreSqlWriteLock;
    private DbConnection NativeConnection => connection;
    private CancellationToken CreatorCancellation => creatorToken;
    internal const string OwnedScopeCleanupFailuresKey = "FsusBlog.Migration.OwnedScopeCleanupFailures";
    internal const string OwnedScopeCleanupExceptionsKey = "FsusBlog.Migration.OwnedScopeCleanupExceptions";

    internal bool SupportsOwnedReadContext => connection is NpgsqlConnection or MySqlConnection or SqliteConnection;

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
        token.ThrowIfCancellationRequested();
        if (postgreSqlWriteLock is not null && provider != CurrentSchemaProviderKind.PostgreSql)
            throw new InvalidOperationException("offline_apply_original_postgresql_write_required");
        if (provider == CurrentSchemaProviderKind.PostgreSql)
        {
            if (postgreSqlWriteLock is not null)
            {
                if (connection is not NpgsqlConnection native || _postgresOfflineLockAttempted
                    || _postgresWriteLockCleanupRequired || _originalTransaction is not null)
                    throw new InvalidOperationException("offline_apply_write_lock_order_required");
                _postgresProcessId = native.ProcessID;
                _postgresWriteLockCleanupRequired = true; // Submission may acquire it despite an unobserved response.
                bool acquired = await UseCommandAsync(
                    "SELECT pg_try_advisory_lock(@familyNamespace, @familyKey)", async command =>
                    {
                        Parameter(command, "@familyNamespace", postgreSqlWriteLock.Namespace);
                        Parameter(command, "@familyKey", postgreSqlWriteLock.Key);
                        object? actual = await command.ExecuteScalarAsync(token).ConfigureAwait(false);
                        if (actual is not bool value)
                            throw new InvalidOperationException("offline_apply_write_lock_unobserved");
                        _postgresWriteLockAcquired = value;
                        _postgresWriteLockCleanupRequired = value;
                        return value;
                    }).ConfigureAwait(false);
                if (!acquired)
                    return false;
            }
            _postgresOfflineLockAttempted = true;
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
                if (acquired && connection is NpgsqlConnection postgres) _postgresProcessId = postgres.ProcessID;
                return acquired;
            }).ConfigureAwait(false);
        }
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

    internal ValueTask<DbTransaction> BeginAsync(CancellationToken token)
        => BeginCoreAsync(token, mintReadProof: false);

    internal async ValueTask<DbTransaction> BeginOwnedReadAsync(CancellationToken borrowerToken)
    {
        using CancellationTokenSource scope = CreateCreatorReadScope(borrowerToken);
        // Actual SQLite state/held-file identity does not supply a transaction
        // epoch: bare COMMIT followed by BEGIN on that same handle is not proved
        // continuous. Keep the original BasicBegin port, but never mint a false
        // writer read capability or manufacture an epoch from a GUID/boolean.
        if (provider == CurrentSchemaProviderKind.Sqlite)
            throw new InvalidOperationException("offline_apply_sqlite_transaction_epoch_unavailable");
        return await BeginCoreAsync(scope.Token, mintReadProof: true).ConfigureAwait(false);
    }

    // The original finite cleanup budget is independent of main cancellation.
    // This path cannot mint a source-read context or bypass original admission.
    internal async ValueTask<DbTransaction> BeginCleanupAsync(CancellationToken token)
    {
        DbTransaction transaction = await BeginCoreAsync(token, mintReadProof: false).ConfigureAwait(false);
        if (!SupportsOwnedReadContext || _originalDatabase is null) return transaction;
        Exception? first = null;
        try
        {
            NativeReadProof actual = await ReadNativeReadProofAsync(transaction, token).ConfigureAwait(false);
            if (actual.Database != _originalDatabase)
                throw new InvalidOperationException("offline_apply_original_database_changed");
            token.ThrowIfCancellationRequested();
            return transaction;
        }
        catch (Exception failure) { first = failure; }
        try { await transaction.RollbackAsync(token).ConfigureAwait(false); }
        catch (Exception cleanup) { RecordScopeCleanup(ref first, cleanup); }
        try { await transaction.DisposeAsync().ConfigureAwait(false); }
        catch (Exception cleanup) { RecordScopeCleanup(ref first, cleanup); }
        _originalTransaction = null;
        _originalTransactionProof = null;
        ExceptionDispatchInfo.Capture(first!).Throw();
        throw new InvalidOperationException("offline_apply_owned_cleanup_begin_failed");
    }

    private async ValueTask<DbTransaction> BeginCoreAsync(CancellationToken token, bool mintReadProof)
    {
        token.ThrowIfCancellationRequested();
        if (SupportsOwnedReadContext && mintReadProof)
        {
            creatorToken.ThrowIfCancellationRequested();
            if (!creatorToken.CanBeCanceled || cleanupToken is null)
                throw new InvalidOperationException("offline_apply_owned_cleanup_required");
        }
        // A caller may have closed/reopened this same driver object. Do not
        // start even a cleanup transaction on a replacement PostgreSQL session.
        if (provider == CurrentSchemaProviderKind.PostgreSql && connection is NpgsqlConnection postgres
            && (!_postgresLockAcquired || connection.State != ConnectionState.Open
                || postgres.ProcessID != _postgresProcessId))
            throw new InvalidOperationException("offline_apply_original_session_required");
        DbTransaction transaction;
        if (provider == CurrentSchemaProviderKind.MySql)
        {
            await RequireMySqlLockAsync(token).ConfigureAwait(false);
            await RequireMySqlIdleAsync(token).ConfigureAwait(false);
            transaction = await ((MySqlConnection)connection).BeginTransactionAsync(
                IsolationLevel.RepeatableRead, isReadOnly: false, token).ConfigureAwait(false);
        }
        else if (provider == CurrentSchemaProviderKind.Sqlite)
        {
            if (!_sqliteModeChanged || await ScalarStringAsync("PRAGMA main.locking_mode", token).ConfigureAwait(false) != "exclusive"
                || SQLitePCL.raw.sqlite3_get_autocommit(((SqliteConnection)connection).Handle) != 1)
                throw new InvalidOperationException("offline_apply_sqlite_original_lock_required");
            token.ThrowIfCancellationRequested();
            // Non-deferred SERIALIZABLE starts an immediate writer on the already held file.
            transaction = ((SqliteConnection)connection).BeginTransaction(IsolationLevel.Serializable, deferred: false);
        }
        else transaction = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead, token).ConfigureAwait(false);

        // The original executor owns this actual Begin result. A matching tuple supplied
        // later cannot mint a context, nor can a caller register a driver object as proof.
        _originalTransaction = transaction;
        _originalTransactionProof = null;
        if (!SupportsOwnedReadContext || !mintReadProof) return transaction; // Never a native read capability.
        Exception? first = null;
        try
        {
            using CancellationTokenSource scope = CreateCreatorReadScope(token);
            if (cleanupToken is null) throw new InvalidOperationException("offline_apply_owned_cleanup_required");
            _originalTransactionProof = await ReadNativeReadProofAsync(transaction, scope.Token).ConfigureAwait(false);
            if (_originalDatabase is not null && _originalDatabase != _originalTransactionProof.Database)
                throw new InvalidOperationException("offline_apply_original_database_changed");
            _originalDatabase ??= _originalTransactionProof.Database;
            scope.Token.ThrowIfCancellationRequested();
            return transaction;
        }
        catch (Exception failure) { first = failure; }
        try { await transaction.RollbackAsync(cleanupToken!()).ConfigureAwait(false); }
        catch (Exception cleanup) { RecordScopeCleanup(ref first, cleanup); }
        try { await transaction.DisposeAsync().ConfigureAwait(false); }
        catch (Exception cleanup) { RecordScopeCleanup(ref first, cleanup); }
        _originalTransaction = null;
        _originalTransactionProof = null;
        ExceptionDispatchInfo.Capture(first!).Throw();
        throw new InvalidOperationException("offline_apply_owned_begin_failed");
    }

    internal async Task<bool> ReleaseAsync(CancellationToken token)
    {
        if (provider == CurrentSchemaProviderKind.PostgreSql)
        {
            // Do not decrement a caller's lock on a replacement backend opened
            // through this same driver object. Unknown original custody remains
            // a recovery obligation; it is not cleared by inspecting/releasing
            // another session, closing caller resources, or issuing unlock-all.
            if (connection is NpgsqlConnection postgres
                && (connection.State != ConnectionState.Open || postgres.ProcessID != _postgresProcessId))
                throw new InvalidOperationException("offline_apply_original_session_required");
            // Release in reverse order. Unobserved ownership is never guessed, and
            // failure to release the inner lock keeps the outer lock in custody.
            if (_postgresLockCleanupRequired && !_postgresLockAcquired)
                throw new InvalidOperationException("offline_apply_postgresql_lock_ownership_unobserved");
            if (_postgresLockAcquired)
            {
                bool released = await UseCommandAsync("SELECT pg_advisory_unlock(hashtext(@name))", async command =>
                {
                    object? actual = await command.ExecuteScalarAsync(token).ConfigureAwait(false);
                    if (actual is not bool value)
                        throw new InvalidOperationException("offline_apply_postgresql_unlock_unobserved");
                    if (value)
                    {
                        _postgresLockAcquired = false;
                        _postgresLockCleanupRequired = false;
                    }
                    return value;
                }).ConfigureAwait(false);
                if (!released)
                    return false;
            }
            if (_postgresWriteLockCleanupRequired && !_postgresWriteLockAcquired)
                throw new InvalidOperationException("offline_apply_write_lock_ownership_unobserved");
            if (_postgresWriteLockAcquired)
            {
                bool released = await UseCommandAsync(
                    "SELECT pg_advisory_unlock(@familyNamespace, @familyKey)", async command =>
                    {
                        Parameter(command, "@familyNamespace", postgreSqlWriteLock!.Namespace);
                        Parameter(command, "@familyKey", postgreSqlWriteLock.Key);
                        object? actual = await command.ExecuteScalarAsync(token).ConfigureAwait(false);
                        if (actual is not bool value)
                            throw new InvalidOperationException("offline_apply_write_unlock_unobserved");
                        if (value)
                        {
                            _postgresWriteLockAcquired = false;
                            _postgresWriteLockCleanupRequired = false;
                        }
                        return value;
                    }).ConfigureAwait(false);
                if (!released)
                    return false;
            }
            return true;
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

    internal bool CleanupRequired => _postgresWriteLockCleanupRequired || _postgresLockCleanupRequired || _sqliteModeChanged || _mysqlLockAttempted || _mysqlConnectionId is not null;

    internal async Task WithOwnedReadScopeAsync(DbTransaction transaction,
        Func<OwnedReadContext, CancellationToken, Task> read, CancellationToken borrowerToken)
    {
        ArgumentNullException.ThrowIfNull(read);
        using CancellationTokenSource scope = CreateCreatorReadScope(borrowerToken);
        // This is only the lifetime gate of this one callback, not another
        // database lock. Reserve it before any await; two callbacks cannot mint
        // overlapping capabilities from the same original Begin proof.
        if (Interlocked.CompareExchange(ref _readScopeActive, 1, 0) != 0)
            throw new InvalidOperationException("offline_apply_owned_read_scope_active");
        OwnedReadContext? context = null;
        Exception? first = null;
        try
        {
            RequireOriginalTransaction(transaction);
            if (_activeReadContext is not null || _originalTransactionProof is null)
                throw new InvalidOperationException("offline_apply_owned_read_scope_required");
            NativeReadProof actual = await ReadNativeReadProofAsync(transaction, scope.Token).ConfigureAwait(false);
            if (actual != _originalTransactionProof)
                throw new InvalidOperationException("offline_apply_original_transaction_changed");
            context = OwnedReadContext.Mint(this, transaction, scope.Token);
            _activeReadContext = context;
            await context.RequireBoundaryAsync(scope.Token).ConfigureAwait(false);
            await read(context, scope.Token).ConfigureAwait(false);
            await context.RequireBoundaryAsync(scope.Token).ConfigureAwait(false);
            scope.Token.ThrowIfCancellationRequested();
        }
        catch (Exception failure) { first = failure; }
        if (first is not null && cleanupToken is not null)
        {
            // Begin the original single independent cleanup budget at this
            // failure boundary, not a fresh timeout after terminal draining.
            // Its expiry cannot stand in for completion of entered native IO.
            try { _ = cleanupToken(); }
            catch (Exception cleanup) { RecordScopeCleanup(ref first, cleanup); }
        }
        // Close admission and await the original entered-boundary gate before
        // clearing this context, releasing the callback gate or letting the
        // executor roll back/dispose. Cancellation alone is not IO terminal.
        try { if (context is not null) await context.InvalidateAsync().ConfigureAwait(false); }
        catch (Exception cleanup) { RecordScopeCleanup(ref first, cleanup); }
        finally
        {
            _activeReadContext = null;
            Volatile.Write(ref _readScopeActive, 0);
        }
        if (first is not null) ExceptionDispatchInfo.Capture(first).Throw();
    }

    private CancellationTokenSource CreateCreatorReadScope(CancellationToken borrowerToken)
    {
        creatorToken.ThrowIfCancellationRequested();
        borrowerToken.ThrowIfCancellationRequested();
        if (!creatorToken.CanBeCanceled)
            throw new InvalidOperationException("offline_apply_owned_creator_token_required");
        return CancellationTokenSource.CreateLinkedTokenSource(creatorToken, borrowerToken);
    }

    private void RequireOriginalTransaction(DbTransaction transaction)
    {
        DbConnection? transactionConnection;
        try
        {
            transactionConnection = transaction.Connection;
        }
        catch (InvalidOperationException) { throw new InvalidOperationException("offline_apply_original_transaction_required"); }
        if (!SupportsOwnedReadContext || !ReferenceEquals(transaction, _originalTransaction)
            || connection.State != ConnectionState.Open || transactionConnection != connection
            || (provider == CurrentSchemaProviderKind.PostgreSql && (connection.GetType() != typeof(NpgsqlConnection)
                || transaction.GetType() != typeof(NpgsqlTransaction) || !_postgresLockAcquired
                || ((NpgsqlConnection)connection).ProcessID != _postgresProcessId))
            || (provider == CurrentSchemaProviderKind.MySql && (connection.GetType() != typeof(MySqlConnection)
                || transaction.GetType() != typeof(MySqlTransaction) || _mysqlConnectionId is null))
            || (provider == CurrentSchemaProviderKind.Sqlite && (connection.GetType() != typeof(SqliteConnection)
                || transaction.GetType() != typeof(SqliteTransaction) || !_sqliteModeChanged)))
            throw new InvalidOperationException("offline_apply_original_transaction_required");
    }

    private async Task<NativeReadProof> ReadNativeReadProofAsync(DbTransaction transaction, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        RequireOriginalTransaction(transaction);
        if (provider == CurrentSchemaProviderKind.PostgreSql)
        {
            await RequirePostgreSqlWriteLockAsync(transaction, token).ConfigureAwait(false);
            // The existing issuer alone owns the native database identity SQL.
            CurrentSchemaDatabaseIdentity database = await OfflineMigrationCurrentSchemaIssuer.ReadNativeIdentityAsync(
                connection, transaction, token).ConfigureAwait(false);
            string epoch = await ReadAsync("""
                SELECT pg_current_xact_id()::text, pg_backend_pid(),
                    current_setting('transaction_isolation'), current_setting('transaction_read_only'),
                    EXISTS(SELECT 1 FROM pg_catalog.pg_locks
                        WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted AND mode='ExclusiveLock'
                          AND database=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())
                          AND objsubid=1 AND ((classid::bigint << 32) | objid::bigint)=hashtext(@name)::bigint)
                """, token, async reader =>
            {
                if (!await reader.ReadAsync(token).ConfigureAwait(false) || reader.IsDBNull(0)
                    || string.IsNullOrEmpty(reader.GetString(0)) || reader.GetInt32(1) != _postgresProcessId
                    || reader.GetString(2) != "repeatable read" || reader.GetString(3) != "off"
                    || !reader.GetBoolean(4))
                    throw new InvalidOperationException("offline_apply_postgresql_owned_transaction_unobserved");
                string value = reader.GetString(0);
                if (await reader.ReadAsync(token).ConfigureAwait(false))
                    throw new InvalidOperationException("offline_apply_postgresql_owned_transaction_unobserved");
                return value;
            }, transaction).ConfigureAwait(false);
            token.ThrowIfCancellationRequested();
            RequireOriginalTransaction(transaction);
            return new(database, epoch);
        }
        if (provider == CurrentSchemaProviderKind.MySql)
        {
            await RequireMySqlLockAsync(token, transaction).ConfigureAwait(false);
            // These are measured identity materials, not session defaults granting an
            // access mode. The actual original transaction is proved below from P_S.
            OfflineMigrationSourceObserver.MySqlNativeIdentityMaterial material =
                await OfflineMigrationSourceObserver.ReadMySqlNativeIdentityMaterialAsync(
                    connection, transaction, token).ConfigureAwait(false);
            string epoch = await ReadAsync("""
                SELECT t.THREAD_ID, x.EVENT_ID, x.STATE, x.END_EVENT_ID, x.ACCESS_MODE,
                    x.ISOLATION_LEVEL, x.AUTOCOMMIT, t.INSTRUMENTED, i.ENABLED, g.ENABLED, h.ENABLED, c.ENABLED
                FROM performance_schema.threads t
                JOIN performance_schema.events_transactions_current x ON x.THREAD_ID=t.THREAD_ID
                JOIN performance_schema.setup_instruments i ON i.NAME='transaction'
                JOIN performance_schema.setup_consumers g ON g.NAME='global_instrumentation'
                JOIN performance_schema.setup_consumers h ON h.NAME='thread_instrumentation'
                JOIN performance_schema.setup_consumers c ON c.NAME='events_transactions_current'
                WHERE t.PROCESSLIST_ID=CONNECTION_ID()
                """, token, async reader =>
            {
                if (!await reader.ReadAsync(token).ConfigureAwait(false) || reader.IsDBNull(0) || reader.IsDBNull(1)
                    || reader.GetString(2) != "ACTIVE" || !reader.IsDBNull(3) || reader.GetString(4) != "READ WRITE"
                    || reader.GetString(5) != "REPEATABLE READ" || reader.GetString(6) != "NO"
                    || Enumerable.Range(7, 5).Any(index => reader.IsDBNull(index) || reader.GetString(index) != "YES"))
                    throw new InvalidOperationException("offline_apply_mysql_owned_transaction_unobserved");
                string value = string.Create(System.Globalization.CultureInfo.InvariantCulture,
                    $"{reader.GetFieldValue<ulong>(0)}/{reader.GetFieldValue<ulong>(1)}");
                if (await reader.ReadAsync(token).ConfigureAwait(false))
                    throw new InvalidOperationException("offline_apply_mysql_owned_transaction_unobserved");
                return value;
            }, transaction).ConfigureAwait(false);
            await RequireMySqlLockAsync(token, transaction).ConfigureAwait(false);
            token.ThrowIfCancellationRequested();
            RequireOriginalTransaction(transaction);
            return new(material.Database, epoch);
        }

        throw new InvalidOperationException("offline_apply_sqlite_transaction_epoch_unavailable");
    }

    private async Task RequirePostgreSqlWriteLockAsync(DbTransaction transaction, CancellationToken token)
    {
        if (postgreSqlWriteLock is null)
            return;
        if (!_postgresWriteLockAcquired)
            throw new InvalidOperationException("offline_apply_write_lock_required");
        bool held = await UseCommandAsync("""
            SELECT EXISTS(SELECT 1 FROM pg_catalog.pg_locks
                WHERE locktype='advisory' AND pid=pg_backend_pid() AND granted AND mode='ExclusiveLock'
                  AND database=(SELECT oid FROM pg_catalog.pg_database WHERE datname=current_database())
                  AND classid=@familyNamespace::oid AND objid=@familyKey::oid AND objsubid=2)
            """, async command =>
        {
            Parameter(command, "@familyNamespace", postgreSqlWriteLock.Namespace);
            Parameter(command, "@familyKey", postgreSqlWriteLock.Key);
            return (bool)(await command.ExecuteScalarAsync(token).ConfigureAwait(false))!;
        }, transaction).ConfigureAwait(false);
        if (!held)
            throw new InvalidOperationException("offline_apply_write_lock_lost");
    }

    private sealed record NativeReadProof(CurrentSchemaDatabaseIdentity Database, string TransactionEpoch);

    private static void RecordScopeCleanup(ref Exception? first, Exception cleanup)
    {
        first ??= cleanup;
        first.Data[OwnedScopeCleanupFailuresKey] = "offline_apply_owned_scope_cleanup_failed";
        if (first.Data[OwnedScopeCleanupExceptionsKey] is not List<Exception> failures)
        {
            failures = [];
            first.Data[OwnedScopeCleanupExceptionsKey] = failures;
        }
        failures.Add(cleanup); // Internal diagnostic custody only; never journal/DTO error details.
    }

    internal sealed class OwnedReadContext
    {
        private readonly OfflineMigrationApplyNativeSession _owner;
        private readonly DbTransaction _transaction;
        private readonly NativeReadProof _proof;
        private readonly CancellationToken _callbackToken;
        private readonly CancellationTokenSource _lifetime = new();
        // The same entered-boundary mechanic as the original b414 SQLite read
        // owner: serialize this port's IO, then join its terminal gate. This is
        // not another native lock, arbitrary callback-IO tracker or epoch proof.
        private readonly SemaphoreSlim _boundaryGate = new(1, 1);
        private int _active = 1;

        private OwnedReadContext(OfflineMigrationApplyNativeSession owner, DbTransaction transaction, NativeReadProof proof,
            CancellationToken callbackToken)
        {
            _owner = owner;
            _transaction = transaction;
            _proof = proof;
            _callbackToken = callbackToken;
        }

        // Only the original awaited owner scope activates this privately constructed
        // object. Activation alone is insufficient: all native proofs are re-read.
        internal static OwnedReadContext Mint(OfflineMigrationApplyNativeSession owner, DbTransaction transaction,
            CancellationToken callbackToken)
        {
            owner.RequireOriginalTransaction(transaction);
            NativeReadProof proof = owner._originalTransactionProof
                ?? throw new InvalidOperationException("offline_apply_owned_read_scope_required");
            return new(owner, transaction, proof, callbackToken);
        }

        internal DbConnection OriginalConnection { get { RequireActive(); return _owner.NativeConnection; } }
        internal DbTransaction OriginalTransaction { get { RequireActive(); return _transaction; } }
        internal CurrentSchemaDatabaseIdentity Database { get { RequireActive(); return _proof.Database; } }
        internal CurrentSchemaProviderKind Provider => Database.Provider;

        // Borrow the real original RW transaction; never open a SqlSugar read session.
        // The supplied key is a measured handoff, not authority to allocate counters.
        internal OfflineMigrationPostgreSqlWriteLock RequirePostgreSqlWriteLock()
        {
            RequireActive();
            if (Provider != CurrentSchemaProviderKind.PostgreSql || !_owner._postgresWriteLockAcquired
                || _owner.PostgreSqlWriteLock is null)
                throw new InvalidOperationException("offline_apply_write_lock_required");
            return _owner.PostgreSqlWriteLock;
        }

        internal CancellationTokenSource CreateReadScope(CancellationToken borrowerToken)
        {
            RequireActive();
            borrowerToken.ThrowIfCancellationRequested();
            return CancellationTokenSource.CreateLinkedTokenSource(
                _owner.CreatorCancellation, _callbackToken, borrowerToken, _lifetime.Token);
        }

        internal async Task RequireBoundaryAsync(CancellationToken borrowerToken)
        {
            using CancellationTokenSource scope = CreateReadScope(borrowerToken);
            await _boundaryGate.WaitAsync(scope.Token).ConfigureAwait(false);
            try
            {
                RequireActive();
                _owner.RequireOriginalTransaction(_transaction);
                NativeReadProof actual = await _owner.ReadNativeReadProofAsync(_transaction, scope.Token).ConfigureAwait(false);
                scope.Token.ThrowIfCancellationRequested();
                RequireActive();
                if (actual != _proof || actual != _owner._originalTransactionProof)
                    throw new InvalidOperationException("offline_apply_original_transaction_changed");
            }
            finally { _boundaryGate.Release(); } // All this port's native IO/disposers already returned.
        }

        private void RequireActive()
        {
            _owner.CreatorCancellation.ThrowIfCancellationRequested();
            _callbackToken.ThrowIfCancellationRequested();
            if (Volatile.Read(ref _active) != 1 || !ReferenceEquals(_owner._activeReadContext, this))
                throw new InvalidOperationException("offline_apply_owned_read_scope_expired");
        }

        internal async Task InvalidateAsync()
        {
            // First seal admission to this capability; do not clear original
            // context custody or dispose its cancellation state while an
            // already-entered boundary still owns the original native handle.
            Interlocked.Exchange(ref _active, 0);
            Exception? first = null;
            try { _lifetime.Cancel(throwOnFirstException: false); }
            catch (Exception cleanup) { first = cleanup; }
            // Exactly the original b414 terminal-drain contract. None means an
            // actual join, not a tokenless rollback/query or a bounded-cleanup
            // claim. If native IO does not terminate, no scope/handle release is
            // declared; the original physical deadline remains a prerequisite.
            await _boundaryGate.WaitAsync(CancellationToken.None).ConfigureAwait(false);
            _boundaryGate.Release();
            try { _lifetime.Dispose(); }
            catch (Exception cleanup) { RecordScopeCleanup(ref first, cleanup); }
            if (first is not null) ExceptionDispatchInfo.Capture(first).Throw();
        }
    }

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

    private async Task RequireMySqlLockAsync(CancellationToken token, DbTransaction? transaction = null)
    {
        await ReadAsync("SELECT CONNECTION_ID(), IS_USED_LOCK(@name)", token, async reader =>
        {
            if (_mysqlConnectionId is null || !await reader.ReadAsync(token).ConfigureAwait(false)
                || reader.IsDBNull(1) || reader.GetFieldValue<ulong>(0) != _mysqlConnectionId
                || Convert.ToUInt64(reader.GetValue(1)) != _mysqlConnectionId || await reader.ReadAsync(token).ConfigureAwait(false))
                throw new InvalidOperationException("offline_apply_mysql_original_lock_required");
            return true;
        }, transaction).ConfigureAwait(false);
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
    private Task<T> ReadAsync<T>(string sql, CancellationToken token, Func<DbDataReader, Task<T>> read,
        DbTransaction? transaction = null)
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
        }, transaction);

    private async Task<T> UseCommandAsync<T>(string sql, Func<DbCommand, Task<T>> execute,
        DbTransaction? transaction = null)
    {
        DbCommand command = transaction is null ? Command(sql) : OfflineMigrationStateStore.NativeCommand(connection, transaction, sql);
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

// Descriptor exported by the sole source owner; no allocator, generation value or
// hardcoded duplicate namespace lives in Migration. This lock spans all original
// offline transactions so the first RR snapshot follows the previous family writer.
internal sealed record OfflineMigrationPostgreSqlWriteLock(int Namespace, int Key);
