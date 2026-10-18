using System.Data;
using System.Data.Common;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;

using Microsoft.Data.Sqlite;
using Microsoft.Win32.SafeHandles;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration;

/// <summary>
/// Binds the held SQLite main database, not a filename or receipt assertion, to its
/// actual native descriptor and the sole file owner's observed device/inode tuple.
/// Missing original native FILESTAT capability is a refusal, not provider qualification.
/// </summary>
internal static class OfflineMigrationSqliteDatabaseIdentity
{
    // Exact existing native package version. FILESTAT is an optional public C API;
    // its availability cannot be inferred merely from the package version/name.
    private const int OriginalNativeVersion = 3053003;
    private const int FileStatOperation = 45;

    internal static async Task<Snapshot> CaptureAsync(DbConnection connection, DbTransaction transaction,
        CancellationToken cancellationToken)
    {
        (SqliteConnection native, SqliteTransaction nativeTransaction, SQLitePCL.sqlite3 handle) =
            RequireSession(connection, transaction, cancellationToken);
        string filename = await ReadMainFilenameAsync(native, nativeTransaction, handle, cancellationToken).ConfigureAwait(false);
        int descriptor = ReadActualDescriptor(handle, cancellationToken);
        // This wrapper owns no OS descriptor. Opening/closing a second DB leaf can
        // release SQLite's POSIX locks; only the original SQLite session owns that FD.
        var nonOwning = new SafeFileHandle((IntPtr)descriptor, ownsHandle: false);
        try
        {
            var physical = OfflineMigrationCurrentSchemaArtifactReader.CaptureOriginalHeldRegularFileIdentity(
                filename, nonOwning, cancellationToken);
            var result = new Snapshot(native, nativeTransaction, handle, filename, nonOwning, physical);
            await result.ValidateAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
            return result;
        }
        catch
        {
            nonOwning.Dispose();
            throw;
        }
    }

    internal static async Task<CurrentSchemaDatabaseIdentity> ReadAsync(DbConnection connection,
        DbTransaction transaction, CancellationToken cancellationToken)
    {
        using Snapshot snapshot = await CaptureAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        await snapshot.ValidateAsync(connection, transaction, cancellationToken).ConfigureAwait(false);
        return snapshot.Database;
    }

