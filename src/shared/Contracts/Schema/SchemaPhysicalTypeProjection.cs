using System.Text.RegularExpressions;

namespace FsusBlog.Contracts.Schema;

public static class SchemaPhysicalTypeProjection
{
    public static string NormalizeDeclaredSemantic(string declaredType)
        => TryNormalizeDeclaredSemantic(declaredType)
            ?? throw new InvalidOperationException($"Unsupported provider type mapping: {declaredType.Trim().ToLowerInvariant()}.");

    public static string? TryNormalizeDeclaredSemantic(string declaredType)
    {
        string normalized = NormalizePhysical(declaredType);
        if (normalized.Contains('[') || normalized.Contains(']'))
        {
            return normalized switch
            {
                "smallint[]" => "int16-array",
                "uuid[]" => "uuid-array",
                "text[]" => "string-array",
                _ => null
            };
        }
        int modifier = normalized.IndexOf('(', StringComparison.Ordinal);
        string baseType = modifier < 0 ? normalized : normalized[..modifier].TrimEnd();
        return baseType switch
        {
            "varchar" or "character varying" or "text" or "longtext" => "string",
            "int" or "integer" => "int32",
            "bigint" => "int64",
            "smallint" => "int16",
            "bool" or "boolean" or "tinyint(1)" => "boolean",
            "timestamp" or "timestamp without time zone" or "datetime" => "timestamp",
            "timestamp with time zone" or "timestamptz" => "timestamp-with-offset",
            "date" => "date",
            "time" or "time without time zone" => "time",
            "uuid" => "uuid",
            "bytea" or "blob" or "varbinary" => "bytes",
            "json" or "jsonb" => "json",
            "numeric" or "decimal" => "decimal",
            "real" or "float" => "single",
            "double" or "double precision" => "double",
            _ => null
        };
    }

    public static string NormalizePhysical(string physicalType)
    {
        if (string.IsNullOrWhiteSpace(physicalType))
        {
            throw new InvalidOperationException("Physical schema type is empty.");
        }
        string normalized = Regex.Replace(physicalType.Trim().ToLowerInvariant(), @"\s+", " ");
        normalized = Regex.Replace(normalized, @"\s*\(\s*", "(");
        normalized = Regex.Replace(normalized, @"\s*,\s*", ",");
        normalized = Regex.Replace(normalized, @"\s*\)", ")");
        return normalized;
    }

