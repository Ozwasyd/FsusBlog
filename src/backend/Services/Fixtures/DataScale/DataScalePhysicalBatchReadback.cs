using System.Data.Common;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using DbType = System.Data.DbType;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

internal enum DataScalePhysicalRecoveryState
{
    Empty,
    Exact,
    Conflict
}

internal sealed record DataScalePhysicalRecoveryObservation(
    DataScalePhysicalRecoveryState State,
    long RowsObserved,
    string ExpectedDigest,
    string ObservedDigest,
    IReadOnlyList<string> Violations);

/// <summary>
/// Independently reads every persisted column for an explicitly bound physical batch.
/// This is a physical integrity check; logical reference persistence, external FK existence,
/// complete semantic invariants and ownership/admission remain graph-host obligations.
/// </summary>
internal static class DataScalePhysicalBatchReadback
{
    internal static string ExpectedDigest(DataScaleArticlePhysicalBatch batch)
    {
        if (batch.Tables.SelectMany(table => table.Rows).SelectMany(row => row)
            .Any(value => value is DateTime time && time.Kind != DateTimeKind.Utc))
        {
            throw new InvalidOperationException("physical_expected_datetime_not_utc");
        }
        return Digest(batch.Tables, batch.PrimaryKeyColumns);
    }

    internal static async Task<DataScaleBulkPostconditions> ObserveAsync(
        DbConnection connection,
        DbTransaction transaction,
        DataScaleBulkProvider provider,
        DataScaleArticlePhysicalBatch expected,
        CancellationToken cancellationToken)
    {
        ValidateExpected(expected);
        var (observed, violations) = await ReadAsync(connection, transaction, provider, expected,
            cancellationToken).ConfigureAwait(false);
        string digest = Digest(observed, expected.PrimaryKeyColumns);
        if (digest != ExpectedDigest(expected))
        {
            violations.Add("physical_value_digest_mismatch");
        }
        return new(digest, violations);
    }

    // Read-only evidence for reconciling an interrupted physical batch. Exact keys must come
    // from the authenticated run checkpoint, never from discovery. This does not establish
    // ownership, authorize cleanup, allocate IDs, or accept logical/derived graph obligations.
    // The host must keep reconciliation and any subsequent write in the same transaction.
    internal static async Task<DataScalePhysicalRecoveryObservation> ObserveRecoveryAsync(
        DbConnection connection,
        DbTransaction transaction,
        DataScaleBulkProvider provider,
        DataScaleArticlePhysicalBatch expected,
        CancellationToken cancellationToken)
    {
        ValidateExpected(expected);
        long expectedRows = expected.Tables.Sum(table => (long)table.Rows.Count);
        if (expectedRows == 0)
        {
            throw new InvalidOperationException("physical_recovery_expected_batch_empty");
        }
        string expectedDigest = ExpectedDigest(expected);
        var (observed, violations) = await ReadAsync(connection, transaction, provider, expected,
            cancellationToken).ConfigureAwait(false);
        long observedRows = observed.Sum(table => (long)table.Rows.Count);
        string observedDigest = Digest(observed, expected.PrimaryKeyColumns);
        if (observedDigest != expectedDigest)
        {
            violations.Add("physical_value_digest_mismatch");
        }
        DataScalePhysicalRecoveryState state = observedRows == 0
            ? DataScalePhysicalRecoveryState.Empty
            : violations.Count == 0 && observedDigest == expectedDigest
                ? DataScalePhysicalRecoveryState.Exact
                : DataScalePhysicalRecoveryState.Conflict;
        return new(state, observedRows, expectedDigest, observedDigest, violations);
    }

