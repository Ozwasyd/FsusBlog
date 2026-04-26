using System.Data;
using System.Reflection;
using SqlSugar;

namespace FsusBlog.Server.Infrastructure.SchemaMigration;

public interface ISchemaModelInspector
{
    IReadOnlyList<Type> GetManagedEntityTypes();
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
    private static readonly NullabilityInfoContext NullabilityContext = new();

    public IReadOnlyList<Type> GetManagedEntityTypes()
        => typeof(SchemaModelInspector).Assembly
            .GetTypes()
            .Where(static type => type.GetCustomAttribute<SugarTable>() is not null)
            .OrderBy(static type => type.FullName, StringComparer.Ordinal)
            .ToArray();

    public SchemaModelSnapshot BuildExpectedModel(IReadOnlyList<Type> entityTypes)
    {
        var tables = new Dictionary<string, SchemaTableModel>(StringComparer.Ordinal);
        foreach (Type entityType in entityTypes)
        {
            SugarTable tableAttribute = entityType.GetCustomAttribute<SugarTable>()
                ?? throw new InvalidOperationException($"Type {entityType.FullName} is missing SugarTable.");
            string tableName = NormalizeIdentifier(tableAttribute.TableName);

            var columns = new Dictionary<string, SchemaColumnModel>(StringComparer.Ordinal);
            foreach (PropertyInfo property in entityType.GetProperties(BindingFlags.Public | BindingFlags.Instance))
            {
                SugarColumn? columnAttribute = property.GetCustomAttribute<SugarColumn>();
                if (columnAttribute?.IsIgnore == true)
                {
                    continue;
                }

                if (property.GetCustomAttribute<Navigate>() is not null)
                {
                    continue;
                }

                string columnName = NormalizeIdentifier(
                    string.IsNullOrWhiteSpace(columnAttribute?.ColumnName)
                        ? property.Name
                        : columnAttribute.ColumnName);

                columns[columnName] = BuildColumnModel(property, columnAttribute, columnName);
            }

            string[] indexes = entityType
                .GetCustomAttributesData()
                .Where(static attribute =>
                    string.Equals(attribute.AttributeType.Name, "SugarIndex", StringComparison.Ordinal)
                    || string.Equals(attribute.AttributeType.Name, "SugarIndexAttribute", StringComparison.Ordinal))
                .Select(static attribute => attribute.ConstructorArguments.Count > 0
                    ? Convert.ToString(attribute.ConstructorArguments[0].Value)
                    : null)
                .Where(static name => !string.IsNullOrWhiteSpace(name))
                .Select(static name => NormalizeIdentifier(name!))
                .Distinct(StringComparer.Ordinal)
                .OrderBy(static name => name, StringComparer.Ordinal)
                .ToArray();

            tables[tableName] = new SchemaTableModel(tableName, columns, indexes);
        }

        return new SchemaModelSnapshot(tables);
    }

    public async Task<SchemaModelSnapshot> ReadActualModelAsync(ISqlSugarClient db, CancellationToken cancellationToken)
    {
        DataTable tableRows = await db.Ado.GetDataTableAsync("""
            SELECT table_name
            FROM information_schema.tables
            WHERE table_schema = 'public' AND table_type = 'BASE TABLE';
            """).ConfigureAwait(false);

        var tables = new Dictionary<string, SchemaTableModel>(StringComparer.Ordinal);
        foreach (DataRow row in tableRows.Rows)
        {
            string tableName = NormalizeIdentifier(Convert.ToString(row["table_name"])!);
            tables[tableName] = new SchemaTableModel(tableName, new Dictionary<string, SchemaColumnModel>(StringComparer.Ordinal), []);
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
            string tableName = NormalizeIdentifier(Convert.ToString(row["table_name"])!);
            if (!tables.TryGetValue(tableName, out SchemaTableModel? table))
            {
                continue;
            }

            string dataType = Convert.ToString(row["data_type"]) ?? string.Empty;
            string udtName = Convert.ToString(row["udt_name"]) ?? string.Empty;
            string actualType = NormalizeActualType(dataType, udtName);
            string columnName = NormalizeIdentifier(Convert.ToString(row["column_name"])!);
            bool isNullable = string.Equals(Convert.ToString(row["is_nullable"]), "YES", StringComparison.OrdinalIgnoreCase);
            string? columnDefault = row["column_default"] is DBNull ? null : Convert.ToString(row["column_default"]);
            bool isIdentity = row["identity_generation"] is not DBNull
                || (!string.IsNullOrWhiteSpace(columnDefault) && columnDefault.Contains("nextval(", StringComparison.OrdinalIgnoreCase));
            bool isPrimaryKey = Convert.ToBoolean(row["is_primary_key"]);
            int? maxLength = row["character_maximum_length"] is DBNull ? null : Convert.ToInt32(row["character_maximum_length"]);

            table.Columns[columnName] = new SchemaColumnModel(
                columnName,
                isNullable,
                isPrimaryKey,
                isIdentity,
                maxLength,
                actualType);
        }

        DataTable indexRows = await db.Ado.GetDataTableAsync("""
            SELECT tablename, indexname
            FROM pg_indexes
            WHERE schemaname = 'public';
            """).ConfigureAwait(false);

        foreach (DataRow row in indexRows.Rows)
        {
            string tableName = NormalizeIdentifier(Convert.ToString(row["tablename"])!);
            if (!tables.TryGetValue(tableName, out SchemaTableModel? table))
            {
                continue;
            }

            table.Indexes.Add(NormalizeIdentifier(Convert.ToString(row["indexname"])!));
        }

        return new SchemaModelSnapshot(tables);
    }

