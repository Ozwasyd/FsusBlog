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
    {
        ArgumentNullException.ThrowIfNull(connection);
        ArgumentNullException.ThrowIfNull(tables);
        ArgumentNullException.ThrowIfNull(verify);
        Validate(connection, provider, tables, expectedSemanticDigest);

        var timer = Stopwatch.StartNew();
        int commands = 0;
        long rows = 0;
        bool commitStarted = false;
        string? digest = null;
        await using DbTransaction transaction = await connection.BeginTransactionAsync(
            IsolationLevel.Serializable, cancellationToken).ConfigureAwait(false);
        try
        {
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

    private static void ValidateIdentifier(string identifier)
    {
        if (string.IsNullOrEmpty(identifier) || identifier.Length > 64
            || !char.IsAsciiLetter(identifier[0])
            || identifier.Any(character => !char.IsAsciiLetterOrDigit(character) && character != '_'))
        {
            throw new ArgumentException("bulk_identifier_invalid", nameof(identifier));
        }
    }
}