    public static string ToPhysical(
        SchemaProviderKind provider,
        string semanticType,
        int? maxLength,
        string? declaredPhysicalType = null)
        => (provider, semanticType) switch
        {
            (SchemaProviderKind.PostgreSql, "int16-array" or "uuid-array" or "string-array")
                => ProjectPostgresArray(semanticType, maxLength, declaredPhysicalType),
            (_, _) when semanticType.EndsWith("-array", StringComparison.Ordinal)
                => throw new InvalidOperationException($"Unsupported {provider} physical projection for {semanticType}."),
            (SchemaProviderKind.PostgreSql, _) when declaredPhysicalType is not null
                && (declaredPhysicalType.Contains('[') || declaredPhysicalType.Contains(']'))
                => throw new InvalidOperationException("PostgreSQL array physical type requires its exact array semantic type."),
            (SchemaProviderKind.PostgreSql, _) when declaredPhysicalType is not null
                => NormalizePhysical(declaredPhysicalType),
            (SchemaProviderKind.PostgreSql, "string") => maxLength is int length ? $"character varying({length})" : "text",
            (SchemaProviderKind.MySql, "string") => maxLength is int length ? $"varchar({length})" : "longtext",
            (SchemaProviderKind.Sqlite, "string") => "TEXT",
            (SchemaProviderKind.PostgreSql, "int16") => "smallint",
            (SchemaProviderKind.MySql, "int16") => "smallint",
            (SchemaProviderKind.Sqlite, "int16") => "INTEGER",
            (SchemaProviderKind.PostgreSql, "int32") => "integer",
            (SchemaProviderKind.MySql, "int32") => "int",
            (SchemaProviderKind.Sqlite, "int32") => "INTEGER",
            (SchemaProviderKind.PostgreSql, "int64") => "bigint",
            (SchemaProviderKind.MySql, "int64") => "bigint",
            (SchemaProviderKind.Sqlite, "int64") => "INTEGER",
            (SchemaProviderKind.PostgreSql, "boolean") => "boolean",
            (SchemaProviderKind.MySql, "boolean") => "tinyint(1)",
            (SchemaProviderKind.Sqlite, "boolean") => "INTEGER",
            (SchemaProviderKind.PostgreSql, "timestamp") => "timestamp without time zone",
            (SchemaProviderKind.MySql, "timestamp") => "datetime(6)",
            (SchemaProviderKind.Sqlite, "timestamp") => "TEXT",
            (SchemaProviderKind.PostgreSql, "timestamp-with-offset") => "timestamp with time zone",
            (SchemaProviderKind.MySql, "timestamp-with-offset") => "datetime(6)",
            (SchemaProviderKind.Sqlite, "timestamp-with-offset") => "TEXT",
            (SchemaProviderKind.PostgreSql, "date") => "date",
            (SchemaProviderKind.MySql, "date") => "date",
            (SchemaProviderKind.Sqlite, "date") => "TEXT",
            (SchemaProviderKind.PostgreSql, "time") => "time without time zone",
            (SchemaProviderKind.MySql, "time") => "time(6)",
            (SchemaProviderKind.Sqlite, "time") => "TEXT",
            (SchemaProviderKind.PostgreSql, "uuid") => "uuid",
            (SchemaProviderKind.MySql, "uuid") => "char(36)",
            (SchemaProviderKind.Sqlite, "uuid") => "TEXT",
            (SchemaProviderKind.PostgreSql, "bytes") => "bytea",
            (SchemaProviderKind.MySql, "bytes") => "longblob",
            (SchemaProviderKind.Sqlite, "bytes") => "BLOB",
            (SchemaProviderKind.PostgreSql, "json") => "jsonb",
            (SchemaProviderKind.MySql, "json") => "json",
            (SchemaProviderKind.Sqlite, "json") => "TEXT",
            (SchemaProviderKind.PostgreSql, "decimal") => "numeric",
            (SchemaProviderKind.MySql, "decimal") => "decimal",
            (SchemaProviderKind.Sqlite, "decimal") => "NUMERIC",
            (SchemaProviderKind.PostgreSql, "single") => "real",
            (SchemaProviderKind.MySql, "single") => "float",
            (SchemaProviderKind.Sqlite, "single") => "REAL",
            (SchemaProviderKind.PostgreSql, "double") => "double precision",
            (SchemaProviderKind.MySql, "double") => "double",
            (SchemaProviderKind.Sqlite, "double") => "REAL",
            _ => throw new InvalidOperationException($"Unsupported {provider} physical projection for {semanticType}.")
        };

    public static string ToCollation(SchemaProviderKind provider, string semanticType)
        => provider == SchemaProviderKind.PostgreSql && semanticType is "string" or "string-array"
            ? "default"
            : "n/a";

    private static string ProjectPostgresArray(string semanticType, int? maxLength, string? declaredPhysicalType)
    {
        string physical = semanticType switch
        {
            "int16-array" => "smallint[]",
            "uuid-array" => "uuid[]",
            "string-array" => "text[]",
            _ => throw new InvalidOperationException("Unsupported PostgreSQL array semantic type.")
        };
        if (maxLength is not null || declaredPhysicalType is not null && NormalizePhysical(declaredPhysicalType) != physical)
        {
            throw new InvalidOperationException("PostgreSQL array physical and semantic type binding is inconsistent.");
        }
        return physical;
    }
}
