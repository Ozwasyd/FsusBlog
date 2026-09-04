using System.ComponentModel.DataAnnotations.Schema;
using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.SchemaMigration;

public enum SchemaProviderKind
{
    Semantic,
    PostgreSql,
    MySql,
    Sqlite
}

public sealed record CurrentSchemaIdentity(
    string ModelVersion,
    string ExtractorVersion,
    string GeneratorVersion,
    string SourceDigest,
    string ContentDigest);

public sealed record SchemaOwnerModel(string Owner, string SourceRange);

public sealed record SchemaConstraintModel(
    string Name,
    string Kind,
    IReadOnlyList<string> Columns,
    string? ReferencedTable = null,
    IReadOnlyList<string>? ReferencedColumns = null,
    string? Expression = null,
    bool IsDeferrable = false,
    bool IsInitiallyDeferred = false,
    bool IsValidated = true,
    string? ForeignKeyUpdateAction = null,
    string? ForeignKeyDeleteAction = null,
    string? ForeignKeyMatchType = null,
    string? ReferencedSchema = null);

public sealed record SchemaIndexKeyModel(
    string Column,
    string Direction,
    string NullPlacement,
    string OperatorClass,
    string Collation);

public sealed record SchemaIndexModel(
    string Name,
    bool IsUnique,
    IReadOnlyList<SchemaIndexKeyModel> Keys,
    IReadOnlyList<string> IncludedColumns,
    string AccessMethod,
    string? Predicate,
    bool NullsNotDistinct);

public sealed record SchemaOwnedSequenceModel(
    string Schema,
    string Name,
    string OwnedTable,
    string OwnedColumn,
    string DataType,
    long StartValue,
    long IncrementBy,
    long MinValue,
    long MaxValue,
    long CacheSize,
    bool IsCyclic);

[AttributeUsage(AttributeTargets.Class, AllowMultiple = true, Inherited = false)]
public sealed class CurrentSchemaConstraintAttribute(
    string name,
    string kind,
    params string[] columns) : Attribute
{
    public string Name { get; } = name;
    public string Kind { get; } = kind;
    public IReadOnlyList<string> Columns { get; } = columns;
    public string? ReferencedTable
    {
        get; init;
    }
    public string[]? ReferencedColumns
    {
        get; init;
    }
    public string? Expression
    {
        get; init;
    }
}

public sealed record SchemaColumnModel(
    string Name,
    bool IsNullable,
    bool IsPrimaryKey,
    bool IsIdentity,
    int? MaxLength,
    string DataType,
    string? DefaultValue = null,
    string? Conversion = null,
    string? ComputedExpression = null,
    string? PhysicalType = null,
    SchemaOwnerModel? Owner = null,
    string Collation = "n/a",
    string GenerationKind = "none",
    SchemaOwnedSequenceModel? OwnedSequence = null);

public sealed class SchemaTableModel(
    string name,
    Dictionary<string, SchemaColumnModel> columns,
    IEnumerable<string> indexes,
    IReadOnlyDictionary<string, SchemaIndexModel>? indexDefinitions = null,
    IReadOnlyDictionary<string, SchemaConstraintModel>? constraints = null,
    SchemaOwnerModel? owner = null)
{
    public string Name { get; } = name;
    public Dictionary<string, SchemaColumnModel> Columns { get; } = columns;
    public HashSet<string> Indexes { get; } = [.. indexes];
    public IReadOnlyDictionary<string, SchemaIndexModel> IndexDefinitions
    {
        get;
    } =
        indexDefinitions ?? new Dictionary<string, SchemaIndexModel>(StringComparer.Ordinal);
    public IReadOnlyDictionary<string, SchemaConstraintModel> Constraints
    {
        get;
    } =
        constraints ?? new Dictionary<string, SchemaConstraintModel>(StringComparer.Ordinal);
    public SchemaOwnerModel? Owner { get; } = owner;
}

public sealed class SchemaModelSnapshot(
    IReadOnlyDictionary<string, SchemaTableModel> tables,
    CurrentSchemaIdentity? identity = null,
    SchemaProviderKind provider = SchemaProviderKind.Semantic)
{
    public IReadOnlyDictionary<string, SchemaTableModel> Tables { get; } = tables;
    public CurrentSchemaIdentity? Identity { get; } = identity;
    public SchemaProviderKind Provider { get; } = provider;
}

public sealed record CurrentSchemaCanonicalModel(
    SchemaModelSnapshot SemanticSchema,
    CurrentSchemaIdentity Identity);

public sealed record CurrentSchemaProjection(
    SchemaModelSnapshot Schema,
    CurrentSchemaIdentity Identity);

public static class CurrentSchemaCanonicalAuthority
{
    public const string ModelVersion = "fsusblog.current-schema.v2";
    public const string ExtractorVersion = "fsusblog.current-schema-reflection.v2";
    public const string GeneratorVersion = "fsusblog.current-schema-projection.v2";

    private static readonly NullabilityInfoContext s_nullabilityContext = new();

