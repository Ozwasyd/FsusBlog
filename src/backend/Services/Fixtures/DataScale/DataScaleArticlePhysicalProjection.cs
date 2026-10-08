using System.Globalization;
using System.Reflection;

using SqlSugar;

using FsusBlog.Server.Entities;

using DbType = System.Data.DbType;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

/// <summary>Prepared-schema property/column bindings, supplied by the offline schema owner.</summary>
internal sealed record DataScaleEntityTransportBinding(
    string Table,
    IReadOnlyDictionary<string, string> Columns);

internal sealed record DataScaleArticlePhysicalBatch(
    IReadOnlyList<DataScaleBulkTableRows> Tables,
    IReadOnlyDictionary<string, int> PrimaryKeyColumns,
    IReadOnlyList<ArticleScaleRowPlan> LogicalReferences,
    IReadOnlyDictionary<string, long> LogicalRowCounts)
{
    internal IReadOnlyDictionary<string, IReadOnlyList<int>> DeferredColumns
    {
        get; init;
    }
        = new Dictionary<string, IReadOnlyList<int>>(StringComparer.Ordinal);
}

internal sealed record DataScaleArticlePhysicalWritePlan(
    IReadOnlyList<DataScaleBulkTableRows> Inserts,
    IReadOnlyList<DataScaleBulkTableRows> DeferredUpdates);

/// <summary>
/// Compiles canonical values against the current persistence models once, for all providers.
/// It does not allocate IDs, infer business values, write SQL or qualify schema/admission.
/// Current-pointer cycle handling and checkpoint ownership belong to the atomic graph host.
/// </summary>
internal static class DataScaleArticlePhysicalProjection
{
    // Physical dependency order is shared. Providers receive only columns, types and values.
    private static readonly (ArticleScaleRowKind Kind, Type Entity)[] s_entities =
    [
        (ArticleScaleRowKind.Article, typeof(Article)),
        (ArticleScaleRowKind.ArticleBody, typeof(ArticleBody)),
        (ArticleScaleRowKind.ArticleRightsPolicy, typeof(ArticleRightsPolicy)),
        (ArticleScaleRowKind.ArticleRevisionContentBlock, typeof(ArticleRevisionContentBlock)),
        (ArticleScaleRowKind.ArticleRevision, typeof(ArticleRevision)),
        (ArticleScaleRowKind.ArticleRightsSnapshot, typeof(ArticleRightsSnapshot)),
        (ArticleScaleRowKind.ArticleResponsibilitySnapshot, typeof(ArticleResponsibilitySnapshot)),
        (ArticleScaleRowKind.ArticlePublication, typeof(ArticlePublicationRecord)),
        (ArticleScaleRowKind.ArticleRightsProof, typeof(ArticleRightsProof)),
        (ArticleScaleRowKind.ArticleMutationOutboxEnvelope, typeof(ArticleMutationOutboxEvent)),
        (ArticleScaleRowKind.ArticleMutationOutboxEdge, typeof(ArticleMutationOutboxEdge))
    ];

    internal static IReadOnlyList<(ArticleScaleRowKind Kind, Type Entity)> EntityModels => s_entities;

    internal static DataScaleArticlePhysicalBatch Compile(
        ArticleScalePlan plan,
        IReadOnlyList<ArticleScaleArticleGraph> graphs,
        IReadOnlyDictionary<string, ArticleScaleGraphIdentityBindings> identities,
        IReadOnlyDictionary<ArticleScaleRowKind, DataScaleEntityTransportBinding> schema,
        IReadOnlyDictionary<string, long> externalIdentities)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(graphs);
        ArgumentNullException.ThrowIfNull(identities);
        ArgumentNullException.ThrowIfNull(schema);
        ArgumentNullException.ThrowIfNull(externalIdentities);
        ArticleScalePlanValidator.Validate(plan, plan.Artifacts).ThrowIfInvalid();
        if (!s_entities.Select(entity => entity.Kind).ToHashSet().SetEquals(schema.Keys))
        {
            throw new InvalidOperationException("physical_schema_kind_coverage_mismatch");
        }
        if (graphs.Count == 0 || graphs.Count > 1000
            || graphs.Select(graph => graph.SemanticArticleId).Distinct(StringComparer.Ordinal).Count() != graphs.Count
            || !graphs.Select(graph => graph.SemanticArticleId).ToHashSet(StringComparer.Ordinal).SetEquals(identities.Keys))
        {
            throw new InvalidOperationException("physical_batch_identity_or_bound_invalid");
        }

