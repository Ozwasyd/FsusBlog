using System.Data;
using System.Data.Common;
using System.Runtime.InteropServices;
using System.Security.Cryptography;

using Npgsql;
using SqlSugar;

namespace FsusBlog.Migration;

/// <summary>
/// Owns the source reader's SqlSugar/Npgsql read-only repeatable-read session, or
/// borrows the original apply owner's proven native write context without lifecycle ownership.
/// Content vocabulary belongs to the source observer; dump execution belongs to the backup
/// owner. Caller cancellation carries the original operation owner's explicit deadline.
/// A returned result means owned native disposal completed, not provider/restore acceptance.
/// </summary>
internal static class OfflineMigrationPostgreSqlNativeSession
{
    // Native write adapter for a compiled owner. The read-only SqlSugar factory
    // below cannot supply this capability. No connection/transaction is opened,
    // registered, committed, rolled back, detached or disposed by this borrower.
    internal static async Task<T> WithOriginalWriteAsync<T>(
        OfflineMigrationApplyNativeSession.OwnedReadContext originalWrite,
        Func<NpgsqlConnection, NpgsqlTransaction, CancellationToken, Task<T>> write,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(originalWrite);
        ArgumentNullException.ThrowIfNull(write);
        using CancellationTokenSource scope = originalWrite.CreateReadScope(cancellationToken);
        _ = originalWrite.RequirePostgreSqlWriteLock();
        await originalWrite.RequireBoundaryAsync(scope.Token).ConfigureAwait(false);
        if (originalWrite.OriginalConnection is not NpgsqlConnection connection
            || originalWrite.OriginalTransaction is not NpgsqlTransaction transaction)
            throw new InvalidOperationException("offline_apply_original_postgresql_write_required");
        OfflineMigrationSourceObserver.RequirePostgreSqlStageSession(connection, transaction);
        T result = await write(connection, transaction, scope.Token).ConfigureAwait(false);
        await originalWrite.RequireBoundaryAsync(scope.Token).ConfigureAwait(false);
        scope.Token.ThrowIfCancellationRequested();
        return result;
    }

    internal static Task<OfflineMigrationSourceObservation> ObserveAsync(
        string connectionString,
        Func<DbConnection, DbTransaction, CancellationToken, Task<OfflineMigrationSourceObservation>> observe,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(observe);
        return WithSessionAsync(connectionString, async (connection, transaction, token) =>
        {
            await RequireReadOnlyAsync(connection, transaction, token).ConfigureAwait(false);
            OfflineMigrationSourceObservation source = await observe(connection, transaction, token).ConfigureAwait(false);
            RequireSession(connection, transaction);
            token.ThrowIfCancellationRequested();
            return source;
        }, cancellationToken);
    }

    internal static Task<(OfflineMigrationSourceObservation Source, string SnapshotId, DateTimeOffset CapturedAt, string DumpSha256)> CaptureAsync(
        string connectionString,
        Func<DbConnection, DbTransaction, CancellationToken, Task<OfflineMigrationSourceObservation>> observe,
        Func<OfflineMigrationSourceObservation, string, DateTimeOffset, CancellationToken, Task<string>> awaitCompletedDumpPath,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(observe);
        ArgumentNullException.ThrowIfNull(awaitCompletedDumpPath);
        return WithSessionAsync(connectionString, async (connection, transaction, token) =>
        {
            // This is the first snapshot-bearing query, before a potentially long full scan.
            // Native DB time binds this export; it is not a Host post-scan timestamp or signature.
            (string snapshotId, DateTimeOffset capturedAt) = await ExportAsync(connection, transaction, token).ConfigureAwait(false);
            OfflineMigrationSourceObservation before = await observe(connection, transaction, token).ConfigureAwait(false);
            RequireSession(connection, transaction);
            token.ThrowIfCancellationRequested();
            // Await the real callback task to terminal; do not abandon it with WaitAsync/WhenAny.
            // The original Host callback accepts only its pre-bound path after DUMP_COMPLETED.
            string dumpPath = await awaitCompletedDumpPath(before, snapshotId, capturedAt, token).ConfigureAwait(false);
            RequireSession(connection, transaction);
            string dumpSha256 = await HashCompletedDumpAsync(dumpPath, token).ConfigureAwait(false);
            OfflineMigrationSourceObservation after = await observe(connection, transaction, token).ConfigureAwait(false);
            RequireSession(connection, transaction);
            token.ThrowIfCancellationRequested();
            if (!OfflineMigrationPlanValidation.Equal(before, after))
            {
                throw new NativeSessionFailure("offline_source_capture_observation_changed");
            }
            // The observer includes non-MVCC sequence state. Re-observation rejects detected
            // drift, but cannot prove no ABA change, lock sequences, or make the file WORM.
            return (before, snapshotId, capturedAt, dumpSha256);
        }, cancellationToken);
    }