    public static CurrentSchemaCanonicalModel Extract(IReadOnlyList<Type> entityTypes)
    {
        ArgumentNullException.ThrowIfNull(entityTypes);
        if (entityTypes.Count == 0)
        {
            throw new InvalidOperationException("Current schema entity set is empty.");
        }

        Type[] orderedTypes = entityTypes
            .OrderBy(static type => type.FullName, StringComparer.Ordinal)
            .ToArray();
        if (orderedTypes.Distinct().Count() != orderedTypes.Length)
        {
            throw new InvalidOperationException("Current schema entity set contains a duplicate owner.");
        }

        var tables = new Dictionary<string, SchemaTableModel>(StringComparer.Ordinal);
        var sourceParts = new List<string>();
        foreach (Type entityType in orderedTypes)
        {
            SugarTable tableAttribute = entityType.GetCustomAttribute<SugarTable>(inherit: false)
                ?? throw new InvalidOperationException($"Type {entityType.FullName} is missing SugarTable.");
            string tableName = NormalizeIdentifier(tableAttribute.TableName);
            if (tableName.Length == 0)
            {
                throw new InvalidOperationException($"Type {entityType.FullName} has an empty table name.");
            }
            if (tables.ContainsKey(tableName))
            {
                throw new InvalidOperationException($"Duplicate current schema table owner: {tableName} ({entityType.FullName}).");
            }

            SchemaOwnerModel tableOwner = Owner(entityType);
            var columns = new Dictionary<string, SchemaColumnModel>(StringComparer.Ordinal);
            var propertyColumns = new Dictionary<string, string>(StringComparer.Ordinal);
            PropertyInfo[] properties = entityType
                .GetProperties(BindingFlags.Public | BindingFlags.Instance)
                .OrderBy(static property => InheritanceDepth(property.DeclaringType))
                .ThenBy(static property => property.MetadataToken)
                .ToArray();
            foreach (PropertyInfo property in properties)
            {
                SugarColumn? columnAttribute = property.GetCustomAttribute<SugarColumn>(inherit: true);
                if (columnAttribute?.IsIgnore == true
                    || property.GetCustomAttribute<NotMappedAttribute>(inherit: true) is not null
                    || property.GetCustomAttribute<Navigate>(inherit: true) is not null)
                {
                    continue;
                }

                string columnName = NormalizeIdentifier(
                    string.IsNullOrWhiteSpace(columnAttribute?.ColumnName)
                        ? property.Name
                        : columnAttribute.ColumnName);
                if (columnName.Length == 0)
                {
                    throw new InvalidOperationException($"Mapped property {entityType.FullName}.{property.Name} has an empty column name.");
                }
                if (columns.ContainsKey(columnName))
                {
                    throw new InvalidOperationException($"Duplicate current schema column owner: {tableName}.{columnName}.");
                }

                SchemaColumnModel column = BuildColumnModel(property, columnAttribute, columnName);
                columns.Add(columnName, column);
                propertyColumns[property.Name] = columnName;
                sourceParts.Add(SourceIdentity(entityType, property, columnAttribute, column));
            }

            IReadOnlyDictionary<string, SchemaIndexModel> indexes = ExtractIndexes(entityType, propertyColumns);
            IReadOnlyDictionary<string, SchemaConstraintModel> constraints = ExtractConstraints(
                entityType,
                tableName,
                columns,
                propertyColumns,
                indexes);
            tables.Add(tableName, new SchemaTableModel(
                tableName,
                columns,
                indexes.Keys,
                indexes,
                constraints,
                tableOwner));
            sourceParts.Add($"table|{entityType.AssemblyQualifiedName}|{tableName}");
            sourceParts.AddRange(indexes.Values
                .OrderBy(static index => index.Name, StringComparer.Ordinal)
                .Select(index => $"index|{entityType.AssemblyQualifiedName}|{JsonSerializer.Serialize(index)}"));
            sourceParts.AddRange(constraints.Values
                .OrderBy(static constraint => constraint.Name, StringComparer.Ordinal)
                .Select(constraint => $"constraint|{entityType.AssemblyQualifiedName}|{JsonSerializer.Serialize(constraint)}"));
        }

        string sourceDigest = Sha256(string.Join('\n', sourceParts.Order(StringComparer.Ordinal)));
        string provisionalContentDigest = ComputeContentDigest(tables);
        var identity = new CurrentSchemaIdentity(
            ModelVersion,
            ExtractorVersion,
            GeneratorVersion,
            sourceDigest,
            provisionalContentDigest);
        SchemaModelSnapshot snapshot = Clone(tables, identity, SchemaProviderKind.Semantic);
        return new CurrentSchemaCanonicalModel(snapshot, identity);
    }

    public static CurrentSchemaProjection Generate(CurrentSchemaCanonicalModel canonical)
    {
        ArgumentNullException.ThrowIfNull(canonical);
        VerifyIdentity(canonical.SemanticSchema, canonical.Identity);
        return new CurrentSchemaProjection(
            Clone(canonical.SemanticSchema.Tables, canonical.Identity, SchemaProviderKind.Semantic),
            canonical.Identity);
    }

    public static SchemaModelSnapshot ProjectProvider(
        CurrentSchemaCanonicalModel canonical,
        SchemaProviderKind provider)
    {
        if (provider == SchemaProviderKind.Semantic)
        {
            return Generate(canonical).Schema;
        }

        var tables = canonical.SemanticSchema.Tables.ToDictionary(
            static table => table.Key,
            table => new SchemaTableModel(
                table.Value.Name,
                table.Value.Columns.ToDictionary(
                    static column => column.Key,
                    column => column.Value with
                    {
                        PhysicalType = SchemaPhysicalTypeProjection.ToPhysical(
                            provider,
                            column.Value.DataType,
                            column.Value.MaxLength,
                            column.Value.PhysicalType),
                        Collation = SchemaPhysicalTypeProjection.ToCollation(provider, column.Value.DataType),
                        GenerationKind = ProjectGenerationKind(provider, column.Value),
                        OwnedSequence = ProjectOwnedSequence(provider, table.Key, column.Key, column.Value)
                    },
                    StringComparer.Ordinal),
                table.Value.Indexes,
                table.Value.IndexDefinitions.ToDictionary(static index => index.Key, static index => index.Value, StringComparer.Ordinal),
                table.Value.Constraints.ToDictionary(static constraint => constraint.Key, static constraint => constraint.Value, StringComparer.Ordinal),
                table.Value.Owner),
            StringComparer.Ordinal);
        return new SchemaModelSnapshot(tables, canonical.Identity, provider);
    }