    private static async Task<(List<DataScaleBulkTableRows> Tables, List<string> Violations)> ReadAsync(
        DbConnection connection,
        DbTransaction transaction,
        DataScaleBulkProvider provider,
        DataScaleArticlePhysicalBatch expected,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        var observed = new List<DataScaleBulkTableRows>();
        var violations = new List<string>();
        foreach (DataScaleBulkTableRows table in expected.Tables)
        {
            int key = expected.PrimaryKeyColumns[table.Table];
            long[] ids = table.Rows.Select(row => Convert.ToInt64(row[key], CultureInfo.InvariantCulture)).Order().ToArray();
            var rows = new List<IReadOnlyList<object?>>();
            var seen = new HashSet<long>();
            int size = provider == DataScaleBulkProvider.Sqlite ? 999 : 2000;
            for (int offset = 0; offset < ids.Length; offset += size)
            {
                cancellationToken.ThrowIfCancellationRequested();
                await using DbCommand command = connection.CreateCommand();
                command.Transaction = transaction;
                command.CommandTimeout = 30;
                int count = Math.Min(size, ids.Length - offset);
                var parameters = new List<string>();
                for (int index = 0; index < count; index++)
                {
                    string name = $"@k{index}";
                    DbParameter parameter = command.CreateParameter();
                    parameter.ParameterName = name;
                    parameter.DbType = table.Columns[key].Type;
                    parameter.Value = ids[offset + index];
                    command.Parameters.Add(parameter);
                    parameters.Add(name);
                }
                command.CommandText = $"SELECT {string.Join(',', table.Columns.Select(column => Quote(provider, column.Name)))} FROM {Quote(provider, table.Table)} WHERE {Quote(provider, table.Columns[key].Name)} IN ({string.Join(',', parameters)})";
                await using DbDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
                while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    var values = new object?[table.Columns.Count];
                    for (int column = 0; column < values.Length; column++)
                    {
                        values[column] = reader.IsDBNull(column) ? null : table.Columns[column].Type switch
                        {
                            DbType.Int32 => Convert.ToInt32(reader.GetValue(column), CultureInfo.InvariantCulture),
                            DbType.Int64 => Convert.ToInt64(reader.GetValue(column), CultureInfo.InvariantCulture),
                            DbType.Boolean => Convert.ToBoolean(reader.GetValue(column), CultureInfo.InvariantCulture),
                            DbType.String => reader.GetString(column),
                            DbType.DateTime => NormalizeDatabaseUtc(reader.GetDateTime(column)),
                            _ => throw new InvalidOperationException("physical_readback_type_unsupported")
                        };
                    }
                    long id = Convert.ToInt64(values[key], CultureInfo.InvariantCulture);
                    if (!seen.Add(id))
                    {
                        violations.Add($"physical_duplicate_key:{table.Table}");
                    }
                    rows.Add(values);
                }
            }
            if (rows.Count != table.Rows.Count || !seen.SetEquals(ids))
            {
                violations.Add($"physical_key_set_mismatch:{table.Table}");
            }
            observed.Add(table with
            {
                Rows = rows
            });
        }
        return (observed, violations);
    }

    private static void ValidateExpected(DataScaleArticlePhysicalBatch expected)
    {
        if (expected.Tables.Count is < 1 or > 32
            || expected.Tables.Sum(table => (long)table.Rows.Count) > 50_000
            || expected.Tables.Select(table => table.Table).Distinct(StringComparer.Ordinal).Count() != expected.Tables.Count
            || !expected.Tables.Select(table => table.Table).ToHashSet(StringComparer.Ordinal).SetEquals(expected.PrimaryKeyColumns.Keys))
        {
            throw new InvalidOperationException("physical_expected_batch_shape_invalid");
        }
        foreach (DataScaleBulkTableRows table in expected.Tables)
        {
            int key = expected.PrimaryKeyColumns[table.Table];
            if (table.Columns.Count is < 1 or > 128 || key < 0 || key >= table.Columns.Count
                || table.Columns[key].Type is not (DbType.Int32 or DbType.Int64)
                || table.Rows.Any(row => row.Count != table.Columns.Count || row[key] is not (int or long)))
            {
                throw new InvalidOperationException("physical_expected_key_shape_invalid");
            }
            long[] ids = table.Rows.Select(row => Convert.ToInt64(row[key], CultureInfo.InvariantCulture)).ToArray();
            if (ids.Any(id => id <= 0) || ids.Length != ids.Distinct().Count())
            {
                throw new InvalidOperationException("physical_expected_duplicate_or_nonpositive_key");
            }
        }
    }

    private static DateTime NormalizeDatabaseUtc(DateTime value)
        => value.Kind switch
        {
            DateTimeKind.Utc => value,
            DateTimeKind.Unspecified => DateTime.SpecifyKind(value, DateTimeKind.Utc),
            _ => throw new InvalidOperationException("physical_database_datetime_not_utc")
        };

    private static string Digest(IReadOnlyList<DataScaleBulkTableRows> tables, IReadOnlyDictionary<string, int> keys)
    {
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        void Append(string value)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(value);
            hash.AppendData(Encoding.ASCII.GetBytes(bytes.Length.ToString(CultureInfo.InvariantCulture) + ":"));
            hash.AppendData(bytes);
        }
        Append("physical-row-integrity.v1");
        foreach (DataScaleBulkTableRows table in tables.OrderBy(table => table.Table, StringComparer.Ordinal))
        {
            Append(table.Table);
            foreach (DataScaleBulkColumn column in table.Columns)
            {
                Append(column.Name);
                Append(column.Type.ToString());
            }
            foreach (IReadOnlyList<object?> row in table.Rows.OrderBy(row => Convert.ToInt64(row[keys[table.Table]], CultureInfo.InvariantCulture)))
            {
                Append("row");
                foreach (object? value in row)
                {
                    Append(value is null ? "null" : "value");
                    if (value is not null)
                    {
                        Append(value is DateTime time ? time.ToString("O", CultureInfo.InvariantCulture)
                            : Convert.ToString(value, CultureInfo.InvariantCulture)!);
                    }
                }
            }
            Append("end-table");
        }
        return "sha256:" + Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
    }

    private static string Quote(DataScaleBulkProvider provider, string identifier)
    {
        DataScaleProviderBulkTransport.ValidateIdentifier(identifier);
        return provider == DataScaleBulkProvider.MySql ? $"`{identifier}`" : $"\"{identifier}\"";
    }
}
