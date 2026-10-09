using System.Data.Common;
using System.Globalization;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

internal sealed record ArticleScaleFieldDifference(
    string Table,
    string RowIdentity,
    string Field,
    string Kind,
    object? ProductionValue = null,
    object? BulkValue = null);

internal sealed record ArticleScaleDifferentialIdentityBindings(
    IReadOnlyDictionary<string, IReadOnlyDictionary<long, string>> TableRoles,
    IReadOnlyDictionary<string, IReadOnlyDictionary<string, string>> ReferenceTargets)
{
    internal static ArticleScaleDifferentialIdentityBindings FromCanonicalGraph(
        ArticleScalePlan plan,
        ArticleScaleArticleGraph graph,
        ArticleScaleGraphIdentityBindings identities,
        IReadOnlyDictionary<ArticleScaleRowKind, DataScaleEntityTransportBinding> schema,
        IReadOnlyDictionary<string, IReadOnlyDictionary<string, string>> referenceTargets)
    {
        identities.ValidateFor(plan, graph.SemanticArticleId);
        CanonicalArticleGraphVerifier.VerifyArticleGraph(plan, graph).ThrowIfInvalid();
        var roles = new Dictionary<string, IReadOnlyDictionary<long, string>>(StringComparer.Ordinal);
        foreach ((ArticleScaleRowKind kind, DataScaleEntityTransportBinding table) in schema)
        {
            var values = new Dictionary<long, string>();
            foreach (ArticleScaleRowPlan row in graph.Rows.Where(row => row.Kind == kind).OrderBy(row => row.SemanticId, StringComparer.Ordinal))
            {
                long id = identities.Resolve(kind == ArticleScaleRowKind.ArticleBody ? graph.SemanticArticleId : row.SemanticId);
                // Content-addressed blocks may have several revision roles for one immutable row.
                if (!values.TryAdd(id, row.SemanticId) && kind != ArticleScaleRowKind.ArticleRevisionContentBlock)
                    throw new InvalidOperationException("differential_duplicate_native_binding");
            }
            roles.Add(table.Table, values);
        }
        return new(roles, referenceTargets);
    }
}

