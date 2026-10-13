using System.Data;
using System.Data.Common;
using System.Diagnostics;
using System.Text;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

internal enum DataScaleBulkProvider
{
    PostgreSql,
    MySql,
    Sqlite
}

internal enum DataScaleBulkCommitState
{
    Committed,
    RolledBack,
    CommitUncertain,
    RollbackUncertain
}

internal sealed record DataScaleBulkColumn(string Name, DbType Type);

internal sealed record DataScaleBulkTableRows(
    string Table,
    IReadOnlyList<DataScaleBulkColumn> Columns,
    IReadOnlyList<IReadOnlyList<object?>> Rows);

internal sealed record DataScaleBulkPostconditions(string SemanticDigest, IReadOnlyList<string> Violations);

internal sealed record DataScaleBulkExecution(
    DataScaleBulkCommitState State,
    int WriteCommands,
    long RowsSubmitted,
    long ElapsedMilliseconds,
    string? SemanticDigest,
    string? Failure);

/// <summary>
/// Executes already bound physical rows in one transaction. It supplies only provider transport:
/// the canonical host owns factory references, identity binding, dependency order, checkpoints,
/// semantic projection and receipts. A committed transport batch is not verified seed acceptance.
/// </summary>
internal static class DataScaleProviderBulkTransport
{
    private const int MaximumTables = 32;
    private const int MaximumColumns = 128;
    private const long MaximumRows = 50_000;
    private const long MaximumTextBytes = 64L * 1024 * 1024;
    private const int MaximumRowsPerCommand = 256;

    internal static async Task<DataScaleBulkExecution> ExecuteAtomicBatchAsync(
        DbConnection connection,
        DataScaleBulkProvider provider,
        IReadOnlyList<DataScaleBulkTableRows> tables,
        string expectedSemanticDigest,
        Func<DbConnection, DbTransaction, CancellationToken, Task<DataScaleBulkPostconditions>> verify,
        CancellationToken cancellationToken)
        => await ExecuteAtomicBatchAsync(connection, provider, tables, [], expectedSemanticDigest,
            verify, cancellationToken).ConfigureAwait(false);

    // Updates contain the primary key first, then exact final values for deferred columns.
    // Their keys must be among this transaction's inserted rows; this is not a general updater.
    internal static async Task<DataScaleBulkExecution> ExecuteAtomicBatchAsync(
        DbConnection connection,
        DataScaleBulkProvider provider,
        IReadOnlyList<DataScaleBulkTableRows> tables,
        IReadOnlyList<DataScaleBulkTableRows> deferredUpdates,
        string expectedSemanticDigest,
        Func<DbConnection, DbTransaction, CancellationToken, Task<DataScaleBulkPostconditions>> verify,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(connection);
        ArgumentNullException.ThrowIfNull(tables);
        ArgumentNullException.ThrowIfNull(deferredUpdates);
        ArgumentNullException.ThrowIfNull(verify);
        Validate(connection, provider, tables, expectedSemanticDigest);
        Validate(connection, provider, deferredUpdates, expectedSemanticDigest);
        tables = Snapshot(tables);
        deferredUpdates = Snapshot(deferredUpdates);
        Validate(connection, provider, tables, expectedSemanticDigest);
        Validate(connection, provider, deferredUpdates, expectedSemanticDigest);
        ValidateUpdates(tables, deferredUpdates);

        var timer = Stopwatch.StartNew();
        int commands = 0;
        long rows = 0;
        bool commitStarted = false;
        string? digest = null;
        await using DbTransaction transaction = await connection.BeginTransactionAsync(
            IsolationLevel.Serializable, cancellationToken).ConfigureAwait(false);
        try
        {
            foreach (DataScaleBulkTableRows update in deferredUpdates)
            {
                await ValidateNativeUpdateKeyAsync(connection, transaction, provider, update, cancellationToken).ConfigureAwait(false);
            }
            foreach (DataScaleBulkTableRows table in tables)
            {
                int parameterLimit = provider == DataScaleBulkProvider.Sqlite ? 999 : 2000;
                int rowsPerCommand = Math.Min(MaximumRowsPerCommand, parameterLimit / table.Columns.Count);
                for (int offset = 0; offset < table.Rows.Count; offset += rowsPerCommand)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    int count = Math.Min(rowsPerCommand, table.Rows.Count - offset);
                    await using DbCommand command = connection.CreateCommand();
                    command.Transaction = transaction;
                    command.CommandTimeout = 30;
                    command.CommandText = BuildInsert(command, provider, table, offset, count);
                    commands++;
                    await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
                    rows += count;
                }
            }

            foreach (DataScaleBulkTableRows update in deferredUpdates)
            {
                int parameterLimit = provider == DataScaleBulkProvider.Sqlite ? 999 : 2000;
                int rowsPerCommand = Math.Min(MaximumRowsPerCommand, parameterLimit / update.Columns.Count);
                for (int offset = 0; offset < update.Rows.Count; offset += rowsPerCommand)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    int count = Math.Min(rowsPerCommand, update.Rows.Count - offset);
                    await using DbCommand command = connection.CreateCommand();
                    command.Transaction = transaction;
                    command.CommandTimeout = 30;
                    command.CommandText = BuildUpdate(command, provider, update, offset, count);
                    commands++;
                    await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
                }
            }

