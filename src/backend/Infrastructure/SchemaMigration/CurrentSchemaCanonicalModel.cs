using System.ComponentModel.DataAnnotations.Schema;
using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Contracts.Schema;

using SqlSugar;

namespace FsusBlog.Server.Infrastructure.SchemaMigration;

public static class CurrentSchemaEntityExtractor
{
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
        // NullabilityInfoContext caches mutable reflection state and is not
        // shared between concurrent original-owner extractions.
        var nullabilityContext = new NullabilityInfoContext();
        foreach (Type entityType in orderedTypes)
        {
            SugarTable tableAttribute = entityType.GetCustomAttribute<SugarTable>(inherit: false)
                ?? throw new InvalidOperationException($"Type {entityType.FullName} is missing SugarTable.");
            string tableName = CurrentSchemaCanonicalAuthority.NormalizeIdentifier(tableAttribute.TableName);
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

                string columnName = CurrentSchemaCanonicalAuthority.NormalizeIdentifier(
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

                SchemaColumnModel column = BuildColumnModel(property, columnAttribute, columnName, nullabilityContext);
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
        return CurrentSchemaCanonicalAuthority.Create(tables, sourceDigest);
    }

    private static SchemaColumnModel BuildColumnModel(PropertyInfo property, SugarColumn? attribute, string columnName,
        NullabilityInfoContext nullabilityContext)
    {
        string conversion = ResolveConversion(attribute);
        string dataType = ResolveSemanticType(property.PropertyType, attribute, conversion);
        return new SchemaColumnModel(
            columnName,
            DetermineNullability(property, attribute, nullabilityContext),
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

    private static bool DetermineNullability(PropertyInfo property, SugarColumn? attribute, NullabilityInfoContext nullabilityContext)
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

        NullabilityInfo info = nullabilityContext.Create(property);
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
            string name = CurrentSchemaCanonicalAuthority.NormalizeIdentifier(Convert.ToString(attribute.ConstructorArguments[0].Value) ?? string.Empty);
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
            string name = CurrentSchemaCanonicalAuthority.NormalizeIdentifier(attribute.Name);
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
                .Select(column => propertyColumns.TryGetValue(column, out string? mapped) ? mapped : CurrentSchemaCanonicalAuthority.NormalizeIdentifier(column))
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
                string.IsNullOrWhiteSpace(attribute.ReferencedTable) ? null : CurrentSchemaCanonicalAuthority.NormalizeIdentifier(attribute.ReferencedTable),
                attribute.ReferencedColumns?.Select(CurrentSchemaCanonicalAuthority.NormalizeIdentifier).ToArray(),
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

public sealed class RuntimeEntitySchemaAdapter
{
    public CurrentSchemaCanonicalModel Observe(IReadOnlyList<Type> entityTypes)
        => CurrentSchemaEntityExtractor.Extract(entityTypes);
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
