using System.Collections.Immutable;
using System.Data.Common;
using System.Globalization;

using FsusBlog.Contracts.Schema;

namespace FsusBlog.Migration;

// These are measured native values, not a semantic target or a compiler profile.
// In particular native datetime(6) cannot select timestamp-with-offset semantics.
internal sealed record MySqlObservedColumnPhysicalFacts(long Ordinal, string PhysicalType,
    bool IsNullable, string? DefaultValue, SchemaMySqlColumnPhysicalFacts Physical);
internal sealed record MySqlObservedIndexKeyPhysicalFacts(long Ordinal, string? Column,
    string? Direction, string Nullable, SchemaMySqlIndexKeyPhysicalFacts Physical);
internal sealed record MySqlObservedIndexPhysicalFacts(bool IsUnique, string AccessMethod,
    SchemaMySqlIndexPhysicalFacts Physical, ImmutableArray<MySqlObservedIndexKeyPhysicalFacts> Keys);
internal sealed record MySqlObservedTablePhysicalFacts(SchemaMySqlTablePhysicalFacts Physical,
    ImmutableDictionary<string, MySqlObservedColumnPhysicalFacts> Columns,
    ImmutableDictionary<string, MySqlObservedIndexPhysicalFacts> Indexes);
internal sealed record MySqlCurrentSchemaPhysicalObservation(MySqlCurrentSchemaCatalog Raw,
    ImmutableDictionary<string, MySqlObservedTablePhysicalFacts> Tables);

