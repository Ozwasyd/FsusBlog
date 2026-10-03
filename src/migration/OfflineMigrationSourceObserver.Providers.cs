using System.Collections.Immutable;
using System.Data;
using System.Data.Common;
using System.Globalization;
using System.Runtime.ExceptionServices;

using MySqlConnector;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration;

public sealed partial class OfflineMigrationSourceObserver
{
    internal const string SourceMaterialCleanupFailuresKey = "FsusBlog.Migration.SourceMaterialCleanupFailures";

    // Actual identity/settings material is not a retained writer capability. The
    // sole native owner must separately prove its minted transaction, access mode,
    // epoch, lock and creator deadline before using these measured values.
    internal sealed record MySqlNativeIdentityMaterial(CurrentSchemaDatabaseIdentity Database,
        string Isolation, string SessionReadOnly, string AutoIncrementIncrement, string AutoIncrementOffset);

    internal static Task<MySqlNativeIdentityMaterial> ReadMySqlNativeIdentityMaterialAsync(
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
        // This per-material budget never replaces a complete observation's budget.
        // The public observation calls the overload with its existing accumulator.
        => ReadMySqlNativeIdentityMaterialAsync(connection, transaction, new ObservationBudget(), cancellationToken);

    private static async Task<MySqlNativeIdentityMaterial> ReadMySqlNativeIdentityMaterialAsync(
        DbConnection connection, DbTransaction transaction, ObservationBudget budget, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (connection.GetType() != typeof(MySqlConnection) || transaction.GetType() != typeof(MySqlTransaction))
            throw new InvalidOperationException("offline_source_native_streaming_driver_required");
        if (connection.State != ConnectionState.Open || transaction.Connection != connection)
            throw new InvalidOperationException("offline_source_consistent_native_session_required");
        ImmutableArray<ImmutableArray<string>> settings = await ReadProviderRowsAsync(connection, transaction,
            "SELECT @@server_uuid,DATABASE(),@@session.transaction_isolation,@@session.transaction_read_only,@@session.auto_increment_increment,@@session.auto_increment_offset",
            budget, cancellationToken).ConfigureAwait(false);
        cancellationToken.ThrowIfCancellationRequested();
        return ParseMySqlNativeIdentityMaterial(settings);
    }

    internal static MySqlNativeIdentityMaterial ParseMySqlNativeIdentityMaterial(ImmutableArray<ImmutableArray<string>> settings)
    {
        if (settings.IsDefault || settings.Length != 1 || settings[0].IsDefault || settings[0].Length != 6
            || settings[0].Any(value => value is null) || !Guid.TryParse(settings[0][0], out Guid server)
            || server == Guid.Empty || string.IsNullOrEmpty(settings[0][1]))
            throw new InvalidOperationException("offline_source_mysql_snapshot_or_identity_unavailable");
        return new(new(CurrentSchemaProviderKind.MySql, "mysql:" + server.ToString("D"), settings[0][1]),
            settings[0][2], settings[0][3], settings[0][4], settings[0][5]);
    }

    private static async Task<ImmutableArray<ImmutableArray<string>>> ReadProviderRowsAsync(DbConnection connection,
        DbTransaction transaction, string sql, ObservationBudget budget, CancellationToken cancellationToken)
    {
        var cleanupFailures = ImmutableArray.CreateBuilder<string>(2);
        DbCommand command = connection.CreateCommand();
        DbDataReader? reader = null;
        ImmutableArray<ImmutableArray<string>> result = default;
        Exception? failure = null;
        try
        {
            command.Transaction = transaction;
            command.CommandText = sql;
            command.CommandTimeout = 30;
            reader = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, cancellationToken).ConfigureAwait(false);
            var rows = ImmutableArray.CreateBuilder<ImmutableArray<string>>();
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                if (++budget.Rows > MaximumMetadataRows || reader.FieldCount > 16)
                {
                    throw new InvalidOperationException("offline_source_metadata_budget_exceeded");
                }
                var cells = ImmutableArray.CreateBuilder<string>();
                for (int index = 0; index < reader.FieldCount; index++)
                {
                    string text = reader.IsDBNull(index) ? string.Empty : Convert.ToString(reader.GetValue(index), CultureInfo.InvariantCulture) ?? string.Empty;
                    budget.Characters += text.Length;
                    if (text.Length > MaximumCellCharacters || budget.Characters > MaximumMetadataCharacters)
                    {
                        throw new InvalidOperationException("offline_source_metadata_budget_exceeded");
                    }
                    cells.Add(text);
                }
                rows.Add(cells.ToImmutable());
            }
            result = rows.ToImmutable();
        }
        catch (Exception primary)
        {
            failure = primary;
        }
        if (reader is not null)
        {
            try
            {
                await reader.DisposeAsync().ConfigureAwait(false);
            }
            catch (Exception cleanup)
            {
                failure ??= cleanup;
                cleanupFailures.Add("offline_source_material_reader_cleanup_failed");
            }
        }
        try
        {
            await command.DisposeAsync().ConfigureAwait(false);
        }
        catch (Exception cleanup)
        {
            failure ??= cleanup;
            cleanupFailures.Add("offline_source_material_command_cleanup_failed");
        }
        if (failure is not null)
        {
            if (cleanupFailures.Count > 0)
            {
                // Fixed diagnostics only; no secondary exception, SQL or cell data.
                failure.Data[SourceMaterialCleanupFailuresKey] = cleanupFailures.ToImmutable();
            }
            ExceptionDispatchInfo.Capture(failure).Throw();
        }
        return result;
    }

}
