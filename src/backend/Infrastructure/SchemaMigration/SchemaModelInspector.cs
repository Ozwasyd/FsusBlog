using System.Collections.Concurrent;
using System.Data;
using System.Reflection;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.SchemaMigration;

public interface ISchemaModelInspector
{
    IReadOnlyList<Type> GetManagedEntityTypes();
    CurrentSchemaCanonicalModel BuildCanonicalModel(IReadOnlyList<Type> entityTypes);
    SchemaModelSnapshot BuildExpectedModel(IReadOnlyList<Type> entityTypes);
    Task<SchemaModelSnapshot> ReadActualModelAsync(ISqlSugarClient db, CancellationToken cancellationToken);
    Task ValidateAsync(
        ISqlSugarClient db,
        IReadOnlyList<Type> entityTypes,
        IReadOnlyCollection<string> allowedExtraTables,
        CancellationToken cancellationToken);
}

public sealed class SchemaModelInspector : ISchemaModelInspector
{
    private static readonly Lazy<IReadOnlyList<Type>> s_managedEntityTypes = new(
        () => typeof(SchemaModelInspector).Assembly
            .GetTypes()
            .Where(static type => type.GetCustomAttribute<SugarTable>(inherit: false) is not null)
            .OrderBy(static type => type.FullName, StringComparer.Ordinal)
            .ToArray());
    private static readonly ConcurrentDictionary<string, CurrentSchemaCanonicalModel> s_canonicalModelCache = new(StringComparer.Ordinal);

    public IReadOnlyList<Type> GetManagedEntityTypes()
        => s_managedEntityTypes.Value;

    public CurrentSchemaCanonicalModel BuildCanonicalModel(IReadOnlyList<Type> entityTypes)
        => s_canonicalModelCache.GetOrAdd(
            BuildEntityTypeCacheKey(entityTypes),
            _ => CurrentSchemaCanonicalAuthority.Extract(entityTypes));

    public SchemaModelSnapshot BuildExpectedModel(IReadOnlyList<Type> entityTypes)
        => CurrentSchemaCanonicalAuthority.Generate(BuildCanonicalModel(entityTypes)).Schema;