/// <summary>
/// Converts the original native catalog into the original Shared MySQL physical
/// fact types without dropping the complete raw constraint/effect observations.
/// It never supplies expected facts or grants current-schema admission. The owned
/// MySQL expected profile/compiler and allocator/guard protocols remain separate.
/// </summary>
internal static class MySqlCurrentSchemaPhysicalObserver
{
    internal static async Task<MySqlCurrentSchemaPhysicalObservation> ReadAsync(
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
        => Observe(await MySqlCurrentSchemaCatalogObserver.ReadAsync(connection, transaction,
            cancellationToken).ConfigureAwait(false));

    internal static MySqlCurrentSchemaPhysicalObservation Observe(MySqlCurrentSchemaCatalog raw)
    {
        ArgumentNullException.ThrowIfNull(raw);
        if (raw.Rows.IsDefault || raw.Session.IsDefault || raw.Session.Any(static cell => cell is null)
            || raw.Database != MySqlCurrentSchemaCatalogObserver.RequireObservedSession(raw.Session))
            throw Failure("native_identity_required");
        foreach (MySqlCatalogRow row in raw.Rows)
        {
            if (row is null || !Enum.IsDefined(row.Part) || row.Cells.IsDefault
                || row.Cells.Any(static cell => cell is null)
                || !row.Cells.Select(static cell => cell.Name).SequenceEqual(
                    MySqlCurrentSchemaCatalogObserver.ObservedFieldNames(row.Part)))
                throw Failure("complete_native_fields_required");
            MySqlCurrentSchemaCatalogObserver.RequireCompleteDefinition(row);
        }

        MySqlCatalogRow[] tableRows = Rows(MySqlCatalogPart.Tables);
        var tableNames = new HashSet<string>(StringComparer.Ordinal);
        foreach (MySqlCatalogRow row in tableRows)
            if (!tableNames.Add(Text(row, "TABLE_NAME")))
                throw Failure("duplicate_table");
        foreach (MySqlCatalogRow row in raw.Rows.Where(static row => row.Part is MySqlCatalogPart.Columns
            or MySqlCatalogPart.IndexParts or MySqlCatalogPart.Constraints or MySqlCatalogPart.ConstraintColumns
            or MySqlCatalogPart.References or MySqlCatalogPart.Partitions or MySqlCatalogPart.Views))
            if (!tableNames.Contains(Text(row, "TABLE_NAME")))
                throw Failure("orphan_table_fact");
        foreach (MySqlCatalogRow row in Rows(MySqlCatalogPart.Triggers))
            if (Text(row, "EVENT_OBJECT_SCHEMA") != raw.Database.DatabaseId
                || !tableNames.Contains(Text(row, "EVENT_OBJECT_TABLE")))
                throw Failure("orphan_trigger");

        var routines = new HashSet<(string Name, string Type)>();
        foreach (MySqlCatalogRow row in Rows(MySqlCatalogPart.Routines))
        {
            string type = Text(row, "ROUTINE_TYPE");
            if (type is not ("FUNCTION" or "PROCEDURE") || !routines.Add((Text(row, "ROUTINE_NAME"), type)))
                throw Failure("routine_identity_invalid");
        }
        var parameters = new HashSet<(string Name, string Type, long Ordinal)>();
        foreach (MySqlCatalogRow row in Rows(MySqlCatalogPart.RoutineParameters))
        {
            var owner = (Text(row, "SPECIFIC_NAME"), Text(row, "ROUTINE_TYPE"));
            long ordinal = Integer(row, "ORDINAL_POSITION", allowZero: true);
            if (!routines.Contains(owner) || !parameters.Add((owner.Item1, owner.Item2, ordinal))
                || (ordinal == 0 && owner.Item2 != "FUNCTION"))
                throw Failure("parameter_owner_invalid");
        }

        var tables = ImmutableDictionary.CreateBuilder<string, MySqlObservedTablePhysicalFacts>(StringComparer.Ordinal);
        foreach (MySqlCatalogRow table in tableRows)
        {
            string name = Text(table, "TABLE_NAME"), type = Text(table, "TABLE_TYPE");
            if (type is not ("BASE TABLE" or "VIEW"))
                throw Failure("table_type_unavailable");
            MySqlCatalogRow[] views = Rows(MySqlCatalogPart.Views, name);
            if ((type == "VIEW" && views.Length != 1) || (type == "BASE TABLE" && views.Length != 0)
                || (type == "VIEW" && Rows(MySqlCatalogPart.Triggers).Any(row => Field(row, "EVENT_OBJECT_TABLE") == name)))
                throw Failure("table_effect_owner_invalid");
            MySqlCatalogRow[] partitions = Rows(MySqlCatalogPart.Partitions, name);
            if (type == "BASE TABLE" && (partitions.Length == 0 || string.IsNullOrWhiteSpace(Field(table, "ENGINE"))
                || string.IsNullOrWhiteSpace(Field(table, "ROW_FORMAT")) || string.IsNullOrWhiteSpace(Field(table, "TABLE_COLLATION"))))
                throw Failure("complete_table_physical_required");
            SchemaMySqlPartitionPhysicalFacts[] partitionFacts = partitions.Select(Partition).ToArray();
            if (partitionFacts.Distinct().Count() != partitionFacts.Length
                || (partitionFacts.Any(static fact => fact.Name is null) && partitionFacts.Length != 1))
                throw Failure("partition_identity_invalid");
            if (partitionFacts.All(static fact => fact.Name is not null))
            {
                IGrouping<string?, SchemaMySqlPartitionPhysicalFacts>[] groups = partitionFacts.GroupBy(static fact => fact.Name).ToArray();
                for (int ordinal = 0; ordinal < groups.Length; ordinal++)
                {
                    SchemaMySqlPartitionPhysicalFacts[] group = groups[ordinal].ToArray();
                    if (group.Any(fact => fact.Ordinal != ordinal + 1)
                        || (group.Length > 1 && group.Any(static fact => fact.SubpartitionName is null)))
                        throw Failure("partition_ordinal_invalid");
                    for (int sub = 0; sub < group.Length; sub++)
                        if (group[sub].SubpartitionName is not null && group[sub].SubpartitionOrdinal != sub + 1)
                            throw Failure("partition_ordinal_invalid");
                }
            }
            var physical = new SchemaMySqlTablePhysicalFacts(type, Field(table, "ENGINE"), Field(table, "ROW_FORMAT"),
                Field(table, "TABLE_COLLATION"), Text(table, "CREATE_OPTIONS", allowEmpty: true),
                Text(table, "TABLE_COMMENT", allowEmpty: true), partitionFacts.ToImmutableArray());

            var columns = ImmutableDictionary.CreateBuilder<string, MySqlObservedColumnPhysicalFacts>(StringComparer.Ordinal);
            MySqlCatalogRow[] columnRows = Rows(MySqlCatalogPart.Columns, name);
            RequireOrdinal(columnRows, "ORDINAL_POSITION");
            if (columnRows.Length == 0)
                throw Failure("complete_columns_required");
            foreach (MySqlCatalogRow column in columnRows)
            {
                string columnName = Text(column, "COLUMN_NAME");
                string nullable = Text(column, "IS_NULLABLE");
                if (nullable is not ("YES" or "NO"))
                    throw Failure("column_nullability_invalid");
                uint? spatial = Field(column, "SRS_ID") is { } value
                    ? uint.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out uint id)
                        ? id : throw Failure("spatial_reference_invalid") : null;
                var facts = new SchemaMySqlColumnPhysicalFacts(Field(column, "CHARACTER_SET_NAME"), Field(column, "COLLATION_NAME"),
                    Text(column, "EXTRA", allowEmpty: true), Text(column, "GENERATION_EXPRESSION", allowEmpty: true),
                    Text(column, "COLUMN_COMMENT", allowEmpty: true), spatial);
                if (!columns.TryAdd(columnName, new(Integer(column, "ORDINAL_POSITION"), Text(column, "COLUMN_TYPE"),
                    nullable == "YES", Field(column, "COLUMN_DEFAULT"), facts)))
                    throw Failure("duplicate_column");
            }

            var indexes = ImmutableDictionary.CreateBuilder<string, MySqlObservedIndexPhysicalFacts>(StringComparer.Ordinal);
            foreach (IGrouping<string, MySqlCatalogRow> index in Rows(MySqlCatalogPart.IndexParts, name)
                .GroupBy(row => Text(row, "INDEX_NAME"), StringComparer.Ordinal))
            {
                MySqlCatalogRow[] keys = index.ToArray();
                RequireOrdinal(keys, "SEQ_IN_INDEX");
                string unique = Text(keys[0], "NON_UNIQUE"), visible = Text(keys[0], "IS_VISIBLE"), method = Text(keys[0], "INDEX_TYPE");
                if (unique is not ("0" or "1") || visible is not ("YES" or "NO")
                    || method is not ("BTREE" or "HASH" or "FULLTEXT" or "RTREE"))
                    throw Failure("index_attributes_invalid");
                var facts = new SchemaMySqlIndexPhysicalFacts(visible == "YES", Text(keys[0], "COMMENT", allowEmpty: true),
                    Text(keys[0], "INDEX_COMMENT", allowEmpty: true));
                var observedKeys = ImmutableArray.CreateBuilder<MySqlObservedIndexKeyPhysicalFacts>();
                foreach (MySqlCatalogRow key in keys)
                {
                    if (Text(key, "NON_UNIQUE") != unique || Text(key, "IS_VISIBLE") != visible || Text(key, "INDEX_TYPE") != method
                        || Text(key, "COMMENT", allowEmpty: true) != facts.Comment
                        || Text(key, "INDEX_COMMENT", allowEmpty: true) != facts.IndexComment)
                        throw Failure("index_attributes_inconsistent");
                    string? column = Field(key, "COLUMN_NAME"), expression = Field(key, "EXPRESSION"), direction = Field(key, "COLLATION");
                    long? prefix = OptionalInteger(key, "SUB_PART");
                    string nullable = Text(key, "NULLABLE", allowEmpty: true);
                    if ((column is null) == (expression is null) || column == string.Empty || expression == string.Empty
                        || (expression is not null && prefix is not null) || (column is not null && !columns.ContainsKey(column))
                        || direction is not (null or "A" or "D") || nullable is not ("" or "YES"))
                        throw Failure("index_key_invalid");
                    observedKeys.Add(new(Integer(key, "SEQ_IN_INDEX"), column, direction, nullable, new(prefix, expression)));
                }
                indexes.Add(index.Key, new(unique == "0", method, facts, observedKeys.ToImmutable()));
            }
            tables.Add(name, new(physical, columns.ToImmutable(), indexes.ToImmutable()));
        }
        return new(raw, tables.ToImmutable());

        MySqlCatalogRow[] Rows(MySqlCatalogPart part, string? table = null)
            => raw.Rows.Where(row => row.Part == part && (table is null || Field(row, "TABLE_NAME") == table)).ToArray();
    }

