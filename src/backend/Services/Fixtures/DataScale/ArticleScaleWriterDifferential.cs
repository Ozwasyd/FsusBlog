using System.Data.Common;
using System.Globalization;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

internal sealed record ArticleScaleFieldDifference(
    string Table,
    string RowIdentity,
    string Field,
    string Kind);

internal sealed record ArticleScaleWriterDifferentialResult(
    string ProductionDigest,
    string BulkDigest,
    IReadOnlyList<ArticleScaleFieldDifference> Differences,
    IReadOnlyList<string> MissingPostconditions)
{
    // Physical equality cannot qualify logical references, recovery or a full seed.
    internal bool PhysicalEquivalent => Differences.Count == 0 && ProductionDigest == BulkDigest;
    internal bool QualificationEligible => PhysicalEquivalent && MissingPostconditions.Count == 0;
}

/// <summary>
/// Exact persisted-column differential for independently observed writer roots. Uses the
/// existing physical model and native bindings; no field is volatile or silently omitted.
/// This diagnostic deliberately retains missing full-graph postconditions.
/// </summary>
internal static class ArticleScaleWriterDifferential
{
    internal static ArticleScaleWriterDifferentialResult Compare(
        DataScaleArticlePhysicalBatch production,
        DataScaleArticlePhysicalBatch bulk)
    {
        var differences = new List<ArticleScaleFieldDifference>();
        Dictionary<string, DataScaleBulkTableRows> productionTables = IndexTables(production);
        Dictionary<string, DataScaleBulkTableRows> bulkTables = IndexTables(bulk);
        foreach (string name in productionTables.Keys.Union(bulkTables.Keys).Order(StringComparer.Ordinal))
        {
            if (!productionTables.TryGetValue(name, out DataScaleBulkTableRows? left)
                || !bulkTables.TryGetValue(name, out DataScaleBulkTableRows? right))
            {
                differences.Add(new(name, "", "", left is null ? "extra-table" : "missing-table"));
                continue;
            }
            if (!left.Columns.SequenceEqual(right.Columns)
                || production.PrimaryKeyColumns[name] != bulk.PrimaryKeyColumns[name])
            {
                differences.Add(new(name, "", "", "schema-mismatch"));
                continue;
            }
            Dictionary<long, IReadOnlyList<object?>> leftRows = IndexRows(left, production.PrimaryKeyColumns[name]);
            Dictionary<long, IReadOnlyList<object?>> rightRows = IndexRows(right, bulk.PrimaryKeyColumns[name]);
            foreach (long id in leftRows.Keys.Union(rightRows.Keys).Order())
            {
                string identity = id.ToString(CultureInfo.InvariantCulture);
                if (!leftRows.TryGetValue(id, out IReadOnlyList<object?>? leftRow)
                    || !rightRows.TryGetValue(id, out IReadOnlyList<object?>? rightRow))
                {
                    differences.Add(new(name, identity, "", leftRow is null ? "extra-row" : "missing-row"));
                    continue;
                }
                for (int column = 0; column < left.Columns.Count; column++)
                {
                    if (!Equals(leftRow[column], rightRow[column]))
                    {
                        differences.Add(new(name, identity, left.Columns[column].Name, "field-mismatch"));
                    }
                }
            }
        }
        // The #2542 physical batch explicitly leaves these references unpersisted.
        // Do not let equal physical hashes turn that absence into graph acceptance.
        string[] missing = production.LogicalReferences.Concat(bulk.LogicalReferences)
            .Select(row => $"logical-persistence-unverified:{row.Kind}")
            .Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal)
            .Concat(["semantic-orphan-verifier-unavailable", "owned-recovery-verifier-unavailable"])
            .ToArray();
        return new(DataScalePhysicalBatchReadback.ExpectedDigest(production),
            DataScalePhysicalBatchReadback.ExpectedDigest(bulk), differences, missing);
    }

    /// <summary>
    /// Reads all rows and columns in a task-owned isolated root, including extra rows.
    /// The schema shape is checked against SELECT * before any value comparison.
    /// Never use this bounded diagnostic on a shared or full-scale database.
    /// </summary>
    internal static async Task<DataScaleArticlePhysicalBatch> ObserveIsolatedRootAsync(
        DbConnection connection,
        DataScaleBulkProvider provider,
        DataScaleArticlePhysicalBatch model,
        CancellationToken cancellationToken)
    {
        var tables = new List<DataScaleBulkTableRows>();
        long totalRows = 0;
        foreach (DataScaleBulkTableRows table in model.Tables)
        {
            await using DbCommand command = connection.CreateCommand();
            command.CommandTimeout = 30;
            DataScaleProviderBulkTransport.ValidateIdentifier(table.Table);
            string quoted = provider == DataScaleBulkProvider.MySql ? $"`{table.Table}`" : $"\"{table.Table}\"";
            command.CommandText = $"SELECT * FROM {quoted}";
            await using DbDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
            string[] columns = Enumerable.Range(0, reader.FieldCount).Select(reader.GetName).ToArray();
            if (columns.Length != table.Columns.Count
                || !columns.ToHashSet(StringComparer.Ordinal).SetEquals(table.Columns.Select(column => column.Name)))
            {
                throw new InvalidOperationException($"differential_database_schema_drift:{table.Table}");
            }
            var rows = new List<IReadOnlyList<object?>>();
            while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                if (++totalRows > 50_000)
                    throw new InvalidOperationException("differential_sample_bound_exceeded");
                object?[] values = table.Columns.Select(column =>
                {
                    int ordinal = reader.GetOrdinal(column.Name);
                    if (reader.IsDBNull(ordinal))
                        return null;
                    return column.Type switch
                    {
                        System.Data.DbType.Int32 => (object)Convert.ToInt32(reader.GetValue(ordinal), CultureInfo.InvariantCulture),
                        System.Data.DbType.Int64 => Convert.ToInt64(reader.GetValue(ordinal), CultureInfo.InvariantCulture),
                        System.Data.DbType.Boolean => Convert.ToBoolean(reader.GetValue(ordinal), CultureInfo.InvariantCulture),
                        System.Data.DbType.String => reader.GetString(ordinal),
                        System.Data.DbType.DateTime => DatabaseUtc(reader.GetDateTime(ordinal)),
                        _ => throw new InvalidOperationException("differential_column_type_unsupported")
                    };
                }).ToArray();
                rows.Add(values);
            }
            tables.Add(table with { Rows = rows });
        }
        return model with { Tables = tables };
    }

    private static DateTime DatabaseUtc(DateTime value)
        => value.Kind switch
        {
            DateTimeKind.Utc => value,
            DateTimeKind.Unspecified => DateTime.SpecifyKind(value, DateTimeKind.Utc),
            _ => throw new InvalidOperationException("differential_database_time_not_utc")
        };

    private static Dictionary<string, DataScaleBulkTableRows> IndexTables(DataScaleArticlePhysicalBatch batch)
    {
        if (batch.Tables.Count == 0 || batch.Tables.Select(table => table.Table).Distinct(StringComparer.Ordinal).Count() != batch.Tables.Count
            || !batch.PrimaryKeyColumns.Keys.ToHashSet(StringComparer.Ordinal).SetEquals(batch.Tables.Select(table => table.Table)))
            throw new InvalidOperationException("differential_table_or_key_coverage_invalid");
        return batch.Tables.ToDictionary(table => table.Table, StringComparer.Ordinal);
    }

    private static Dictionary<long, IReadOnlyList<object?>> IndexRows(DataScaleBulkTableRows table, int key)
    {
        if (key < 0 || key >= table.Columns.Count
            || table.Columns.Select(column => column.Name).Distinct(StringComparer.Ordinal).Count() != table.Columns.Count)
            throw new InvalidOperationException("differential_column_or_key_invalid");
        var rows = new Dictionary<long, IReadOnlyList<object?>>();
        foreach (IReadOnlyList<object?> row in table.Rows)
        {
            if (row.Count != table.Columns.Count || row[key] is null
                || !rows.TryAdd(Convert.ToInt64(row[key], CultureInfo.InvariantCulture), row))
                throw new InvalidOperationException("differential_row_or_duplicate_key_invalid");
        }
        return rows;
    }
}