    public async Task<SchemaModelSnapshot> ReadActualModelAsync(
        ISqlSugarClient db,
        CancellationToken cancellationToken)
    {
        DataTable tableRows = await db.Ado.GetDataTableAsync("""
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public' AND table_type = 'BASE TABLE';
            """).ConfigureAwait(false);

        var tables = new Dictionary<string, SchemaTableModel>(StringComparer.Ordinal);
        foreach (DataRow row in tableRows.Rows)
        {
            string tableName = CurrentSchemaCanonicalAuthority.NormalizeIdentifier(Convert.ToString(row["table_name"])!);
            tables[tableName] = NewActualTable(tableName, [], []);
        }

        DataTable columnRows = await db.Ado.GetDataTableAsync("""
            SELECT
                c.table_name,
                c.column_name,
                c.is_nullable,
                c.data_type,
                c.udt_name,
                c.character_maximum_length,
                c.column_default,
                c.identity_generation,
                EXISTS (
                    SELECT 1
                    FROM information_schema.table_constraints tc
                    JOIN information_schema.key_column_usage kcu
                      ON tc.constraint_name = kcu.constraint_name
                     AND tc.table_schema = kcu.table_schema
                    WHERE tc.table_schema = 'public'
                      AND tc.table_name = c.table_name
                      AND tc.constraint_type = 'PRIMARY KEY'
                      AND kcu.column_name = c.column_name
                ) AS is_primary_key
            FROM information_schema.columns c
            WHERE c.table_schema = 'public';
            """).ConfigureAwait(false);

        foreach (DataRow row in columnRows.Rows)
        {
            string tableName = CurrentSchemaCanonicalAuthority.NormalizeIdentifier(Convert.ToString(row["table_name"])!);
            if (!tables.TryGetValue(tableName, out SchemaTableModel? table))
            {
                continue;
            }

            string dataType = Convert.ToString(row["data_type"]) ?? string.Empty;
            string udtName = Convert.ToString(row["udt_name"]) ?? string.Empty;
            string columnName = CurrentSchemaCanonicalAuthority.NormalizeIdentifier(Convert.ToString(row["column_name"])!);
            bool isNullable = string.Equals(Convert.ToString(row["is_nullable"]), "YES", StringComparison.OrdinalIgnoreCase);
            string? rawDefault = row["column_default"] is DBNull ? null : Convert.ToString(row["column_default"]);
            bool isIdentity = row["identity_generation"] is not DBNull
                || (!string.IsNullOrWhiteSpace(rawDefault) && rawDefault.Contains("nextval(", StringComparison.OrdinalIgnoreCase));
            bool isPrimaryKey = Convert.ToBoolean(row["is_primary_key"]);
            int? maxLength = row["character_maximum_length"] is DBNull ? null : Convert.ToInt32(row["character_maximum_length"]);

            table.Columns[columnName] = new SchemaColumnModel(
                columnName,
                isNullable,
                isPrimaryKey,
                isIdentity,
                maxLength,
                NormalizePostgresSemanticType(dataType, udtName),
                isIdentity ? null : NormalizePostgresDefault(rawDefault),
                "none",
                Owner: new SchemaOwnerModel("postgresql", $"public.{tableName}.{columnName}"));
        }

        DataTable indexRows = await db.Ado.GetDataTableAsync("""
            SELECT
                table_rel.relname AS table_name,
                index_rel.relname AS index_name,
                index_meta.indisunique AS is_unique,
                COALESCE(string_agg(column_meta.attname, ',' ORDER BY index_column.ordinality), '') AS columns
            FROM pg_index index_meta
            JOIN pg_class table_rel ON table_rel.oid = index_meta.indrelid
            JOIN pg_namespace table_namespace ON table_namespace.oid = table_rel.relnamespace
            JOIN pg_class index_rel ON index_rel.oid = index_meta.indexrelid
            CROSS JOIN LATERAL unnest(index_meta.indkey) WITH ORDINALITY AS index_column(attnum, ordinality)
            LEFT JOIN pg_attribute column_meta
              ON column_meta.attrelid = table_rel.oid
             AND column_meta.attnum = index_column.attnum
            WHERE table_namespace.nspname = 'public'
            GROUP BY table_rel.relname, index_rel.relname, index_meta.indisunique;
            """).ConfigureAwait(false);

        foreach (DataRow row in indexRows.Rows)
        {
            string tableName = CurrentSchemaCanonicalAuthority.NormalizeIdentifier(Convert.ToString(row["table_name"])!);
            if (tables.TryGetValue(tableName, out SchemaTableModel? table))
            {
                string indexName = CurrentSchemaCanonicalAuthority.NormalizeIdentifier(Convert.ToString(row["index_name"])!);
                string[] columns = ParseIdentifierList(Convert.ToString(row["columns"]));
                table.Indexes.Add(indexName);
                ((Dictionary<string, SchemaIndexModel>)table.IndexDefinitions).Add(
                    indexName,
                    new SchemaIndexModel(indexName, Convert.ToBoolean(row["is_unique"]), columns));
            }
        }

        DataTable constraintRows = await db.Ado.GetDataTableAsync("""
            SELECT
                table_rel.relname AS table_name,
                constraint_meta.conname AS constraint_name,
                constraint_meta.contype AS constraint_type,
                COALESCE((
                    SELECT string_agg(column_meta.attname, ',' ORDER BY constraint_column.ordinality)
                    FROM unnest(constraint_meta.conkey) WITH ORDINALITY AS constraint_column(attnum, ordinality)
                    JOIN pg_attribute column_meta
                      ON column_meta.attrelid = constraint_meta.conrelid
                     AND column_meta.attnum = constraint_column.attnum
                ), '') AS columns,
                referenced_rel.relname AS referenced_table,
                COALESCE((
                    SELECT string_agg(column_meta.attname, ',' ORDER BY referenced_column.ordinality)
                    FROM unnest(constraint_meta.confkey) WITH ORDINALITY AS referenced_column(attnum, ordinality)
                    JOIN pg_attribute column_meta
                      ON column_meta.attrelid = constraint_meta.confrelid
                     AND column_meta.attnum = referenced_column.attnum
                ), '') AS referenced_columns,
                CASE
                    WHEN constraint_meta.contype = 'c'
                    THEN pg_get_expr(constraint_meta.conbin, constraint_meta.conrelid)
                    ELSE NULL
                END AS expression
            FROM pg_constraint constraint_meta
            JOIN pg_class table_rel ON table_rel.oid = constraint_meta.conrelid
            JOIN pg_namespace table_namespace ON table_namespace.oid = table_rel.relnamespace
            LEFT JOIN pg_class referenced_rel ON referenced_rel.oid = constraint_meta.confrelid
            WHERE table_namespace.nspname = 'public'
              AND constraint_meta.contype IN ('p', 'u', 'f', 'c');
            """).ConfigureAwait(false);

        foreach (DataRow row in constraintRows.Rows)
        {
            string tableName = CurrentSchemaCanonicalAuthority.NormalizeIdentifier(Convert.ToString(row["table_name"])!);
            if (!tables.TryGetValue(tableName, out SchemaTableModel? table))
            {
                continue;
            }

            string physicalName = CurrentSchemaCanonicalAuthority.NormalizeIdentifier(Convert.ToString(row["constraint_name"])!);
            string kind = Convert.ToString(row["constraint_type"]) switch
            {
                "p" => "primary-key",
                "u" => "unique",
                "f" => "foreign-key",
                "c" => "check",
                string unknown => throw new InvalidOperationException($"Unsupported PostgreSQL current schema constraint type: {unknown}."),
                null => throw new InvalidOperationException("PostgreSQL current schema constraint type is null.")
            };
            string name = kind == "primary-key" ? $"pk_{tableName}" : physicalName;
            string[] columns = ParseIdentifierList(Convert.ToString(row["columns"]));
            string? referencedTable = row["referenced_table"] is DBNull
                ? null
                : CurrentSchemaCanonicalAuthority.NormalizeIdentifier(Convert.ToString(row["referenced_table"])!);
            string[] referencedColumns = ParseIdentifierList(Convert.ToString(row["referenced_columns"]));
            string? expression = row["expression"] is DBNull ? null : Convert.ToString(row["expression"])?.Trim();
            ((Dictionary<string, SchemaConstraintModel>)table.Constraints).TryAdd(
                name,
                new SchemaConstraintModel(
                    name,
                    kind,
                    columns,
                    referencedTable,
                    referencedColumns.Length == 0 ? null : referencedColumns,
                    expression));
        }

        foreach ((string tableName, SchemaTableModel table) in tables.ToArray())
        {
            var constraints = (Dictionary<string, SchemaConstraintModel>)table.Constraints;
            foreach (SchemaIndexModel index in table.IndexDefinitions.Values.Where(static index => index.IsUnique))
            {
                constraints.TryAdd(index.Name, new SchemaConstraintModel(index.Name, "unique", index.Columns));
            }
        }

        return new SchemaModelSnapshot(tables, provider: SchemaProviderKind.PostgreSql);
    }