    private static SchemaMySqlPartitionPhysicalFacts Partition(MySqlCatalogRow row)
    {
        var fact = new SchemaMySqlPartitionPhysicalFacts(Field(row, "PARTITION_NAME"), Field(row, "SUBPARTITION_NAME"),
            OptionalInteger(row, "PARTITION_ORDINAL_POSITION"), OptionalInteger(row, "SUBPARTITION_ORDINAL_POSITION"),
            Field(row, "PARTITION_METHOD"), Field(row, "SUBPARTITION_METHOD"), Field(row, "PARTITION_EXPRESSION"),
            Field(row, "SUBPARTITION_EXPRESSION"), Field(row, "PARTITION_DESCRIPTION"), Field(row, "TABLESPACE_NAME"));
        if ((fact.Name is null) != (fact.Ordinal is null) || (fact.Name is null) != (fact.Method is null)
            || (fact.SubpartitionName is null) != (fact.SubpartitionOrdinal is null)
            || (fact.SubpartitionName is null) != (fact.SubpartitionMethod is null)
            || (fact.Name is null && (fact.Expression is not null || fact.Description is not null || fact.SubpartitionName is not null))
            || (fact.SubpartitionName is null && fact.SubpartitionExpression is not null))
            throw Failure("partition_identity_invalid");
        return fact;
    }

    private static void RequireOrdinal(MySqlCatalogRow[] rows, string field)
    {
        for (int index = 0; index < rows.Length; index++)
            if (Integer(rows[index], field) != index + 1)
                throw Failure("native_ordinal_invalid");
    }

    private static string? Field(MySqlCatalogRow row, string name) => row.Cells.Single(cell => cell.Name == name).Value;
    private static string Text(MySqlCatalogRow row, string name, bool allowEmpty = false)
        => Field(row, name) is { } value && (allowEmpty || value.Length > 0) ? value : throw Failure("native_field_unavailable");
    private static long Integer(MySqlCatalogRow row, string name, bool allowZero = false)
        => long.TryParse(Text(row, name), NumberStyles.None, CultureInfo.InvariantCulture, out long value)
            && (allowZero ? value >= 0 : value > 0) ? value : throw Failure("native_integer_invalid");
    private static long? OptionalInteger(MySqlCatalogRow row, string name) => Field(row, name) is null ? null : Integer(row, name);
    private static InvalidOperationException Failure(string code) => new("mysql_current_physical_" + code);
}
