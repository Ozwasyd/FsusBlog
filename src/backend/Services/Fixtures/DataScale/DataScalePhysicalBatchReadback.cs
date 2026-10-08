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
        return Digest(batch.Tables, batch);
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
        await ObserveExternalReferencesAsync(connection, transaction, provider, expected.ExternalReferences, violations, cancellationToken).ConfigureAwait(false);
        string digest = Digest(observed, expected);
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
        int referenceViolations = violations.Count;
        await ObserveExternalReferencesAsync(connection, transaction, provider, expected.ExternalReferences, violations, cancellationToken).ConfigureAwait(false);
        bool referencesExact = violations.Count == referenceViolations;
        long observedRows = observed.Sum(table => (long)table.Rows.Count);
        string observedDigest = Digest(observed, expected);
        if (observedDigest != expectedDigest)
        {
            violations.Add("physical_value_digest_mismatch");
        }
        DataScalePhysicalRecoveryState state = observedRows == 0 && referencesExact
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
            IReadOnlyList<int> keys = KeyColumns(expected, table.Table);
            expected.OwnedRowScopes.TryGetValue(table.Table, out DataScaleOwnedRowScope? scope);
            if (expected.CompositePrimaryKeyColumns.ContainsKey(table.Table))
            {
                await DataScaleProviderBulkTransport.ValidateNativePrimaryKeysAsync(connection, transaction, provider, table.Table,
                    keys.Select(key => table.Columns[key].Name).ToArray(), cancellationToken).ConfigureAwait(false);
            }
            var rows = new List<IReadOnlyList<object?>>();
            var seen = new HashSet<string>(StringComparer.Ordinal);
            HashSet<string> requested = table.Rows.Select(row => KeyToken(row, keys)).ToHashSet(StringComparer.Ordinal);
            int width = scope is null ? keys.Count : 1;
            int size = Math.Min(256, ((provider == DataScaleBulkProvider.Sqlite ? 999 : 2000) - 1) / width);
            int requestedCount = scope is null ? table.Rows.Count : scope.Values.Count;
            for (int offset = 0; offset < requestedCount; offset += size)
            {
                cancellationToken.ThrowIfCancellationRequested();
                await using DbCommand command = connection.CreateCommand();
                command.Transaction = transaction;
                command.CommandTimeout = 30;
                int count = Math.Min(size, requestedCount - offset);
                var predicates = new List<string>();
                for (int index = 0; index < count; index++)
                {
                    var tuple = new List<string>();
                    for (int part = 0; part < width; part++)
                    {
                        int column = scope?.Column ?? keys[part];
                        string name = $"@k{index}_{part}";
                        AddParameter(command, name, table.Columns[column].Type,
                            scope is null ? table.Rows[offset + index][column]! : scope.Values[offset + index]);
                        tuple.Add($"{Quote(provider, table.Columns[column].Name)}={name}");
                    }
                    predicates.Add("(" + string.Join(" AND ", tuple) + ")");
                }
                // The owned group scope reads every link for the explicit article IDs, including
                // unplanned tuples. Limit+1 detects excess without an unbounded materialization.
                AddParameter(command, "@limit", DbType.Int32, table.Rows.Count + 1);
                command.CommandText = $"SELECT {string.Join(',', table.Columns.Select(column => Quote(provider, column.Name)))} FROM {Quote(provider, table.Table)} WHERE {string.Join(" OR ", predicates)} LIMIT @limit";
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
                    string key = KeyToken(values, keys);
                    if (!seen.Add(key))
                    {
                        violations.Add($"physical_duplicate_key:{table.Table}");
                    }
                    rows.Add(values);
                }
                if (rows.Count > table.Rows.Count)
                {
                    violations.Add($"physical_owned_scope_extra_rows:{table.Table}");
                    break;
                }
            }
            if (rows.Count != table.Rows.Count || !seen.SetEquals(requested))
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
            || expected.PrimaryKeyColumns.Keys.Intersect(expected.CompositePrimaryKeyColumns.Keys, StringComparer.Ordinal).Any()
            || !expected.Tables.Select(table => table.Table).ToHashSet(StringComparer.Ordinal).SetEquals(
                expected.PrimaryKeyColumns.Keys.Concat(expected.CompositePrimaryKeyColumns.Keys))
            || expected.OwnedRowScopes.Keys.Any(table => !expected.CompositePrimaryKeyColumns.ContainsKey(table))
            || expected.ExternalReferences.Count > 32
            || expected.ExternalReferences.Sum(reference => (long)reference.Values.Count) > 50_000)
        {
            throw new InvalidOperationException("physical_expected_batch_shape_invalid");
        }
        foreach (DataScaleBulkTableRows table in expected.Tables)
        {
            IReadOnlyList<int> keys = KeyColumns(expected, table.Table);
            if (table.Columns.Count is < 1 or > 128 || keys.Count is < 1 or > 8 || keys.Distinct().Count() != keys.Count
                || keys.Any(key => key < 0 || key >= table.Columns.Count || table.Columns[key].Type is not (DbType.Int32 or DbType.Int64))
                || table.Rows.Any(row => row.Count != table.Columns.Count || keys.Any(key => row[key] is not (int or long))))
            {
                throw new InvalidOperationException("physical_expected_key_shape_invalid");
            }
            string[] ids = table.Rows.Select(row => KeyToken(row, keys)).ToArray();
            if (table.Rows.Any(row => keys.Any(key => Convert.ToInt64(row[key], CultureInfo.InvariantCulture) <= 0))
                || ids.Length != ids.Distinct(StringComparer.Ordinal).Count())
            {
                throw new InvalidOperationException("physical_expected_duplicate_or_nonpositive_key");
            }
            if (expected.OwnedRowScopes.TryGetValue(table.Table, out DataScaleOwnedRowScope? scope)
                && (!keys.Contains(scope.Column) || scope.Values.Count is < 1 or > 1000
                    || scope.Values.Any(value => value <= 0) || scope.Values.Distinct().Count() != scope.Values.Count
                    || table.Rows.Any(row => !scope.Values.Contains(Convert.ToInt64(row[scope.Column], CultureInfo.InvariantCulture)))))
            {
                throw new InvalidOperationException("physical_owned_scope_shape_invalid");
            }
        }
        foreach (DataScaleExternalReferenceKeys reference in expected.ExternalReferences)
        {
            DataScaleProviderBulkTransport.ValidateIdentifier(reference.Table);
            DataScaleProviderBulkTransport.ValidateIdentifier(reference.Key.Name);
            if (reference.Key.Type is not (DbType.Int32 or DbType.Int64) || reference.Values.Any(id => id <= 0)
                || reference.Values.Distinct().Count() != reference.Values.Count)
            {
                throw new InvalidOperationException("physical_external_reference_keys_invalid");
            }
        }
    }

    internal static IReadOnlyList<int> KeyColumns(DataScaleArticlePhysicalBatch batch, string table)
        => batch.PrimaryKeyColumns.TryGetValue(table, out int key) ? new[] { key } : batch.CompositePrimaryKeyColumns[table];
    internal static string KeyToken(IReadOnlyList<object?> row, IReadOnlyList<int> keys)
        => string.Join(',', keys.Select(key => Convert.ToInt64(row[key], CultureInfo.InvariantCulture).ToString(CultureInfo.InvariantCulture)));

    private static void AddParameter(DbCommand command, string name, DbType type, object value)
    {
        DbParameter parameter = command.CreateParameter();
        parameter.ParameterName = name;
        parameter.DbType = type;
        parameter.Value = value;
        command.Parameters.Add(parameter);
    }

    private static async Task ObserveExternalReferencesAsync(DbConnection connection, DbTransaction transaction,
        DataScaleBulkProvider provider, IReadOnlyList<DataScaleExternalReferenceKeys> references,
        List<string> violations, CancellationToken cancellationToken)
    {
        foreach (DataScaleExternalReferenceKeys reference in references)
        {
            await DataScaleProviderBulkTransport.ValidateNativePrimaryKeysAsync(connection, transaction, provider,
                reference.Table, [reference.Key.Name], cancellationToken).ConfigureAwait(false);
            var found = new HashSet<long>();
            for (int offset = 0; offset < reference.Values.Count; offset += 256)
            {
                await using DbCommand command = connection.CreateCommand();
                command.Transaction = transaction;
                command.CommandTimeout = 30;
                int count = Math.Min(256, reference.Values.Count - offset);
                string[] parameters = Enumerable.Range(0, count).Select(index => "@r" + index).ToArray();
                for (int index = 0; index < count; index++)
                {
                    AddParameter(command, parameters[index], reference.Key.Type, reference.Values[offset + index]);
                }
                command.CommandText = $"SELECT {Quote(provider, reference.Key.Name)} FROM {Quote(provider, reference.Table)} WHERE {Quote(provider, reference.Key.Name)} IN ({string.Join(',', parameters)})";
                await using DbDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
                while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    if (!found.Add(Convert.ToInt64(reader.GetValue(0), CultureInfo.InvariantCulture)))
                    {
                        violations.Add($"physical_external_duplicate_key:{reference.Table}");
                    }
                }
            }
            if (!found.SetEquals(reference.Values))
            {
                violations.Add($"physical_external_orphan_reference:{reference.Table}");
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

    private static string Digest(IReadOnlyList<DataScaleBulkTableRows> tables, DataScaleArticlePhysicalBatch batch)
    {
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        void Append(string value)
        {
            byte[] bytes = Encoding.UTF8.GetBytes(value);
            hash.AppendData(Encoding.ASCII.GetBytes(bytes.Length.ToString(CultureInfo.InvariantCulture) + ":"));
            hash.AppendData(bytes);
        }
        bool composite = batch.CompositePrimaryKeyColumns.Count != 0;
        Append(composite ? "physical-row-integrity.v2" : "physical-row-integrity.v1");
        if (composite)
        {
            foreach (var pair in batch.CompositePrimaryKeyColumns.OrderBy(pair => pair.Key, StringComparer.Ordinal))
            {
                Append(pair.Key);
                foreach (int key in pair.Value)
                    Append(key.ToString(CultureInfo.InvariantCulture));
            }
            foreach (var pair in batch.OwnedRowScopes.OrderBy(pair => pair.Key, StringComparer.Ordinal))
            {
                Append(pair.Key);
                Append(pair.Value.Column.ToString(CultureInfo.InvariantCulture));
                foreach (long value in pair.Value.Values.Order())
                    Append(value.ToString(CultureInfo.InvariantCulture));
            }
            foreach (DataScaleExternalReferenceKeys reference in batch.ExternalReferences.OrderBy(reference => reference.Table, StringComparer.Ordinal))
            {
                Append(reference.Table);
                Append(reference.Key.Name);
                Append(reference.Key.Type.ToString());
                foreach (long id in reference.Values.Order())
                    Append(id.ToString(CultureInfo.InvariantCulture));
            }
        }
        foreach (DataScaleBulkTableRows table in tables.OrderBy(table => table.Table, StringComparer.Ordinal))
        {
            Append(table.Table);
            foreach (DataScaleBulkColumn column in table.Columns)
            {
                Append(column.Name);
                Append(column.Type.ToString());
            }
            IEnumerable<IReadOnlyList<object?>> ordered = composite
                ? table.Rows.OrderBy(row => KeyToken(row, KeyColumns(batch, table.Table)), StringComparer.Ordinal)
                : table.Rows.OrderBy(row => Convert.ToInt64(row[batch.PrimaryKeyColumns[table.Table]], CultureInfo.InvariantCulture));
            foreach (IReadOnlyList<object?> row in ordered)
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