        var roleIds = new Dictionary<string, long>(externalIdentities, StringComparer.Ordinal);
        foreach (ArticleScaleArticleGraph graph in graphs)
        {
            CanonicalArticleGraphVerifier.VerifyArticleGraph(plan, graph).ThrowIfInvalid();
            ArticleScaleGraphIdentityBindings binding = identities[graph.SemanticArticleId];
            binding.ValidateFor(plan, graph.SemanticArticleId);
            if (!graph.Rows.Where(row => row.Kind is not (ArticleScaleRowKind.ArticleBody
                    or ArticleScaleRowKind.ArticleTaxonomyReference or ArticleScaleRowKind.ArticleAuditCoordinate))
                .Select(row => row.SemanticId).ToHashSet(StringComparer.Ordinal).SetEquals(binding.Ids.Keys))
            {
                throw new InvalidOperationException("physical_identity_role_coverage_mismatch");
            }
            foreach (ArticleScaleRowPlan row in graph.Rows.Where(row => binding.Ids.ContainsKey(row.SemanticId)))
            {
                if (!row.Fields.TryGetValue("Id", out object? id) || id is not (int or long)
                    || Convert.ToInt64(id, CultureInfo.InvariantCulture) != binding.Ids[row.SemanticId])
                {
                    throw new InvalidOperationException("physical_graph_unbound_or_native_id_mismatch");
                }
            }
            int start = plan.IdAllocation.ArticleOrdinalBase;
            ArticleScaleVariant? allocated = null;
            foreach (ArticleScaleVariantAllocation allocation in plan.StateDistribution)
            {
                if (graph.ArticleOrdinal >= start && graph.ArticleOrdinal < start + allocation.Count)
                {
                    allocated = allocation.Variant;
                    break;
                }
                start += allocation.Count;
            }
            if (allocated != graph.Variant)
            {
                throw new InvalidOperationException("physical_variant_allocation_mismatch");
            }
            foreach ((string role, long id) in binding.Ids)
            {
                if (!roleIds.TryAdd(role, id))
                {
                    throw new InvalidOperationException("physical_duplicate_semantic_role");
                }
            }
        }