            DataScaleBulkPostconditions postconditions = await verify(
                connection, transaction, cancellationToken).ConfigureAwait(false);
            if (postconditions.Violations.Count != 0
                || !string.Equals(postconditions.SemanticDigest, expectedSemanticDigest, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("bulk_postconditions_failed");
            }
            digest = postconditions.SemanticDigest;
            cancellationToken.ThrowIfCancellationRequested();
            commitStarted = true;
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return new(DataScaleBulkCommitState.Committed, commands, rows, timer.ElapsedMilliseconds, digest, null);
        }
        catch (Exception error)
        {
            DataScaleBulkCommitState state = commitStarted
                ? DataScaleBulkCommitState.CommitUncertain
                : DataScaleBulkCommitState.RolledBack;
            try
            {
                // Cleanup has its own bounded lifetime: caller cancellation must not abandon an open transaction.
                using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(30));
                await transaction.RollbackAsync(cleanup.Token).ConfigureAwait(false);
            }
            catch (Exception)
            {
                if (!commitStarted)
                {
                    state = DataScaleBulkCommitState.RollbackUncertain;
                }
            }
            return new(state, commands, rows, timer.ElapsedMilliseconds, digest, error.GetType().Name);
        }
    }

    private static IReadOnlyList<DataScaleBulkTableRows> Snapshot(IReadOnlyList<DataScaleBulkTableRows> tables)
        => tables.Select(table => new DataScaleBulkTableRows(table.Table, table.Columns.ToArray(),
            table.Rows.Select(row => (IReadOnlyList<object?>)row.Select(value => value is byte[] bytes ? bytes.ToArray() : value).ToArray()).ToArray())).ToArray();

    private static async Task ValidateNativeUpdateKeyAsync(DbConnection connection, DbTransaction transaction,
        DataScaleBulkProvider provider, DataScaleBulkTableRows update, CancellationToken cancellationToken)
    {
        await using DbCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandTimeout = 30;
        command.CommandText = provider switch
        {
            DataScaleBulkProvider.PostgreSql => "SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey) WHERE i.indrelid=to_regclass(@table) AND i.indisprimary ORDER BY a.attnum",
            DataScaleBulkProvider.MySql => "SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=@table AND CONSTRAINT_NAME='PRIMARY' ORDER BY ORDINAL_POSITION",
            DataScaleBulkProvider.Sqlite => "SELECT name FROM pragma_table_info(@table) WHERE pk != 0 ORDER BY pk",
            _ => throw new ArgumentOutOfRangeException(nameof(provider))
        };
        DbParameter parameter = command.CreateParameter();
        parameter.ParameterName = "@table";
        parameter.DbType = DbType.String;
        parameter.Value = provider == DataScaleBulkProvider.PostgreSql ? Quote(provider, update.Table) : update.Table;
        command.Parameters.Add(parameter);
        var columns = new List<string>();
        await using DbDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            columns.Add(reader.GetString(0));
        }
        if (columns.Count != 1 || columns[0] != update.Columns[0].Name)
        {
            throw new InvalidOperationException("bulk_deferred_update_native_primary_key_mismatch");
        }
    }

    private static void ValidateUpdates(IReadOnlyList<DataScaleBulkTableRows> inserts, IReadOnlyList<DataScaleBulkTableRows> updates)
    {
        foreach (DataScaleBulkTableRows update in updates)
        {
            DataScaleBulkTableRows? insert = inserts.SingleOrDefault(table => table.Table == update.Table);
            if (insert is null || update.Columns.Count < 2 || update.Columns[0].Type is not (DbType.Int32 or DbType.Int64))
            {
                throw new ArgumentException("bulk_deferred_update_shape_invalid", nameof(updates));
            }
            int key = insert.Columns.ToList().IndexOf(update.Columns[0]);
            if (key < 0 || update.Columns.Any(column => !insert.Columns.Contains(column)))
            {
                throw new ArgumentException("bulk_deferred_update_columns_invalid", nameof(updates));
            }
            HashSet<long> owned = insert.Rows.Select(row => Convert.ToInt64(row[key], System.Globalization.CultureInfo.InvariantCulture)).ToHashSet();
            long[] keys = update.Rows.Select(row => Convert.ToInt64(row[0], System.Globalization.CultureInfo.InvariantCulture)).ToArray();
            if (keys.Any(id => id <= 0 || !owned.Contains(id)) || keys.Distinct().Count() != keys.Length)
            {
                throw new ArgumentException("bulk_deferred_update_nonowned_or_duplicate_key", nameof(updates));
            }
        }
    }

    private static string BuildUpdate(DbCommand command, DataScaleBulkProvider provider, DataScaleBulkTableRows table, int offset, int count)
    {
        var sql = new StringBuilder("UPDATE ");
        string key = Quote(provider, table.Columns[0].Name);
        sql.Append(Quote(provider, table.Table)).Append(" SET ");
        for (int column = 1; column < table.Columns.Count; column++)
        {
            if (column != 1)
            {
                sql.Append(", ");
            }
            sql.Append(Quote(provider, table.Columns[column].Name)).Append(" = CASE ").Append(key);
            for (int row = 0; row < count; row++)
            {
                sql.Append(" WHEN @p").Append(row).Append("_0 THEN @p").Append(row).Append('_').Append(column);
            }
            sql.Append(" ELSE ").Append(Quote(provider, table.Columns[column].Name)).Append(" END");
        }
        sql.Append(" WHERE ").Append(key).Append(" IN (");
        sql.AppendJoin(',', Enumerable.Range(0, count).Select(row => $"@p{row}_0"));
        sql.Append(')');
        for (int row = 0; row < count; row++)
        {
            for (int column = 0; column < table.Columns.Count; column++)
            {
                DbParameter parameter = command.CreateParameter();
                parameter.ParameterName = $"@p{row}_{column}";
                parameter.DbType = table.Columns[column].Type;
                parameter.Value = table.Rows[offset + row][column] ?? DBNull.Value;
                command.Parameters.Add(parameter);
            }
        }
        return sql.ToString();
    }

    private static string BuildInsert(
        DbCommand command,
        DataScaleBulkProvider provider,
        DataScaleBulkTableRows table,
        int offset,
        int count)
    {
        var sql = new StringBuilder();
        sql.Append("INSERT INTO ").Append(Quote(provider, table.Table)).Append(" (");
        sql.AppendJoin(", ", table.Columns.Select(column => Quote(provider, column.Name)));
        sql.Append(") VALUES ");
        for (int row = 0; row < count; row++)
        {
            if (row != 0)
            {
                sql.Append(", ");
            }
            sql.Append('(');
            for (int column = 0; column < table.Columns.Count; column++)
            {
                if (column != 0)
                {
                    sql.Append(", ");
                }
                string name = $"@p{row}_{column}";
                sql.Append(name);
                DbParameter parameter = command.CreateParameter();
                parameter.ParameterName = name;
                parameter.DbType = table.Columns[column].Type;
                parameter.Value = table.Rows[offset + row][column] ?? DBNull.Value;
                command.Parameters.Add(parameter);
            }
            sql.Append(')');
        }
        return sql.ToString();
    }

    private static string Quote(DataScaleBulkProvider provider, string identifier)
        => provider == DataScaleBulkProvider.MySql ? $"`{identifier}`" : $"\"{identifier}\"";

    private static void Validate(
        DbConnection connection,
        DataScaleBulkProvider provider,
        IReadOnlyList<DataScaleBulkTableRows> tables,
        string digest)
    {
        string expectedConnection = provider switch
        {
            DataScaleBulkProvider.PostgreSql => "Npgsql.NpgsqlConnection",
            DataScaleBulkProvider.MySql => "MySqlConnector.MySqlConnection",
            DataScaleBulkProvider.Sqlite => "Microsoft.Data.Sqlite.SqliteConnection",
            _ => throw new ArgumentOutOfRangeException(nameof(provider))
        };
        if (connection.GetType().FullName != expectedConnection || connection.State != ConnectionState.Open)
        {
            throw new InvalidOperationException("bulk_provider_connection_mismatch");
        }
        if (digest is null || digest.Length != 71 || !digest.StartsWith("sha256:", StringComparison.Ordinal)
            || digest.AsSpan(7).ContainsAnyExcept("0123456789abcdef"))
        {
            throw new ArgumentException("bulk_expected_digest_invalid", nameof(digest));
        }
        if (tables.Count > MaximumTables || tables.Select(table => table.Table).Distinct(StringComparer.Ordinal).Count() != tables.Count)
        {
            throw new ArgumentException("bulk_table_count_or_duplicate_invalid", nameof(tables));
        }
        long rows = 0;
        long bytes = 0;
        foreach (DataScaleBulkTableRows table in tables)
        {
            ValidateIdentifier(table.Table);
            if (table.Columns.Count == 0 || table.Columns.Count > MaximumColumns
                || table.Columns.Select(column => column.Name).Distinct(StringComparer.Ordinal).Count() != table.Columns.Count)
            {
                throw new ArgumentException("bulk_columns_invalid", nameof(tables));
            }
            foreach (DataScaleBulkColumn column in table.Columns)
            {
                ValidateIdentifier(column.Name);
                if (!Enum.IsDefined(column.Type))
                {
                    throw new ArgumentException("bulk_column_type_invalid", nameof(tables));
                }
            }
            rows += table.Rows.Count;
            if (rows > MaximumRows)
            {
                throw new ArgumentException("bulk_row_bound_exceeded", nameof(tables));
            }
            foreach (IReadOnlyList<object?> values in table.Rows)
            {
                if (values.Count != table.Columns.Count)
                {
                    throw new ArgumentException("bulk_row_width_mismatch", nameof(tables));
                }
                foreach (object? value in values)
                {
                    bytes += value switch
                    {
                        string text => Encoding.UTF8.GetByteCount(text),
                        byte[] binary => binary.Length,
                        _ => 16
                    };
                    if (bytes > MaximumTextBytes)
                    {
                        throw new ArgumentException("bulk_value_bound_exceeded", nameof(tables));
                    }
                }
            }
        }
    }

    internal static void ValidateIdentifier(string identifier)
    {
        if (string.IsNullOrEmpty(identifier) || identifier.Length > 64
            || !char.IsAsciiLetter(identifier[0])
            || identifier.Any(character => !char.IsAsciiLetterOrDigit(character) && character != '_'))
        {
            throw new ArgumentException("bulk_identifier_invalid", nameof(identifier));
        }
    }
}
