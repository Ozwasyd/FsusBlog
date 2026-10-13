using System.Data.Common;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using DbType = System.Data.DbType;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

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
        var observed = new List<DataScaleBulkTableRows>();
        var violations = new List<string>();
        foreach (DataScaleBulkTableRows table in expected.Tables)
        {
            int key = expected.PrimaryKeyColumns[table.Table];
            long[] ids = table.Rows.Select(row => Convert.ToInt64(row[key], CultureInfo.InvariantCulture)).Order().ToArray();
            if (ids.Length != ids.Distinct().Count())
            {
                throw new InvalidOperationException("physical_expected_duplicate_key");
            }
            var rows = new List<IReadOnlyList<object?>>();
            var seen = new HashSet<long>();
            int size = provider == DataScaleBulkProvider.Sqlite ? 999 : 2000;
            for (int offset = 0; offset < ids.Length; offset += size)
            {
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
        string digest = Digest(observed, expected.PrimaryKeyColumns);
        if (digest != ExpectedDigest(expected))
        {
            violations.Add("physical_value_digest_mismatch");
        }
        return new(digest, violations);
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