    private static async Task<TResult> WithSessionAsync<TResult>(
        string connectionString,
        Func<NpgsqlConnection, NpgsqlTransaction, CancellationToken, Task<TResult>> operation,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!cancellationToken.CanBeCanceled || string.IsNullOrWhiteSpace(connectionString))
        {
            throw new InvalidOperationException("offline_source_native_operation_context_required");
        }
        SqlSugarClient? database = null;
        NpgsqlConnection? connection = null;
        NpgsqlTransaction? transaction = null;
        Exception? failure = null;
        CleanupState transactionCleanup = CleanupState.NotOwned;
        CleanupState connectionCleanup = CleanupState.NotOwned;
        CleanupState adapterCleanup = CleanupState.NotOwned;
        TResult result = default!;
        try
        {
            // Avoid pooled or ambient sessions surviving this resource owner. These are driver
            // ownership settings, not a connection-string prefix or production admission policy.
            var settings = new NpgsqlConnectionStringBuilder(connectionString)
            {
                Pooling = false,
                Multiplexing = false,
                Enlist = false,
                PersistSecurityInfo = false,
                IncludeErrorDetail = false
            };
            database = new SqlSugarClient(new ConnectionConfig
            {
                DbType = SqlSugar.DbType.PostgreSQL,
                ConnectionString = settings.ConnectionString,
                IsAutoCloseConnection = false
            });
            database.Ado.IsEnableLogEvent = false;
            if (database.Ado.Connection is not NpgsqlConnection nativeConnection
                || database.Ado.Transaction is not null || nativeConnection.State != ConnectionState.Closed)
            {
                throw new NativeSessionFailure("offline_source_native_sqlsugar_session_required");
            }
            connection = nativeConnection;
            await connection.OpenAsync(cancellationToken).ConfigureAwait(false);
            transaction = await connection.BeginTransactionAsync(IsolationLevel.RepeatableRead, cancellationToken).ConfigureAwait(false);
            // The adapter and the observer share the actual underlying native transaction.
            database.Ado.Transaction = transaction;
            await using (var command = new NpgsqlCommand("SET TRANSACTION READ ONLY", connection, transaction))
            {
                await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
            }
            RequireAdapter(database, connection, transaction);
            result = await operation(connection, transaction, cancellationToken).ConfigureAwait(false);
            RequireAdapter(database, connection, transaction);
            await RequireReadOnlyAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
        }
        catch (Exception exception)
        {
            failure = exception;
        }
        finally
        {
            // No fire-and-forget close, successful tuple before disposal, or fake PID liveness.
            // Cleanup is awaited even after cancellation. Broken native cleanup remains RED;
            // the original Host/process owner, not this port, owns physical child escalation.
            if (transaction is not null)
            {
                transactionCleanup = CleanupState.Unverified;
                try
                {
                    await transaction.DisposeAsync().ConfigureAwait(false);
                    transactionCleanup = CleanupState.Returned;
                }
                catch (Exception)
                {
                    // Preserve a secondary cleanup failure independently of the first cause.
                }
            }
            if (connection is not null)
            {
                connectionCleanup = CleanupState.Unverified;
                try
                {
                    await connection.DisposeAsync().ConfigureAwait(false);
                    connectionCleanup = CleanupState.Returned;
                }
                catch (Exception)
                {
                    // Continue the other owned cleanup, but never project this as cancellation.
                }
            }
            if (database is not null)
            {
                bool clearFailed = false;
                adapterCleanup = CleanupState.Unverified;
                try
                {
                    database.Ado.Transaction = null;
                }
                catch (Exception)
                {
                    clearFailed = true;
                }
                try
                {
                    database.Dispose();
                    if (!clearFailed)
                    {
                        adapterCleanup = CleanupState.Returned;
                    }
                }
                catch (Exception)
                {
                    // A failed transaction detachment also keeps adapter cleanup unverified.
                }
            }
        }
        ThrowAfterCleanup(failure, transactionCleanup, connectionCleanup, adapterCleanup, cancellationToken);
        return result;
    }

    internal static void ThrowAfterCleanup(Exception? failure, CleanupState transactionCleanup,
        CleanupState connectionCleanup, CleanupState adapterCleanup, CancellationToken cancellationToken)
    {
        if (transactionCleanup == CleanupState.Unverified || connectionCleanup == CleanupState.Unverified
            || adapterCleanup == CleanupState.Unverified)
        {
            throw new InvalidOperationException(CleanupFailureCode(
                failure, transactionCleanup, connectionCleanup, adapterCleanup));
        }
        if (failure is OperationCanceledException || (failure is null && cancellationToken.IsCancellationRequested))
        {
            throw new OperationCanceledException("offline_source_native_operation_cancelled", cancellationToken);
        }
        if (failure is not null)
        {
            if (failure is OfflineMigrationSourceFingerprintException fingerprint)
            {
                // Only the closed, redacted owner type survives this boundary. This branch
                // is reached after every actual disposal was awaited and none was unverified.
                System.Runtime.ExceptionServices.ExceptionDispatchInfo.Capture(fingerprint).Throw();
            }
            // Driver and callback exception messages/inner exceptions may contain credentials,
            // SQL or row data. Only this owner's fixed codes may cross the CLI/receipt boundary.
            string code = failure is NativeSessionFailure owned
                ? owned.Message : "offline_source_native_operation_failed";
            throw new InvalidOperationException(code);
        }
    }

    internal enum CleanupState
    {
        NotOwned,
        Returned,
        Unverified
    }

    internal static string CleanupFailureCode(Exception? primary,
        CleanupState transaction, CleanupState connection, CleanupState adapter)
    {
        string primaryCode = primary switch
        {
            null => "none",
            OperationCanceledException => "cancelled",
            NativeSessionFailure owned => owned.Message,
            OfflineMigrationSourceFingerprintException fingerprint => fingerprint.Code,
            _ => "operation_failed"
        };
        // Fixed categories only: no primary/secondary driver text, SQL, rows or credentials.
        // Returned means the disposal call returned, not independently observed server release.
        return $"offline_source_native_cleanup_unverified_primary_{primaryCode}"
            + $"_transaction_{CleanupStateCode(transaction)}_connection_{CleanupStateCode(connection)}_adapter_{CleanupStateCode(adapter)}";
    }

    private static string CleanupStateCode(CleanupState state) => state switch
    {
        CleanupState.NotOwned => "not_owned",
        CleanupState.Returned => "returned",
        CleanupState.Unverified => "unverified",
        _ => throw new InvalidOperationException("offline_source_native_cleanup_state_invalid")
    };

    private static void RequireAdapter(SqlSugarClient database, NpgsqlConnection connection, NpgsqlTransaction transaction)
    {
        RequireSession(connection, transaction);
        if (!ReferenceEquals(database.Ado.Connection, connection)
            || !ReferenceEquals(database.Ado.Transaction, transaction))
        {
            throw new NativeSessionFailure("offline_source_native_adapter_session_changed");
        }
    }

    private static void RequireSession(NpgsqlConnection connection, NpgsqlTransaction transaction)
    {
        if (connection.State != ConnectionState.Open || transaction.Connection != connection
            || transaction.IsolationLevel != IsolationLevel.RepeatableRead)
        {
            throw new NativeSessionFailure("offline_source_native_repeatable_read_session_required");
        }
    }

    private static async Task RequireReadOnlyAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        CancellationToken cancellationToken)
    {
        RequireSession(connection, transaction);
        await using var command = new NpgsqlCommand(
            "SELECT pg_catalog.current_setting('transaction_isolation'), pg_catalog.current_setting('transaction_read_only')",
            connection, transaction);
        await using NpgsqlDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
            || reader.GetString(0) != "repeatable read" || reader.GetString(1) != "on"
            || await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            throw new NativeSessionFailure("offline_source_native_read_only_session_required");
        }
    }

    private static async Task<(string SnapshotId, DateTimeOffset CapturedAt)> ExportAsync(
        NpgsqlConnection connection, NpgsqlTransaction transaction, CancellationToken cancellationToken)
    {
        RequireSession(connection, transaction);
        await using var command = new NpgsqlCommand(
            "SELECT pg_catalog.pg_export_snapshot(), pg_catalog.clock_timestamp(), pg_catalog.current_setting('transaction_isolation'), pg_catalog.current_setting('transaction_read_only')",
            connection, transaction);
        await using NpgsqlDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            throw new NativeSessionFailure("offline_source_native_snapshot_export_required");
        }
        string snapshotId = reader.GetString(0);
        RequireSnapshotId(snapshotId);
        DateTime capturedAt = reader.GetDateTime(1);
        if (capturedAt.Kind != DateTimeKind.Utc || reader.GetString(2) != "repeatable read" || reader.GetString(3) != "on"
            || await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            throw new NativeSessionFailure("offline_source_native_snapshot_time_required");
        }
        return (snapshotId, new DateTimeOffset(capturedAt));
    }

    internal static void RequireSnapshotId(string snapshotId)
    {
        if (string.IsNullOrEmpty(snapshotId) || snapshotId.Length > 128
            || snapshotId.Any(character => !char.IsAsciiLetterOrDigit(character) && character != '-'))
        {
            throw new InvalidOperationException("offline_source_native_snapshot_id_invalid");
        }
    }

    internal static async Task<string> HashCompletedDumpAsync(string dumpPath, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        try
        {
            if (!OperatingSystem.IsLinux() || string.IsNullOrWhiteSpace(dumpPath) || !Path.IsPathFullyQualified(dumpPath))
            {
                throw new NativeSessionFailure("offline_source_capture_native_dump_path_required");
            }
            string fullPath = Path.GetFullPath(dumpPath);
            RequireDirectoryComponents(fullPath);
            DumpIdentity before = ReadDumpIdentity(-100, fullPath, 0x100);
            await using var input = new FileStream(fullPath, FileMode.Open, FileAccess.Read, FileShare.Read,
                64 * 1024, FileOptions.Asynchronous | FileOptions.SequentialScan);
            int descriptor = input.SafeFileHandle.DangerousGetHandle().ToInt32();
            if (ReadDumpIdentity(descriptor, string.Empty, 0x1100) != before)
            {
                throw new NativeSessionFailure("offline_source_capture_dump_identity_changed");
            }
            byte[] digest = await SHA256.HashDataAsync(input, cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            if (ReadDumpIdentity(descriptor, string.Empty, 0x1100) != before
                || ReadDumpIdentity(-100, fullPath, 0x100) != before)
            {
                throw new NativeSessionFailure("offline_source_capture_dump_identity_changed");
            }
            return Convert.ToHexStringLower(digest);
        }
        catch (OperationCanceledException)
        {
            throw new OperationCanceledException("offline_source_native_operation_cancelled", cancellationToken);
        }
        catch (Exception exception)
        {
            string code = exception is NativeSessionFailure owned
                ? owned.Message : "offline_source_capture_dump_observation_failed";
            throw new InvalidOperationException(code);
        }
    }

    private static void RequireDirectoryComponents(string fullPath)
    {
        string directory = Path.GetDirectoryName(fullPath)
            ?? throw new NativeSessionFailure("offline_source_capture_native_dump_path_required");
        while (true)
        {
            if (NativeMethods.ReadStatx(-100, directory, 0x100, 1, out NativeStatx status) != 0
                || (status.Mask & 1) == 0 || (status.Mode & 0xf000) != 0x4000)
            {
                throw new NativeSessionFailure("offline_source_capture_dump_parent_invalid");
            }
            string? parent = Path.GetDirectoryName(directory);
            if (parent is null || directory == parent)
            {
                break;
            }
            directory = parent;
        }
    }

    private static DumpIdentity ReadDumpIdentity(int descriptor, string path, int flags)
    {
        const uint RequiredMask = 0x7df; // Linux statx basic stats, excluding access time.
        if (NativeMethods.ReadStatx(descriptor, path, flags, RequiredMask, out NativeStatx status) != 0
            || (status.Mask & RequiredMask) != RequiredMask
            || (status.Mode & 0xf000) != 0x8000 || status.Links != 1 || status.Size == 0)
        {
            throw new NativeSessionFailure("offline_source_capture_regular_unique_dump_required");
        }
        return new DumpIdentity(status.DeviceMajor, status.DeviceMinor, status.Inode, status.Links,
            status.Uid, status.Gid, status.Mode, status.Size, status.Blocks,
            status.Modified.Seconds, status.Modified.Nanoseconds, status.Changed.Seconds, status.Changed.Nanoseconds);
    }

    private readonly record struct DumpIdentity(uint DeviceMajor, uint DeviceMinor, ulong Inode, uint Links,
        uint Uid, uint Gid, ushort Mode, ulong Size, ulong Blocks,
        long ModifiedSeconds, uint ModifiedNanoseconds, long ChangedSeconds, uint ChangedNanoseconds);

    // Linux statx is the fixed 256-byte kernel ABI; it avoids architecture-specific libc stat
    // layouts. Unsupported kernels/platforms fail closed instead of inventing file identity.
    [StructLayout(LayoutKind.Explicit, Size = 256)]
    private struct NativeStatx
    {
        [FieldOffset(0)] public uint Mask;
        [FieldOffset(16)] public uint Links;
        [FieldOffset(20)] public uint Uid;
        [FieldOffset(24)] public uint Gid;
        [FieldOffset(28)] public ushort Mode;
        [FieldOffset(32)] public ulong Inode;
        [FieldOffset(40)] public ulong Size;
        [FieldOffset(48)] public ulong Blocks;
        [FieldOffset(96)] public NativeTimestamp Changed;
        [FieldOffset(112)] public NativeTimestamp Modified;
        [FieldOffset(136)] public uint DeviceMajor;
        [FieldOffset(140)] public uint DeviceMinor;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct NativeTimestamp
    {
        public long Seconds;
        public uint Nanoseconds;
        public int Reserved;
    }

    private static class NativeMethods
    {
        [DllImport("libc", EntryPoint = "statx", SetLastError = true)]
        internal static extern int ReadStatx(int descriptor,
            [MarshalAs(UnmanagedType.LPUTF8Str)] string path, int flags, uint mask, out NativeStatx status);
    }

    private sealed class NativeSessionFailure(string code) : Exception(code)
    {
    }
}