    public async Task ValidateAsync(
        ISqlSugarClient db,
        IReadOnlyList<Type> entityTypes,
        IReadOnlyCollection<string> allowedExtraTables,
        CancellationToken cancellationToken)
    {
        SchemaModelSnapshot expected = BuildExpectedModel(entityTypes);
        SchemaModelSnapshot actual = await ReadActualModelAsync(db, cancellationToken).ConfigureAwait(false);
        var errors = new List<string>();

        foreach ((string tableName, SchemaTableModel expectedTable) in expected.Tables)
        {
            if (!actual.Tables.TryGetValue(tableName, out SchemaTableModel? actualTable))
            {
                errors.Add($"缺少表: {tableName}");
                continue;
            }

            foreach ((string columnName, SchemaColumnModel expectedColumn) in expectedTable.Columns)
            {
                if (!actualTable.Columns.TryGetValue(columnName, out SchemaColumnModel? actualColumn))
                {
                    errors.Add($"表 {tableName} 缺少列: {columnName}");
                    continue;
                }

                if (actualColumn.IsNullable != expectedColumn.IsNullable)
                {
                    errors.Add($"表 {tableName} 列 {columnName} 的 NULL 约束不匹配。期望 {(expectedColumn.IsNullable ? "NULL" : "NOT NULL")}，实际 {(actualColumn.IsNullable ? "NULL" : "NOT NULL")}。");
                }

                if (actualColumn.IsPrimaryKey != expectedColumn.IsPrimaryKey)
                {
                    errors.Add($"表 {tableName} 列 {columnName} 的主键标记不匹配。");
                }

                if (actualColumn.IsIdentity != expectedColumn.IsIdentity)
                {
                    errors.Add($"表 {tableName} 列 {columnName} 的 identity 标记不匹配。");
                }

                if (expectedColumn.MaxLength is int expectedLength && actualColumn.MaxLength != expectedLength)
                {
                    errors.Add($"表 {tableName} 列 {columnName} 的长度不匹配。期望 {expectedLength}，实际 {actualColumn.MaxLength?.ToString() ?? "NULL"}。");
                }

                if (!string.IsNullOrWhiteSpace(expectedColumn.DataType)
                    && !string.Equals(actualColumn.DataType, expectedColumn.DataType, StringComparison.Ordinal))
                {
                    errors.Add($"表 {tableName} 列 {columnName} 的类型不匹配。期望 {expectedColumn.DataType}，实际 {actualColumn.DataType}。");
                }
            }

            string[] extraColumns = actualTable.Columns.Keys
                .Except(expectedTable.Columns.Keys, StringComparer.Ordinal)
                .OrderBy(static name => name, StringComparer.Ordinal)
                .ToArray();
            for (int i = 0; i < extraColumns.Length; i++)
            {
                errors.Add($"表 {tableName} 存在未声明的旧列: {extraColumns[i]}");
            }

            string[] missingIndexes = expectedTable.Indexes
                .Except(actualTable.Indexes, StringComparer.Ordinal)
                .OrderBy(static name => name, StringComparer.Ordinal)
                .ToArray();
            for (int i = 0; i < missingIndexes.Length; i++)
            {
                errors.Add($"表 {tableName} 缺少索引: {missingIndexes[i]}");
            }
        }

        HashSet<string> allowedTables = [.. expected.Tables.Keys, .. allowedExtraTables.Select(NormalizeIdentifier)];
        string[] extraTables = actual.Tables.Keys
            .Except(allowedTables, StringComparer.Ordinal)
            .OrderBy(static name => name, StringComparer.Ordinal)
            .ToArray();
        for (int i = 0; i < extraTables.Length; i++)
        {
            errors.Add($"存在未声明的旧表: {extraTables[i]}");
        }

        if (errors.Count > 0)
        {
            throw new InvalidOperationException($"Schema migration validation failed:{Environment.NewLine}- {string.Join($"{Environment.NewLine}- ", errors)}");
        }
    }