    internal static void VerifyIdentity(SchemaModelSnapshot snapshot, CurrentSchemaIdentity identity)
    {
        if (snapshot.Identity is not null && snapshot.Identity != identity)
        {
            throw new InvalidOperationException("Current schema projection snapshot identity mismatch.");
        }
        if (!string.Equals(identity.ModelVersion, ModelVersion, StringComparison.Ordinal)
            || !string.Equals(identity.ExtractorVersion, ExtractorVersion, StringComparison.Ordinal)
            || !string.Equals(identity.GeneratorVersion, GeneratorVersion, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Current schema projection identity version mismatch.");
        }

        string contentDigest = ComputeContentDigest(snapshot.Tables);
        if (!string.Equals(identity.ContentDigest, contentDigest, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("Current schema projection content digest mismatch.");
        }
    }

    internal static string NormalizeIdentifier(string name)
        => name.Trim().ToLowerInvariant();

    internal static string ComputeContentDigest(IReadOnlyDictionary<string, SchemaTableModel> tables)
    {
        var canonical = tables
            .OrderBy(static table => table.Key, StringComparer.Ordinal)
            .Select(table => new
            {
                name = table.Key,
                owner = table.Value.Owner,
                columns = table.Value.Columns
                    .OrderBy(static column => column.Key, StringComparer.Ordinal)
                    .Select(static column => new
                    {
                        name = column.Key,
                        column.Value.IsNullable,
                        column.Value.IsPrimaryKey,
                        column.Value.IsIdentity,
                        column.Value.MaxLength,
                        column.Value.DataType,
                        column.Value.DefaultValue,
                        column.Value.Conversion,
                        column.Value.ComputedExpression,
                        column.Value.Owner
                    }),
                indexes = table.Value.IndexDefinitions.OrderBy(static index => index.Key, StringComparer.Ordinal),
                constraints = table.Value.Constraints.OrderBy(static constraint => constraint.Key, StringComparer.Ordinal)
            });
        return Sha256(JsonSerializer.Serialize(canonical));
    }

    internal static string ComputeObservationDigest(IReadOnlyDictionary<string, SchemaTableModel> tables)
    {
        var observation = tables
            .OrderBy(static table => table.Key, StringComparer.Ordinal)
            .Select(table => new
            {
                name = table.Key,
                columns = table.Value.Columns
                    .OrderBy(static column => column.Key, StringComparer.Ordinal)
                    .Select(static column => new
                    {
                        name = column.Key,
                        column.Value.DataType,
                        column.Value.PhysicalType,
                        column.Value.Collation,
                        column.Value.GenerationKind,
                        column.Value.OwnedSequence,
                        column.Value.DefaultValue,
                        column.Value.IsNullable,
                        column.Value.IsPrimaryKey,
                        column.Value.IsIdentity,
                        column.Value.MaxLength,
                        column.Value.Conversion,
                        column.Value.ComputedExpression
                    }),
                indexes = table.Value.IndexDefinitions.OrderBy(static index => index.Key, StringComparer.Ordinal),
                constraints = table.Value.Constraints.OrderBy(static constraint => constraint.Key, StringComparer.Ordinal)
            });
        return Sha256(JsonSerializer.Serialize(observation));
    }

    private static SchemaModelSnapshot Clone(
        IReadOnlyDictionary<string, SchemaTableModel> source,
        CurrentSchemaIdentity identity,
        SchemaProviderKind provider)
    {
        var tables = source.ToDictionary(
            static table => table.Key,
            static table => new SchemaTableModel(
                table.Value.Name,
                table.Value.Columns.ToDictionary(static column => column.Key, static column => column.Value, StringComparer.Ordinal),
                table.Value.Indexes,
                table.Value.IndexDefinitions.ToDictionary(static index => index.Key, static index => index.Value, StringComparer.Ordinal),
                table.Value.Constraints.ToDictionary(static constraint => constraint.Key, static constraint => constraint.Value, StringComparer.Ordinal),
                table.Value.Owner),
            StringComparer.Ordinal);
        return new SchemaModelSnapshot(tables, identity, provider);
    }

    private static SchemaColumnModel BuildColumnModel(PropertyInfo property, SugarColumn? attribute, string columnName)
    {
        string conversion = ResolveConversion(attribute);
        string dataType = ResolveSemanticType(property.PropertyType, attribute, conversion);
        return new SchemaColumnModel(
            columnName,
            DetermineNullability(property, attribute),
            attribute?.IsPrimaryKey == true,
            attribute?.IsIdentity == true,
            attribute?.Length > 0 ? attribute.Length : null,
            dataType,
            NormalizeDefault(attribute?.DefaultValue),
            conversion,
            ResolveComputedExpression(attribute),
            PhysicalType: ResolveDeclaredPhysicalType(attribute),
            Owner: Owner(property));
    }

    private static string? ResolveDeclaredPhysicalType(SugarColumn? attribute)
        => string.IsNullOrWhiteSpace(attribute?.ColumnDataType)
            ? null
            : SchemaPhysicalTypeProjection.NormalizePhysical(attribute.ColumnDataType);

    private static bool DetermineNullability(PropertyInfo property, SugarColumn? attribute)
    {
        if (attribute?.IsNullable == true)
        {
            return true;
        }

        Type propertyType = property.PropertyType;
        if (propertyType.IsValueType)
        {
            return Nullable.GetUnderlyingType(propertyType) is not null;
        }

        NullabilityInfo info = s_nullabilityContext.Create(property);
        return info.WriteState != NullabilityState.NotNull;
    }

    private static string ResolveSemanticType(Type declaredType, SugarColumn? attribute, string conversion)
    {
        if (!string.IsNullOrWhiteSpace(attribute?.ColumnDataType))
        {
            string? declaredSemantic = SchemaPhysicalTypeProjection.TryNormalizeDeclaredSemantic(attribute.ColumnDataType);
            if (declaredSemantic is not null)
            {
                return declaredSemantic;
            }
        }
        if (conversion == "json")
        {
            return "json";
        }

        Type type = Nullable.GetUnderlyingType(declaredType) ?? declaredType;
        if (type.IsEnum)
        {
            return "int32";
        }

        return Type.GetTypeCode(type) switch
        {
            TypeCode.Boolean => "boolean",
            TypeCode.Byte => "int16",
            TypeCode.Int16 => "int16",
            TypeCode.Int32 => "int32",
            TypeCode.Int64 => "int64",
            TypeCode.Single => "single",
            TypeCode.Double => "double",
            TypeCode.Decimal => "decimal",
            TypeCode.DateTime => "timestamp",
            TypeCode.String => "string",
            _ when type == typeof(Guid) => "uuid",
            _ when type == typeof(byte[]) => "bytes",
            _ when type == typeof(DateOnly) => "date",
            _ when type == typeof(TimeOnly) => "time",
            _ when type == typeof(DateTimeOffset) => "timestamp-with-offset",
            _ => throw new InvalidOperationException($"Unsupported current schema property type: {type.FullName}.")
        };
    }

    private static string ProjectGenerationKind(SchemaProviderKind provider, SchemaColumnModel column)
        => provider == SchemaProviderKind.PostgreSql && column.IsIdentity
            ? "owned-sequence-default"
            : "none";

    private static SchemaOwnedSequenceModel? ProjectOwnedSequence(
        SchemaProviderKind provider,
        string tableName,
        string columnName,
        SchemaColumnModel column)
    {
        if (provider != SchemaProviderKind.PostgreSql || !column.IsIdentity)
        {
            return null;
        }

        (string sequenceType, long maximum) = column.DataType switch
        {
            "int16" => ("smallint", short.MaxValue),
            "int32" => ("integer", int.MaxValue),
            "int64" => ("bigint", long.MaxValue),
            _ => throw new InvalidOperationException(
                $"PostgreSQL identity column {tableName}.{columnName} has unsupported type {column.DataType}.")
        };
        return new SchemaOwnedSequenceModel(
            "public",
            $"{tableName}_{columnName}_seq",
            tableName,
            columnName,
            sequenceType,
            1,
            1,
            1,
            maximum,
            1,
            false);
    }

    private static string ResolveConversion(SugarColumn? attribute)
    {
        if (attribute?.IsJson == true)
        {
            return "json";
        }
        if (attribute?.SqlParameterDbType is Type converter)
        {
            throw new InvalidOperationException($"Unsupported current schema converter: {converter.FullName}.");
        }
        return "none";
    }

    private static string? ResolveComputedExpression(SugarColumn? attribute)
    {
        if (attribute?.InsertServerTime == true || attribute?.UpdateServerTime == true)
        {
            return $"server-time:{attribute.InsertServerTime}:{attribute.UpdateServerTime}".ToLowerInvariant();
        }
        return null;
    }

    private static IReadOnlyDictionary<string, SchemaIndexModel> ExtractIndexes(
        Type entityType,
        IReadOnlyDictionary<string, string> propertyColumns)
    {
        var indexes = new Dictionary<string, SchemaIndexModel>(StringComparer.Ordinal);
        foreach (CustomAttributeData attribute in entityType.GetCustomAttributesData().Where(static attribute =>
                     string.Equals(attribute.AttributeType.Name, "SugarIndex", StringComparison.Ordinal)
                     || string.Equals(attribute.AttributeType.Name, "SugarIndexAttribute", StringComparison.Ordinal)))
        {
            if (attribute.ConstructorArguments.Count == 0)
            {
                throw new InvalidOperationException($"Index on {entityType.FullName} is missing a name.");
            }
            string name = NormalizeIdentifier(Convert.ToString(attribute.ConstructorArguments[0].Value) ?? string.Empty);
            if (name.Length == 0 || indexes.ContainsKey(name))
            {
                throw new InvalidOperationException($"Duplicate or empty index owner on {entityType.FullName}: {name}.");
            }

            CustomAttributeTypedArgument[] arguments = attribute.ConstructorArguments.Skip(1).ToArray();
            bool isUnique = false;
            if (arguments.Length > 0 && arguments[^1].ArgumentType == typeof(bool))
            {
                isUnique = Convert.ToBoolean(arguments[^1].Value);
                arguments = arguments[..^1];
            }
            if (arguments.Length == 0 || arguments.Length % 2 != 0)
            {
                throw new InvalidOperationException(
                    $"Index {name} on {entityType.FullName} must declare exact property/direction pairs followed by at most one uniqueness flag.");
            }

            var keys = new List<SchemaIndexKeyModel>(arguments.Length / 2);
            for (int argumentIndex = 0; argumentIndex < arguments.Length; argumentIndex += 2)
            {
                CustomAttributeTypedArgument propertyArgument = arguments[argumentIndex];
                CustomAttributeTypedArgument directionArgument = arguments[argumentIndex + 1];
                if (propertyArgument.ArgumentType != typeof(string)
                    || directionArgument.ArgumentType != typeof(OrderByType))
                {
                    throw new InvalidOperationException(
                        $"Index {name} on {entityType.FullName} has a non-canonical property/direction declaration.");
                }

                string propertyName = Convert.ToString(propertyArgument.Value) ?? string.Empty;
                string column = propertyColumns.TryGetValue(propertyName, out string? mappedColumn)
                    ? mappedColumn
                    : throw new InvalidOperationException(
                        $"Index {name} references unknown or ignored property {entityType.FullName}.{propertyName}.");
                OrderByType directionValue = (OrderByType)Convert.ToInt32(directionArgument.Value);
                string direction = directionValue switch
                {
                    OrderByType.Asc => "asc",
                    OrderByType.Desc => "desc",
                    _ => throw new InvalidOperationException(
                        $"Index {name} on {entityType.FullName} has unsupported direction {directionValue}.")
                };
                keys.Add(new SchemaIndexKeyModel(
                    column,
                    direction,
                    direction == "asc" ? "last" : "first",
                    "default",
                    "default"));
            }

            indexes.Add(name, new SchemaIndexModel(
                name,
                isUnique,
                keys,
                [],
                "btree",
                null,
                false));
        }
        return indexes;
    }

    private static IReadOnlyDictionary<string, SchemaConstraintModel> ExtractConstraints(
        Type entityType,
        string tableName,
        IReadOnlyDictionary<string, SchemaColumnModel> columns,
        IReadOnlyDictionary<string, string> propertyColumns,
        IReadOnlyDictionary<string, SchemaIndexModel> indexes)
    {
        var constraints = new Dictionary<string, SchemaConstraintModel>(StringComparer.Ordinal);
        string[] primaryKey = columns.Values
            .Where(static column => column.IsPrimaryKey)
            .Select(static column => column.Name)
            .ToArray();
        if (primaryKey.Length > 0)
        {
            string name = $"pk_{tableName}";
            constraints.Add(name, new SchemaConstraintModel(name, "primary-key", primaryKey));
        }
        foreach (SchemaIndexModel index in indexes.Values.Where(static index => index.IsUnique))
        {
            constraints.Add(index.Name, new SchemaConstraintModel(
                index.Name,
                "unique",
                index.Keys.Select(static key => key.Column).ToArray()));
        }
        foreach (CurrentSchemaConstraintAttribute attribute in entityType.GetCustomAttributes<CurrentSchemaConstraintAttribute>(inherit: false))
        {
            string name = NormalizeIdentifier(attribute.Name);
            string kind = attribute.Kind.Trim().ToLowerInvariant();
            if (name.Length == 0 || constraints.ContainsKey(name))
            {
                throw new InvalidOperationException($"Duplicate or empty constraint owner on {entityType.FullName}: {name}.");
            }
            if (kind is not ("foreign-key" or "check"))
            {
                throw new InvalidOperationException($"Unsupported current schema constraint kind: {attribute.Kind}.");
            }
            string[] constraintColumns = attribute.Columns
                .Select(column => propertyColumns.TryGetValue(column, out string? mapped) ? mapped : NormalizeIdentifier(column))
                .ToArray();
            if (constraintColumns.Length == 0 || constraintColumns.Any(column => !columns.ContainsKey(column)))
            {
                throw new InvalidOperationException($"Constraint {name} references an unknown column on {entityType.FullName}.");
            }
            if (kind == "foreign-key"
                && (string.IsNullOrWhiteSpace(attribute.ReferencedTable)
                    || attribute.ReferencedColumns is not { Length: > 0 }))
            {
                throw new InvalidOperationException($"Foreign key {name} is missing its referenced table or columns.");
            }
            if (kind == "check" && string.IsNullOrWhiteSpace(attribute.Expression))
            {
                throw new InvalidOperationException($"Check constraint {name} is missing its expression.");
            }
            constraints.Add(name, new SchemaConstraintModel(
                name,
                kind,
                constraintColumns,
                string.IsNullOrWhiteSpace(attribute.ReferencedTable) ? null : NormalizeIdentifier(attribute.ReferencedTable),
                attribute.ReferencedColumns?.Select(NormalizeIdentifier).ToArray(),
                string.IsNullOrWhiteSpace(attribute.Expression) ? null : attribute.Expression.Trim(),
                ForeignKeyUpdateAction: kind == "foreign-key" ? "no-action" : null,
                ForeignKeyDeleteAction: kind == "foreign-key" ? "no-action" : null,
                ForeignKeyMatchType: kind == "foreign-key" ? "simple" : null,
                ReferencedSchema: kind == "foreign-key" ? "public" : null));
        }
        return constraints;
    }

    private static string? NormalizeDefault(string? value)
        => string.IsNullOrWhiteSpace(value) ? null : value.Trim();

    private static SchemaOwnerModel Owner(MemberInfo member)
    {
        string owner = member switch
        {
            Type type => type.FullName ?? type.Name,
            _ => $"{member.DeclaringType?.FullName}.{member.Name}"
        };
        return new SchemaOwnerModel(owner, owner);
    }

    private static string SourceIdentity(
        Type entityType,
        PropertyInfo property,
        SugarColumn? attribute,
        SchemaColumnModel column)
        => string.Join('|',
            entityType.AssemblyQualifiedName,
            property.DeclaringType?.AssemblyQualifiedName,
            property.Name,
            property.PropertyType.AssemblyQualifiedName,
            attribute?.ColumnName,
            attribute?.ColumnDataType,
            attribute?.Length,
            attribute?.IsNullable,
            attribute?.IsPrimaryKey,
            attribute?.IsIdentity,
            attribute?.IsIgnore,
            attribute?.DefaultValue,
            column.DataType,
            column.Conversion);

    private static string Sha256(string value)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();

    private static int InheritanceDepth(Type? type)
    {
        int depth = 0;
        for (Type? current = type; current is not null; current = current.BaseType)
        {
            depth++;
        }
        return depth;
    }
}

public static class SchemaPhysicalTypeProjection
{
    public static string NormalizeDeclaredSemantic(string declaredType)
        => TryNormalizeDeclaredSemantic(declaredType)
            ?? throw new InvalidOperationException($"Unsupported provider type mapping: {declaredType.Trim().ToLowerInvariant()}.");

    public static string? TryNormalizeDeclaredSemantic(string declaredType)
    {
        string normalized = NormalizePhysical(declaredType);
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
        => provider == SchemaProviderKind.PostgreSql && semanticType == "string"
            ? "default"
            : "n/a";
}

public sealed class RuntimeEntitySchemaAdapter
{
    public CurrentSchemaCanonicalModel Observe(IReadOnlyList<Type> entityTypes)
        => CurrentSchemaCanonicalAuthority.Extract(entityTypes);
}

public sealed class GeneratedCurrentSchemaProjectionAdapter
{
    public CurrentSchemaProjection Observe(CurrentSchemaCanonicalModel canonical)
        => CurrentSchemaCanonicalAuthority.Generate(canonical);
}

public sealed class MigrationTargetSchemaAdapter
{
    public SchemaModelSnapshot Observe(CurrentSchemaCanonicalModel canonical)
        => CurrentSchemaCanonicalAuthority.Generate(canonical).Schema;
}

public static class CurrentSchemaIndependentVerifier
{
    public static void Verify(
        CurrentSchemaCanonicalModel canonical,
        RuntimeEntitySchemaAdapter runtimeAdapter,
        GeneratedCurrentSchemaProjectionAdapter generatedAdapter,
        MigrationTargetSchemaAdapter migrationTargetAdapter,
        IReadOnlyList<Type> entityTypes)
    {
        CurrentSchemaCanonicalModel runtime = runtimeAdapter.Observe(entityTypes);
        CurrentSchemaProjection generated = generatedAdapter.Observe(canonical);
        SchemaModelSnapshot migrationTarget = migrationTargetAdapter.Observe(canonical);
        CurrentSchemaCanonicalAuthority.VerifyIdentity(runtime.SemanticSchema, runtime.Identity);
        CurrentSchemaCanonicalAuthority.VerifyIdentity(generated.Schema, generated.Identity);
        CurrentSchemaCanonicalAuthority.VerifyIdentity(migrationTarget, canonical.Identity);
        if (runtime.Identity != canonical.Identity
            || generated.Identity != canonical.Identity
            || migrationTarget.Identity != canonical.Identity)
        {
            throw new InvalidOperationException("Current schema adapters do not bind the independently recomputed canonical identity.");
        }

        var errors = new List<string>();
        errors.AddRange(SchemaModelComparer.Compare(canonical.SemanticSchema, runtime.SemanticSchema));
        errors.AddRange(SchemaModelComparer.Compare(canonical.SemanticSchema, generated.Schema));
        errors.AddRange(SchemaModelComparer.Compare(canonical.SemanticSchema, migrationTarget));
        if (errors.Count > 0)
        {
            throw new InvalidOperationException($"Current schema adapter equivalence failed:{Environment.NewLine}- {string.Join($"{Environment.NewLine}- ", errors)}");
        }
    }
}

public static class SchemaModelComparer
{
    public static IReadOnlyList<string> Compare(
        SchemaModelSnapshot expected,
        SchemaModelSnapshot actual,
        IReadOnlyCollection<string>? allowedExtraTables = null,
        IReadOnlySet<string>? allowedExtraLinks = null,
        IReadOnlyCollection<string>? requiredExtraTables = null)
    {
        var errors = new List<string>();
        foreach ((string tableName, SchemaTableModel expectedTable) in expected.Tables.OrderBy(static table => table.Key, StringComparer.Ordinal))
        {
            if (!actual.Tables.TryGetValue(tableName, out SchemaTableModel? actualTable))
            {
                errors.Add($"missing table {tableName} owner={Describe(expectedTable.Owner)}");
                continue;
            }
            CompareTable(
                expectedTable,
                actualTable,
                expected.Provider == SchemaProviderKind.PostgreSql,
                allowedExtraLinks,
                errors);
        }

        HashSet<string> allowed = allowedExtraTables?.Select(CurrentSchemaCanonicalAuthority.NormalizeIdentifier).ToHashSet(StringComparer.Ordinal)
            ?? [];
        IEnumerable<string> requiredNames = requiredExtraTables is null
            ? []
            : requiredExtraTables
                .Select(CurrentSchemaCanonicalAuthority.NormalizeIdentifier)
                .Distinct(StringComparer.Ordinal)
                .Order(StringComparer.Ordinal);
        foreach (string tableName in requiredNames)
        {
            allowed.Add(tableName);
            if (expected.Tables.ContainsKey(tableName))
            {
                continue;
            }
            if (!actual.Tables.ContainsKey(tableName))
            {
                errors.Add($"missing required extra table {tableName}");
            }
        }
        foreach (string tableName in actual.Tables.Keys.Except(expected.Tables.Keys, StringComparer.Ordinal).Except(allowed, StringComparer.Ordinal).Order(StringComparer.Ordinal))
        {
            errors.Add($"extra table {tableName} owner={Describe(actual.Tables[tableName].Owner)}");
        }
        return errors;
    }

    private static void CompareTable(
        SchemaTableModel expected,
        SchemaTableModel actual,
        bool requireExactPostgresPhysicalSemantics,
        IReadOnlySet<string>? allowedExtraLinks,
        List<string> errors)
    {
        foreach ((string columnName, SchemaColumnModel expectedColumn) in expected.Columns.OrderBy(static column => column.Key, StringComparer.Ordinal))
        {
            if (!actual.Columns.TryGetValue(columnName, out SchemaColumnModel? actualColumn))
            {
                errors.Add($"missing column {expected.Name}.{columnName} owner={Describe(expectedColumn.Owner)}");
                continue;
            }
            CompareField(
                expected.Name,
                expectedColumn,
                actualColumn,
                requireExactPostgresPhysicalSemantics,
                errors);
        }
        foreach (string columnName in actual.Columns.Keys.Except(expected.Columns.Keys, StringComparer.Ordinal).Order(StringComparer.Ordinal))
        {
            errors.Add($"extra column {expected.Name}.{columnName} owner={Describe(actual.Columns[columnName].Owner)}");
        }
        foreach (string indexName in expected.Indexes.Except(actual.Indexes, StringComparer.Ordinal).Order(StringComparer.Ordinal))
        {
            errors.Add($"missing index {expected.Name}.{indexName} owner={Describe(expected.Owner)}");
        }
        foreach (string indexName in actual.Indexes.Except(expected.Indexes, StringComparer.Ordinal).Order(StringComparer.Ordinal))
        {
            if (allowedExtraLinks?.Contains(indexName) == true)
            {
                continue;
            }
            errors.Add($"extra index {expected.Name}.{indexName} owner={Describe(actual.Owner)}");
        }
        foreach (string indexName in expected.IndexDefinitions.Keys.Intersect(actual.IndexDefinitions.Keys, StringComparer.Ordinal))
        {
            SchemaIndexModel expectedIndex = expected.IndexDefinitions[indexName];
            SchemaIndexModel actualIndex = actual.IndexDefinitions[indexName];
            if (expectedIndex.Name != actualIndex.Name
                || expectedIndex.IsUnique != actualIndex.IsUnique
                || !expectedIndex.Keys.SequenceEqual(actualIndex.Keys)
                || !expectedIndex.IncludedColumns.SequenceEqual(actualIndex.IncludedColumns, StringComparer.Ordinal)
                || expectedIndex.AccessMethod != actualIndex.AccessMethod
                || expectedIndex.Predicate != actualIndex.Predicate
                || expectedIndex.NullsNotDistinct != actualIndex.NullsNotDistinct)
            {
                errors.Add($"index mismatch {expected.Name}.{indexName} owner={Describe(expected.Owner)}");
            }
        }
        foreach (string constraintName in expected.Constraints.Keys.Except(actual.Constraints.Keys, StringComparer.Ordinal).Order(StringComparer.Ordinal))
        {
            errors.Add($"missing constraint {expected.Name}.{constraintName} owner={Describe(expected.Owner)}");
        }
        foreach (string constraintName in actual.Constraints.Keys.Except(expected.Constraints.Keys, StringComparer.Ordinal).Order(StringComparer.Ordinal))
        {
            if (allowedExtraLinks?.Contains(constraintName) == true)
            {
                continue;
            }
            errors.Add($"extra constraint {expected.Name}.{constraintName} owner={Describe(actual.Owner)}");
        }
        foreach (string constraintName in expected.Constraints.Keys.Intersect(actual.Constraints.Keys, StringComparer.Ordinal))
        {
            SchemaConstraintModel expectedConstraint = expected.Constraints[constraintName];
            SchemaConstraintModel actualConstraint = actual.Constraints[constraintName];
            if (expectedConstraint.Name != actualConstraint.Name
                || expectedConstraint.Kind != actualConstraint.Kind
                || !expectedConstraint.Columns.SequenceEqual(actualConstraint.Columns, StringComparer.Ordinal)
                || expectedConstraint.ReferencedTable != actualConstraint.ReferencedTable
                || !(expectedConstraint.ReferencedColumns ?? []).SequenceEqual(
                    actualConstraint.ReferencedColumns ?? [],
                    StringComparer.Ordinal)
                || expectedConstraint.Expression != actualConstraint.Expression
                || expectedConstraint.IsDeferrable != actualConstraint.IsDeferrable
                || expectedConstraint.IsInitiallyDeferred != actualConstraint.IsInitiallyDeferred
                || expectedConstraint.IsValidated != actualConstraint.IsValidated
                || expectedConstraint.ForeignKeyUpdateAction != actualConstraint.ForeignKeyUpdateAction
                || expectedConstraint.ForeignKeyDeleteAction != actualConstraint.ForeignKeyDeleteAction
                || expectedConstraint.ForeignKeyMatchType != actualConstraint.ForeignKeyMatchType
                || expectedConstraint.ReferencedSchema != actualConstraint.ReferencedSchema)
            {
                errors.Add($"constraint mismatch {expected.Name}.{constraintName} owner={Describe(expected.Owner)}");
            }
        }
    }

    private static void CompareField(
        string table,
        SchemaColumnModel expected,
        SchemaColumnModel actual,
        bool requireExactPostgresPhysicalSemantics,
        List<string> errors)
    {
        void Difference(string field, object? expectedValue, object? actualValue)
            => errors.Add($"{field} mismatch {table}.{expected.Name} expected={expectedValue ?? "null"} actual={actualValue ?? "null"} owner={Describe(expected.Owner)}");

        if (expected.DataType != actual.DataType)
            Difference("type", expected.DataType, actual.DataType);
        if (expected.IsNullable != actual.IsNullable)
            Difference("nullable", expected.IsNullable, actual.IsNullable);
        if (expected.IsPrimaryKey != actual.IsPrimaryKey)
            Difference("primary-key", expected.IsPrimaryKey, actual.IsPrimaryKey);
        if (expected.IsIdentity != actual.IsIdentity)
            Difference("identity", expected.IsIdentity, actual.IsIdentity);
        if (expected.MaxLength != actual.MaxLength)
            Difference("length", expected.MaxLength, actual.MaxLength);
        if (expected.DefaultValue != actual.DefaultValue)
            Difference("default", expected.DefaultValue, actual.DefaultValue);
        if (expected.Conversion != actual.Conversion)
            Difference("conversion", expected.Conversion, actual.Conversion);
        if (expected.ComputedExpression != actual.ComputedExpression)
            Difference("computed", expected.ComputedExpression, actual.ComputedExpression);
        if (requireExactPostgresPhysicalSemantics)
        {
            if (expected.PhysicalType != actual.PhysicalType)
                Difference("physical-type", expected.PhysicalType, actual.PhysicalType);
            if (expected.Collation != actual.Collation)
                Difference("collation", expected.Collation, actual.Collation);
            if (expected.GenerationKind != actual.GenerationKind)
                Difference("generation", expected.GenerationKind, actual.GenerationKind);
            if (expected.OwnedSequence != actual.OwnedSequence)
                Difference("owned-sequence", expected.OwnedSequence, actual.OwnedSequence);
        }
    }

    private static string Describe(SchemaOwnerModel? owner)
        => owner is null ? "unknown" : $"{owner.Owner}@{owner.SourceRange}";
}

public sealed record CurrentSchemaReadinessBenchmarkReceipt(
    CurrentSchemaIdentity Identity,
    int WarmupCount,
    IReadOnlyList<long> SampleNanoseconds,
    string BaseContentDigest,
    string CandidateContentDigest);

public static class CurrentSchemaReadinessComparison
{
    public static CurrentSchemaReadinessBenchmarkReceipt Measure(
        CurrentSchemaCanonicalModel sealedCanonical,
        Func<CurrentSchemaCanonicalModel, SchemaModelSnapshot> baseAdapter,
        Func<CurrentSchemaCanonicalModel, SchemaModelSnapshot> candidateAdapter,
        int warmupCount = 2,
        int sampleCount = 5)
    {
        if (warmupCount < 1 || sampleCount < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(sampleCount));
        }

        CurrentSchemaCanonicalAuthority.VerifyIdentity(sealedCanonical.SemanticSchema, sealedCanonical.Identity);
        for (int i = 0; i < warmupCount; i++)
        {
            Compare(baseAdapter(sealedCanonical), candidateAdapter(sealedCanonical));
        }

        var samples = new long[sampleCount];
        string baseDigest = string.Empty;
        string candidateDigest = string.Empty;
        for (int i = 0; i < sampleCount; i++)
        {
            long started = Stopwatch.GetTimestamp();
            (baseDigest, candidateDigest) = Compare(baseAdapter(sealedCanonical), candidateAdapter(sealedCanonical));
            samples[i] = (long)(Stopwatch.GetElapsedTime(started).TotalNanoseconds);
        }

        return new CurrentSchemaReadinessBenchmarkReceipt(
            sealedCanonical.Identity,
            warmupCount,
            samples,
            baseDigest,
            candidateDigest);
    }

    private static (string BaseDigest, string CandidateDigest) Compare(
        SchemaModelSnapshot baseSnapshot,
        SchemaModelSnapshot candidateSnapshot)
    {
        if (baseSnapshot.Identity is null || candidateSnapshot.Identity is null
            || baseSnapshot.Identity != candidateSnapshot.Identity)
        {
            throw new InvalidOperationException("Base and candidate adapters do not bind the same current schema identity.");
        }
        IReadOnlyList<string> errors = SchemaModelComparer.Compare(baseSnapshot, candidateSnapshot);
        if (errors.Count > 0)
        {
            throw new InvalidOperationException($"Base and candidate adapters do not describe the same current schema:{Environment.NewLine}- {string.Join($"{Environment.NewLine}- ", errors)}");
        }
        return (baseSnapshot.Identity.ContentDigest, candidateSnapshot.Identity.ContentDigest);
    }
}