        var tables = new List<DataScaleBulkTableRows>();
        var keys = new Dictionary<string, int>(StringComparer.Ordinal);
        var deferred = new Dictionary<string, IReadOnlyList<int>>(StringComparer.Ordinal);
        foreach ((ArticleScaleRowKind kind, Type entity) in s_entities)
        {
            if (!schema.TryGetValue(kind, out DataScaleEntityTransportBinding? binding))
            {
                throw new InvalidOperationException($"physical_schema_binding_missing:{kind}");
            }
            DataScaleProviderBulkTransport.ValidateIdentifier(binding.Table);
            string tableOwner = (string)entity.GetCustomAttributesData().Single(
                attribute => attribute.AttributeType == typeof(SugarTable)).ConstructorArguments[0].Value!;
            if (!string.Equals(binding.Table, tableOwner, StringComparison.Ordinal))
            {
                throw new InvalidOperationException($"physical_table_owner_mismatch:{kind}");
            }
            PropertyInfo[] properties = entity.GetProperties().Where(property =>
                property.GetCustomAttribute<SugarColumn>()?.IsIgnore != true)
                .OrderBy(property => property.Name, StringComparer.Ordinal).ToArray();
            if (!properties.Select(property => property.Name).ToHashSet(StringComparer.Ordinal).SetEquals(binding.Columns.Keys)
                || binding.Columns.Values.Distinct(StringComparer.Ordinal).Count() != binding.Columns.Count)
            {
                throw new InvalidOperationException($"physical_schema_property_coverage_mismatch:{kind}");
            }
            var columns = new List<DataScaleBulkColumn>();
            foreach (PropertyInfo property in properties)
            {
                string column = binding.Columns[property.Name];
                DataScaleProviderBulkTransport.ValidateIdentifier(column);
                columns.Add(new(column, ColumnType(property.PropertyType)));
            }
            var rows = new List<IReadOnlyList<object?>>();
            var unique = new Dictionary<long, object?[]>();
            foreach (ArticleScaleRowPlan row in graphs.SelectMany(graph => graph.Rows).Where(row => row.Kind == kind))
            {
                object?[] values = properties.Select(property => Value(row, property, roleIds)).ToArray();
                long id = roleIds[kind == ArticleScaleRowKind.ArticleBody
                    ? Convert.ToString(row.Fields["ArticleSemanticId"], CultureInfo.InvariantCulture)!
                    : row.SemanticId];
                if (unique.TryGetValue(id, out object?[]? existing))
                {
                    if (kind != ArticleScaleRowKind.ArticleRevisionContentBlock || !existing.SequenceEqual(values))
                    {
                        throw new InvalidOperationException($"physical_duplicate_or_conflicting_id:{kind}");
                    }
                    continue;
                }
                unique.Add(id, values);
                rows.Add(values);
            }
            if (rows.Count != 0)
            {
                int[] primary = properties.Select((property, index) => (property, index))
                    .Where(item => item.property.GetCustomAttribute<SugarColumn>()?.IsPrimaryKey == true)
                    .Select(item => item.index).ToArray();
                if (primary.Length != 1)
                {
                    throw new InvalidOperationException("physical_primary_key_shape_unsupported");
                }
                tables.Add(new(binding.Table, columns, rows));
                keys.Add(binding.Table, primary[0]);
                string[] cycleProperties = kind switch
                {
                    ArticleScaleRowKind.Article => [nameof(Article.CurrentRevisionId), nameof(Article.CurrentPublicationId)],
                    ArticleScaleRowKind.ArticleResponsibilitySnapshot => [nameof(ArticleResponsibilitySnapshot.PreviousSnapshotId)],
                    _ => []
                };
                int[] cycleColumns = cycleProperties.Select(name => Array.FindIndex(properties, property => property.Name == name)).ToArray();
                if (cycleColumns.Any(index => index < 0 || properties[index].GetCustomAttribute<SugarColumn>()?.IsNullable != true))
                {
                    throw new InvalidOperationException("physical_deferred_column_contract_mismatch");
                }
                if (cycleColumns.Length != 0)
                {
                    deferred.Add(binding.Table, cycleColumns);
                }
            }
        }
        ArticleScaleRowPlan[] references = graphs.SelectMany(graph => graph.Rows).Where(row =>
            row.Kind is ArticleScaleRowKind.ArticleTaxonomyReference or ArticleScaleRowKind.ArticleAuditCoordinate).ToArray();
        Dictionary<string, long> counts = graphs.SelectMany(graph => graph.Rows).GroupBy(row => row.Kind)
            .ToDictionary(group => group.Key.ToString(), group => group.LongCount(), StringComparer.Ordinal);
        // Logical taxonomy/audit references remain explicit obligations. This projection does
        // not fabricate product audit rows or silently claim article_tag/checkpoint persistence.
        return new(tables, keys, references, counts)
        {
            DeferredColumns = deferred
        };
    }

    // The exact final factory values are retained; only nullable FK cycles are deferred
    // within the same transaction. Providers receive no entity or lifecycle knowledge.
    internal static DataScaleArticlePhysicalWritePlan PrepareWrites(DataScaleArticlePhysicalBatch batch)
    {
        var inserts = new List<DataScaleBulkTableRows>();
        var updates = new List<DataScaleBulkTableRows>();
        foreach (DataScaleBulkTableRows table in batch.Tables)
        {
            if (!batch.DeferredColumns.TryGetValue(table.Table, out IReadOnlyList<int>? deferred))
            {
                inserts.Add(table);
                continue;
            }
            int key = batch.PrimaryKeyColumns[table.Table];
            int[] indexes = new[] { key }.Concat(deferred).ToArray();
            if (indexes.Distinct().Count() != indexes.Length || indexes.Any(index => index < 0 || index >= table.Columns.Count))
            {
                throw new InvalidOperationException("physical_deferred_column_shape_invalid");
            }
            inserts.Add(table with
            {
                Rows = table.Rows.Select(row => (IReadOnlyList<object?>)row.Select((value, index) => deferred.Contains(index) ? null : value).ToArray()).ToArray()
            });
            updates.Add(new(table.Table, indexes.Select(index => table.Columns[index]).ToArray(),
                table.Rows.Select(row => (IReadOnlyList<object?>)indexes.Select(index => row[index]).ToArray()).ToArray()));
        }
        return new(inserts, updates);
    }

    private static object? Value(ArticleScaleRowPlan row, PropertyInfo property, IReadOnlyDictionary<string, long> ids)
    {
        object? value;
        if (!row.Fields.TryGetValue(property.Name, out value))
        {
            string semanticName = property.Name.EndsWith("Id", StringComparison.Ordinal)
                ? property.Name[..^2] + "SemanticId" : string.Empty;
            if (semanticName.Length == 0 || !row.Fields.TryGetValue(semanticName, out object? semantic)
                || semantic is not string role || !ids.TryGetValue(role, out long nativeId) || nativeId <= 0)
            {
                throw new InvalidOperationException($"physical_factory_field_missing:{row.Kind}.{property.Name}");
            }
            value = nativeId;
        }
        if (property.Name == "Id" && (!ids.TryGetValue(row.SemanticId, out long expected)
            || Convert.ToInt64(value, CultureInfo.InvariantCulture) != expected))
        {
            throw new InvalidOperationException("physical_native_id_mismatch");
        }
        if (value is null)
        {
            if (property.GetCustomAttribute<SugarColumn>()?.IsNullable != true
                && Nullable.GetUnderlyingType(property.PropertyType) is null)
            {
                throw new InvalidOperationException($"physical_required_null:{row.Kind}.{property.Name}");
            }
            return null;
        }
        Type type = Nullable.GetUnderlyingType(property.PropertyType) ?? property.PropertyType;
        if (type == typeof(DateTime))
        {
            return value is DateTime instant ? instant : DateTime.ParseExact(
                (string)value, "O", CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind);
        }
        if (type.IsEnum)
        {
            int numeric = Convert.ToInt32(value, CultureInfo.InvariantCulture);
            if (!Enum.IsDefined(type, numeric))
            {
                throw new InvalidOperationException("physical_enum_value_invalid");
            }
            return numeric;
        }
        return Convert.ChangeType(value, type, CultureInfo.InvariantCulture);
    }

    private static DbType ColumnType(Type type)
    {
        type = Nullable.GetUnderlyingType(type) ?? type;
        if (type.IsEnum || type == typeof(int))
            return DbType.Int32;
        if (type == typeof(long))
            return DbType.Int64;
        if (type == typeof(string))
            return DbType.String;
        if (type == typeof(bool))
            return DbType.Boolean;
        if (type == typeof(DateTime))
            return DbType.DateTime;
        throw new InvalidOperationException($"physical_column_type_unsupported:{type.Name}");
    }
}