    internal static string NormalizeIdentifier(string name)
        => name.Trim().ToLowerInvariant();

    private static SchemaColumnModel BuildColumnModel(PropertyInfo property, SugarColumn? columnAttribute, string columnName)
    {
        bool isNullable = DetermineNullability(property, columnAttribute);
        bool isPrimaryKey = columnAttribute?.IsPrimaryKey == true;
        bool isIdentity = columnAttribute?.IsIdentity == true;
        int? maxLength = columnAttribute?.Length > 0 ? columnAttribute.Length : null;
        string dataType = ResolveExpectedType(property, columnAttribute);

        return new SchemaColumnModel(columnName, isNullable, isPrimaryKey, isIdentity, maxLength, dataType);
    }

    private static bool DetermineNullability(PropertyInfo property, SugarColumn? columnAttribute)
    {
        if (columnAttribute?.IsNullable == true)
        {
            return true;
        }

        Type propertyType = property.PropertyType;
        if (!propertyType.IsValueType)
        {
            NullabilityInfo info = NullabilityContext.Create(property);
            return info.WriteState != NullabilityState.NotNull;
        }

        return Nullable.GetUnderlyingType(propertyType) is not null;
    }

    private static string ResolveExpectedType(PropertyInfo property, SugarColumn? columnAttribute)
    {
        if (!string.IsNullOrWhiteSpace(columnAttribute?.ColumnDataType))
        {
            return NormalizeDeclaredType(columnAttribute.ColumnDataType);
        }

        Type propertyType = Nullable.GetUnderlyingType(property.PropertyType) ?? property.PropertyType;
        if (propertyType == typeof(int))
        {
            return "integer";
        }

        if (propertyType == typeof(long))
        {
            return "bigint";
        }

        if (propertyType == typeof(bool))
        {
            return "boolean";
        }

        if (propertyType == typeof(DateTime))
        {
            return "timestamp without time zone";
        }

        if (propertyType == typeof(string))
        {
            return columnAttribute?.Length > 0 ? "character varying" : string.Empty;
        }

        if (propertyType.IsEnum)
        {
            return "integer";
        }

        return string.Empty;
    }

    private static string NormalizeDeclaredType(string type)
        => type.Trim().ToLowerInvariant() switch
        {
            "timestamp" => "timestamp without time zone",
            var value => value
        };

    private static string NormalizeActualType(string dataType, string udtName)
    {
        if (string.Equals(dataType, "ARRAY", StringComparison.OrdinalIgnoreCase))
        {
            return udtName.ToLowerInvariant();
        }

        return dataType.Trim().ToLowerInvariant();
    }
}

public sealed class SchemaModelSnapshot(IReadOnlyDictionary<string, SchemaTableModel> tables)
{
    public IReadOnlyDictionary<string, SchemaTableModel> Tables { get; } = tables;
}

public sealed class SchemaTableModel(
    string name,
    Dictionary<string, SchemaColumnModel> columns,
    IEnumerable<string> indexes)
{
    public string Name { get; } = name;
    public Dictionary<string, SchemaColumnModel> Columns { get; } = columns;
    public HashSet<string> Indexes { get; } = [.. indexes];
}

public sealed record SchemaColumnModel(
    string Name,
    bool IsNullable,
    bool IsPrimaryKey,
    bool IsIdentity,
    int? MaxLength,
    string DataType);