    public async Task ValidateAsync(
        ISqlSugarClient db,
        IReadOnlyList<Type> entityTypes,
        IReadOnlyCollection<string> allowedExtraTables,
        CancellationToken cancellationToken)
    {
        SchemaModelSnapshot expected = BuildExpectedModel(entityTypes);
        SchemaModelSnapshot actual = await ReadActualModelAsync(db, cancellationToken).ConfigureAwait(false);
        IReadOnlyList<string> errors = SchemaModelComparer.Compare(expected, actual, allowedExtraTables);
        if (errors.Count > 0)
        {
            throw new InvalidOperationException($"Schema migration validation failed:{Environment.NewLine}- {string.Join($"{Environment.NewLine}- ", errors)}");
        }
    }

    internal static string NormalizeIdentifier(string name)
        => CurrentSchemaCanonicalAuthority.NormalizeIdentifier(name);

    private static string BuildEntityTypeCacheKey(IReadOnlyList<Type> entityTypes)
        => string.Join('|', entityTypes.Select(static type => type.AssemblyQualifiedName ?? type.FullName ?? type.Name));

    private static SchemaTableModel NewActualTable(
        string tableName,
        Dictionary<string, SchemaColumnModel> columns,
        IEnumerable<string> indexes,
        IReadOnlyDictionary<string, SchemaConstraintModel>? constraints = null)
        => new(
            tableName,
            columns,
            indexes,
            constraints: constraints,
            owner: new SchemaOwnerModel("postgresql", $"public.{tableName}"));

    private static string NormalizePostgresSemanticType(string dataType, string udtName)
    {
        if (string.Equals(dataType, "ARRAY", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException($"Unsupported PostgreSQL current schema array type: {udtName}.");
        }
        return SchemaPhysicalTypeProjection.NormalizeDeclaredSemantic(dataType);
    }

    private static string? NormalizePostgresDefault(string? rawDefault)
    {
        if (string.IsNullOrWhiteSpace(rawDefault))
        {
            return null;
        }

        string value = rawDefault.Trim();
        int cast = value.IndexOf("::", StringComparison.Ordinal);
        if (cast >= 0)
        {
            value = value[..cast];
        }
        if (value.Length >= 2 && value[0] == '\'' && value[^1] == '\'')
        {
            value = value[1..^1].Replace("''", "'", StringComparison.Ordinal);
        }
        return string.Equals(value, "NULL", StringComparison.OrdinalIgnoreCase) ? null : value;
    }

    private static string[] ParseIdentifierList(string? value)
        => string.IsNullOrWhiteSpace(value)
            ? []
            : value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(CurrentSchemaCanonicalAuthority.NormalizeIdentifier)
                .ToArray();
}