internal sealed record ArticleScaleWriterDifferentialResult(
    string ProductionDigest,
    string BulkDigest,
    IReadOnlyList<ArticleScaleFieldDifference> Differences,
    IReadOnlyList<string> MissingPostconditions)
{
    // Physical equality cannot qualify logical references, recovery or a full seed.
    internal bool PhysicalEquivalent => Differences.Count == 0 && ProductionDigest == BulkDigest;
    internal bool IdentityNormalizedEquivalent => Differences.Count == 0;
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
        DataScaleArticlePhysicalBatch bulk,
        ArticleScaleDifferentialIdentityBindings? productionIdentities = null,
        ArticleScaleDifferentialIdentityBindings? bulkIdentities = null)
    {
        if ((productionIdentities is null) != (bulkIdentities is null))
            throw new InvalidOperationException("differential_identity_binding_pair_required");
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
            int key = production.PrimaryKeyColumns[name];
            Dictionary<string, IReadOnlyList<object?>> leftRows = IndexRows(left, key, productionIdentities);
            Dictionary<string, IReadOnlyList<object?>> rightRows = IndexRows(right, key, bulkIdentities);
            foreach (string identity in leftRows.Keys.Union(rightRows.Keys).Order(StringComparer.Ordinal))
            {
                if (!leftRows.TryGetValue(identity, out IReadOnlyList<object?>? leftRow)
                    || !rightRows.TryGetValue(identity, out IReadOnlyList<object?>? rightRow))
                {
                    differences.Add(new(name, identity, "", leftRow is null ? "extra-row" : "missing-row"));
                    continue;
                }
                for (int column = 0; column < left.Columns.Count; column++)
                {
                    if (!Equals(NormalizeIdentity(left, key, column, leftRow[column], productionIdentities),
                            NormalizeIdentity(right, key, column, rightRow[column], bulkIdentities)))
                    {
                        // Retain the independently observed native values for the sole
                        // field owner. Normalized IDs explain alignment, not new facts.
                        differences.Add(new(name, identity, left.Columns[column].Name, "field-mismatch",
                            leftRow[column], rightRow[column]));
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
        CancellationToken cancellationToken,
        IReadOnlyCollection<string>? requiredTables = null)
    {
        // Compile omits kinds with no expected rows (for example scheduled articles
        // have no publication). Their physical tables must still be independently
        // checked: absence from the projection is not proof of an empty database.
        if (requiredTables is not null)
        {
            var required = requiredTables.ToHashSet(StringComparer.Ordinal);
            if (required.Count != requiredTables.Count
                || !model.Tables.All(table => required.Contains(table.Table)))
                throw new InvalidOperationException("differential_observation_table_coverage_invalid");
            foreach (string name in required)
                DataScaleProviderBulkTransport.ValidateIdentifier(name);
            foreach (string name in required.Except(model.Tables.Select(table => table.Table)).Order(StringComparer.Ordinal))
            {
                cancellationToken.ThrowIfCancellationRequested();
                await using DbCommand empty = connection.CreateCommand();
                empty.CommandTimeout = 30;
                string quoted = provider == DataScaleBulkProvider.MySql ? $"`{name}`" : $"\"{name}\"";
                empty.CommandText = $"SELECT 1 FROM {quoted} LIMIT 1";
                if (await empty.ExecuteScalarAsync(cancellationToken).ConfigureAwait(false) is not null)
                    throw new InvalidOperationException($"differential_unprojected_table_contains_rows:{name}");
            }
        }
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
            tables.Add(table with
            {
                Rows = rows
            });
        }
        return model with
        {
            Tables = tables
        };
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

    private static object? NormalizeIdentity(DataScaleBulkTableRows table, int key, int column,
        object? value, ArticleScaleDifferentialIdentityBindings? identities)
    {
        if (identities is null || value is null)
            return value;
        string? target = column == key ? table.Table : null;
        if (column != key && identities.ReferenceTargets.TryGetValue(table.Table, out IReadOnlyDictionary<string, string>? references))
            references.TryGetValue(table.Columns[column].Name, out target);
        if (target is null)
            return value;
        if (column != key && (table.Columns[column].Type is not (System.Data.DbType.Int32 or System.Data.DbType.Int64)
                || !table.Columns[column].Name.EndsWith("id", StringComparison.OrdinalIgnoreCase)))
            throw new InvalidOperationException("differential_business_field_identity_disposition_refused");
        long id = Convert.ToInt64(value, CultureInfo.InvariantCulture);
        if (!identities.TableRoles.TryGetValue(target, out IReadOnlyDictionary<long, string>? roles)
            || !roles.TryGetValue(id, out string? role))
            throw new InvalidOperationException($"differential_native_role_missing:{target}:{id}");
        return role;
    }

    private static Dictionary<string, IReadOnlyList<object?>> IndexRows(DataScaleBulkTableRows table, int key,
        ArticleScaleDifferentialIdentityBindings? identities)
    {
        if (key < 0 || key >= table.Columns.Count
            || table.Columns.Select(column => column.Name).Distinct(StringComparer.Ordinal).Count() != table.Columns.Count)
            throw new InvalidOperationException("differential_column_or_key_invalid");
        var rows = new Dictionary<string, IReadOnlyList<object?>>(StringComparer.Ordinal);
        foreach (IReadOnlyList<object?> row in table.Rows)
        {
            if (row.Count != table.Columns.Count || row[key] is null)
                throw new InvalidOperationException("differential_row_or_duplicate_key_invalid");
            string identity = Convert.ToString(NormalizeIdentity(table, key, key, row[key], identities), CultureInfo.InvariantCulture)!;
            if (!rows.TryAdd(identity, row))
                throw new InvalidOperationException("differential_row_or_duplicate_key_invalid");
        }
        return rows;
    }
}