    private static (SqliteConnection Connection, SqliteTransaction Transaction, SQLitePCL.sqlite3 Handle) RequireSession(
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!cancellationToken.CanBeCanceled || !OperatingSystem.IsLinux())
        {
            throw Failure("native_context_unavailable");
        }
        if (connection is not SqliteConnection native || connection.GetType() != typeof(SqliteConnection)
            || transaction is not SqliteTransaction nativeTransaction || transaction.GetType() != typeof(SqliteTransaction)
            || connection.State != ConnectionState.Open || transaction.Connection != connection
            || transaction.IsolationLevel != IsolationLevel.Serializable
            || native.Handle is not { IsClosed: false, IsInvalid: false } handle
            || SQLitePCL.raw.sqlite3_get_autocommit(handle) != 0)
        {
            throw Failure("held_native_transaction_required");
        }
        return (native, nativeTransaction, handle);
    }

    private static async Task<string> ReadMainFilenameAsync(SqliteConnection connection, SqliteTransaction transaction,
        SQLitePCL.sqlite3 handle, CancellationToken cancellationToken)
    {
        string? filename = SQLitePCL.raw.sqlite3_db_filename(handle, "main").utf8_to_string();
        if (string.IsNullOrWhiteSpace(filename) || !Path.IsPathFullyQualified(filename)
            || Path.GetFullPath(filename) != filename || filename.Any(char.IsControl))
        {
            throw Failure("persistent_main_required");
        }
        await using SqliteCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = "PRAGMA database_list";
        await using SqliteDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
            || reader.GetString(1) != "main" || reader.GetString(2) != filename
            || await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            throw Failure("single_main_required");
        }
        _ = RequireSession(connection, transaction, cancellationToken);
        return filename;
    }

    private static int ReadActualDescriptor(SQLitePCL.sqlite3 handle, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        bool retained = false;
        IntPtr text = IntPtr.Zero;
        try
        {
            handle.DangerousAddRef(ref retained);
            // Microsoft.Data.Sqlite formally exposes its SQLitePCL handle for additional
            // native C API interop. Only the existing pinned e_sqlite3 provider is admitted;
            // no alternate SQLite module, VFS or private unixFile layout is installed.
            if (SQLitePCL.raw.GetNativeLibraryName() != "e_sqlite3"
                || SQLitePCL.raw.sqlite3_libversion_number() != OriginalNativeVersion
                || NativeMethods.LibraryVersion() != OriginalNativeVersion
                || SQLitePCL.raw.sqlite3_sourceid().utf8_to_string()
                    != Marshal.PtrToStringUTF8(NativeMethods.SourceIdentity()))
            {
                throw Failure("original_native_provider_required");
            }
            IntPtr database = handle.DangerousGetHandle();
            int transactionState = NativeMethods.TransactionState(database, "main");
            if (transactionState is not (1 or 2))
            {
                throw Failure("held_native_transaction_required");
            }
            text = NativeMethods.CreateString(database);
            if (text == IntPtr.Zero)
            {
                throw Failure("filestat_observation_failed");
            }
            // The pinned compile-option inventory does not list ENABLE_FILESTAT.
            // Probe the actual optional operation, never infer support from a flag/name.
            RequireActualFileStatCapability(NativeMethods.FileControl(database, "main", FileStatOperation, text),
                NativeMethods.StringError(text));
            int length = NativeMethods.StringLength(text);
            IntPtr value = NativeMethods.StringValue(text);
            // The pinned unix FILESTAT C producer starts JSON with {"h":<its actual FD>,.
            // Decode only that named field, not /proc searches or a guessed object offset.
            // A C int needs at most ten decimal digits: no whole diagnostic is hydrated.
            if (value == IntPtr.Zero || length < 7)
            {
                throw Failure("filestat_capability_unavailable");
            }
            byte[] prefix = new byte[Math.Min(length, 16)];
            Marshal.Copy(value, prefix, 0, prefix.Length);
            string firstField = Encoding.ASCII.GetString(prefix);
            int comma = firstField.IndexOf(',', 5);
            if (!firstField.StartsWith("{\"h\":", StringComparison.Ordinal) || comma < 6
                || !int.TryParse(firstField.AsSpan(5, comma - 5), NumberStyles.None, CultureInfo.InvariantCulture, out int descriptor)
                || descriptor < 0)
            {
                throw Failure("filestat_observation_failed");
            }
            cancellationToken.ThrowIfCancellationRequested();
            return descriptor;
        }
        catch (Exception exception) when (exception is DllNotFoundException or EntryPointNotFoundException or BadImageFormatException)
        {
            throw Failure("filestat_capability_unavailable");
        }
        finally
        {
            try
            {
                if (text != IntPtr.Zero)
                {
                    IntPtr bytes = NativeMethods.FinishString(text);
                    if (bytes != IntPtr.Zero)
                    {
                        NativeMethods.Free(bytes);
                    }
                }
            }
            finally
            {
                if (retained)
                {
                    handle.DangerousRelease();
                }
            }
        }
    }

    // Pure refusal predicate only. Passing it does not construct a descriptor,
    // database identity or successful observation; production passes native results.
    internal static void RequireActualFileStatCapability(int result, int stringError)
    {
        if (result != SQLitePCL.raw.SQLITE_OK || stringError != SQLitePCL.raw.SQLITE_OK)
        {
            throw Failure("filestat_capability_unavailable");
        }
    }

    internal sealed class Snapshot : IDisposable
    {
        private readonly SqliteConnection _connection;
        private readonly SqliteTransaction _transaction;
        private readonly SQLitePCL.sqlite3 _native;
        private readonly string _filename;
        private readonly SafeFileHandle _nonOwning;
        private readonly OfflineMigrationCurrentSchemaArtifactReader.OriginalHeldRegularFileIdentity _physical;

        internal Snapshot(SqliteConnection connection, SqliteTransaction transaction, SQLitePCL.sqlite3 native,
            string filename, SafeFileHandle nonOwning,
            OfflineMigrationCurrentSchemaArtifactReader.OriginalHeldRegularFileIdentity physical)
        {
            _connection = connection;
            _transaction = transaction;
            _native = native;
            _filename = filename;
            _nonOwning = nonOwning;
            _physical = physical;
            Database = new(CurrentSchemaProviderKind.Sqlite,
                string.Create(CultureInfo.InvariantCulture, $"sqlite:{physical.DeviceMajor}:{physical.DeviceMinor}:{physical.Inode}"), filename);
        }

        internal CurrentSchemaDatabaseIdentity Database
        {
            get;
        }

        internal async Task ValidateAsync(DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
        {
            (SqliteConnection current, SqliteTransaction currentTransaction, SQLitePCL.sqlite3 native) =
                RequireSession(connection, transaction, cancellationToken);
            if (!ReferenceEquals(current, _connection) || !ReferenceEquals(currentTransaction, _transaction)
                || !ReferenceEquals(native, _native) || _nonOwning.IsClosed
                || await ReadMainFilenameAsync(current, currentTransaction, native, cancellationToken).ConfigureAwait(false) != _filename
                || ReadActualDescriptor(native, cancellationToken) != _nonOwning.DangerousGetHandle().ToInt32())
            {
                throw Failure("native_database_changed");
            }
            OfflineMigrationCurrentSchemaArtifactReader.ValidateOriginalHeldRegularFileUnchanged(
                _filename, _nonOwning, _physical, cancellationToken);
        }

        // Disposes only the non-owning managed wrapper, never SQLite's OS file descriptor.
        public void Dispose() => _nonOwning.Dispose();
    }

    private static InvalidOperationException Failure(string code) => new("offline_sqlite_identity_" + code);

    private static class NativeMethods
    {
        [DllImport("e_sqlite3", EntryPoint = "sqlite3_libversion_number", CallingConvention = CallingConvention.Cdecl)]
        internal static extern int LibraryVersion();
        [DllImport("e_sqlite3", EntryPoint = "sqlite3_sourceid", CallingConvention = CallingConvention.Cdecl)]
        internal static extern IntPtr SourceIdentity();
        [DllImport("e_sqlite3", EntryPoint = "sqlite3_txn_state", CallingConvention = CallingConvention.Cdecl)]
        internal static extern int TransactionState(IntPtr database, [MarshalAs(UnmanagedType.LPUTF8Str)] string name);
        [DllImport("e_sqlite3", EntryPoint = "sqlite3_file_control", CallingConvention = CallingConvention.Cdecl)]
        internal static extern int FileControl(IntPtr database, [MarshalAs(UnmanagedType.LPUTF8Str)] string name, int operation, IntPtr argument);
        [DllImport("e_sqlite3", EntryPoint = "sqlite3_str_new", CallingConvention = CallingConvention.Cdecl)]
        internal static extern IntPtr CreateString(IntPtr database);
        [DllImport("e_sqlite3", EntryPoint = "sqlite3_str_value", CallingConvention = CallingConvention.Cdecl)]
        internal static extern IntPtr StringValue(IntPtr value);
        [DllImport("e_sqlite3", EntryPoint = "sqlite3_str_length", CallingConvention = CallingConvention.Cdecl)]
        internal static extern int StringLength(IntPtr value);
        [DllImport("e_sqlite3", EntryPoint = "sqlite3_str_errcode", CallingConvention = CallingConvention.Cdecl)]
        internal static extern int StringError(IntPtr value);
        [DllImport("e_sqlite3", EntryPoint = "sqlite3_str_finish", CallingConvention = CallingConvention.Cdecl)]
        internal static extern IntPtr FinishString(IntPtr value);
        [DllImport("e_sqlite3", EntryPoint = "sqlite3_free", CallingConvention = CallingConvention.Cdecl)]
        internal static extern void Free(IntPtr value);
    }
}
