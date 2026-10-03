using System.Text.Json.Serialization;

namespace FsusBlog.Contracts.Schema;

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

/// <summary>Exact MySQL partition metadata; null names retain an unpartitioned native row, not a missing observation.</summary>
public sealed record SchemaMySqlPartitionPhysicalFacts(
    [property: JsonRequired] string? Name,
    [property: JsonRequired] string? SubpartitionName,
    [property: JsonRequired] long? Ordinal,
    [property: JsonRequired] long? SubpartitionOrdinal,
    [property: JsonRequired] string? Method,
    [property: JsonRequired] string? SubpartitionMethod,
    [property: JsonRequired] string? Expression,
    [property: JsonRequired] string? SubpartitionExpression,
    [property: JsonRequired] string? Description,
    [property: JsonRequired] string? TablespaceName);

/// <summary>Complete MySQL table representation, supplied independently by an owned compiler or an actual observer.</summary>
/// <remarks>No engine, collation or partition defaults are inferred here. Mutable AUTO_INCREMENT state is not an independent allocator.</remarks>
public sealed record SchemaMySqlTablePhysicalFacts(
    [property: JsonRequired] string TableType,
    [property: JsonRequired] string? Engine,
    [property: JsonRequired] string? RowFormat,
    [property: JsonRequired] string? Collation,
    [property: JsonRequired] string CreateOptions,
    [property: JsonRequired] string Comment,
    [property: JsonRequired] IReadOnlyList<SchemaMySqlPartitionPhysicalFacts> Partitions);

/// <summary>Exact MySQL column attributes beyond the neutral storage type.</summary>
/// <remarks>EXTRA preserves ON UPDATE, invisible, identity and generated/default-generated semantics without parsing provider SQL in Contracts.</remarks>
public sealed record SchemaMySqlColumnPhysicalFacts(
    [property: JsonRequired] string? CharacterSet,
    [property: JsonRequired] string? Collation,
    [property: JsonRequired] string Extra,
    [property: JsonRequired] string GenerationExpression,
    [property: JsonRequired] string Comment,
    [property: JsonRequired] uint? SpatialReferenceSystemId);

/// <summary>Exact MySQL index visibility and native comments, not a customary provider default.</summary>
public sealed record SchemaMySqlIndexPhysicalFacts(
    [property: JsonRequired] bool IsVisible,
    [property: JsonRequired] string Comment,
    [property: JsonRequired] string IndexComment);

/// <summary>Exact MySQL prefix length and functional-key expression; no prefix or expression is silently discarded.</summary>
public sealed record SchemaMySqlIndexKeyPhysicalFacts(
    [property: JsonRequired] long? PrefixLength,
    [property: JsonRequired] string? Expression);

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

/// <summary>Closed identity of an ordinary bound column or an explicitly modelled expression key.</summary>
public enum SchemaIndexKeyKind
{
    Column,
    Expression
}

public sealed record SchemaIndexKeyModel(
    string Column,
    string Direction,
    string NullPlacement,
    string OperatorClass,
    string Collation)
{
    /// <summary>The serialized discriminator is required; expression facts never masquerade as a column name.</summary>
    [JsonRequired]
    public SchemaIndexKeyKind Kind { get; init; } = SchemaIndexKeyKind.Column;

    /// <summary>Complete ordered bound facts for an expression key; absent for an ordinary column.</summary>
    public SchemaExpressionNode? Expression { get; init; }

    /// <summary>Required for physical MySQL comparison; null is unobserved, not a complete key.</summary>
    public SchemaMySqlIndexKeyPhysicalFacts? MySqlPhysical { get; init; }

    /// <summary>Independent parsed trees compare by their complete semantic identity, not list reference equality.</summary>
    public bool Equals(SchemaIndexKeyModel? other)
        => other is not null && Column == other.Column && Direction == other.Direction
            && NullPlacement == other.NullPlacement && OperatorClass == other.OperatorClass
            && Collation == other.Collation && Kind == other.Kind && MySqlPhysical == other.MySqlPhysical
            && (Expression is null ? other.Expression is null
                : other.Expression is not null && SchemaExpressionIdentity.Equal(Expression, other.Expression));

    /// <summary>Matches the complete scalar and ordered-expression identity used by equality.</summary>
    public override int GetHashCode()
        => HashCode.Combine(Column, Direction, NullPlacement, OperatorClass, Collation, Kind,
            MySqlPhysical, Expression is null ? null : SchemaExpressionIdentity.Digest(Expression));
}

/// <summary>Pure closed validation for existing owned index facts; it neither parses SQL nor observes a database.</summary>
public static class SchemaIndexKeyFacts
{
    /// <summary>Requires exact bound columns or complete expression facts in a supported physical domain.</summary>
    public static void Validate(SchemaIndexKeyModel key, IReadOnlyDictionary<string, SchemaColumnModel> columns,
        SchemaProviderKind provider)
    {
        ArgumentNullException.ThrowIfNull(key);
        ArgumentNullException.ThrowIfNull(columns);
        if (key.Direction is not ("asc" or "desc") || key.NullPlacement is not ("first" or "last")
            || string.IsNullOrWhiteSpace(key.OperatorClass) || string.IsNullOrWhiteSpace(key.Collation))
            throw new InvalidOperationException("current_schema_index_key_facts_invalid");
        switch (key.Kind)
        {
            case SchemaIndexKeyKind.Column:
                if (key.Expression is not null || string.IsNullOrEmpty(key.Column) || !columns.ContainsKey(key.Column))
                    throw new InvalidOperationException("current_schema_index_column_binding_invalid");
                break;
            case SchemaIndexKeyKind.Expression:
                if (key.Column != string.Empty || key.Expression is null || key.MySqlPhysical is not null)
                    throw new InvalidOperationException("current_schema_index_expression_binding_invalid");
                if (provider is not (SchemaProviderKind.Semantic or SchemaProviderKind.PostgreSql))
                    throw new InvalidOperationException("current_schema_index_expression_provider_unavailable");
                ValidateExpression(key.Expression, columns);
                break;
            default:
                throw new InvalidOperationException("current_schema_index_key_kind_unavailable");
        }
    }

    /// <summary>Admits only the original greatest-of-bound-timestamps capability, preserving every ordered operand.</summary>
    public static void ValidateExpression(SchemaExpressionNode expression,
        IReadOnlyDictionary<string, SchemaColumnModel> columns)
    {
        ArgumentNullException.ThrowIfNull(expression);
        ArgumentNullException.ThrowIfNull(columns);
        if (expression.Kind != "call" || expression.Value != "greatest"
            || expression.Arguments is null || expression.Arguments.Count < 2)
            throw new InvalidOperationException("current_schema_index_expression_capability_unavailable");
        foreach (SchemaExpressionNode argument in expression.Arguments)
        {
            if (argument is null || argument.Kind != "column" || argument.Arguments is null
                || argument.Arguments.Count != 0 || !columns.TryGetValue(argument.Value, out SchemaColumnModel? column)
                || column.DataType != "timestamp")
                throw new InvalidOperationException("current_schema_index_expression_column_binding_invalid");
        }
    }
}

public sealed record SchemaIndexModel(
    string Name,
    bool IsUnique,
    IReadOnlyList<SchemaIndexKeyModel> Keys,
    IReadOnlyList<string> IncludedColumns,
    string AccessMethod,
    string? Predicate,
    bool NullsNotDistinct)
{
    /// <summary>Required for physical MySQL comparison; no visibility default is selected by the model.</summary>
    public SchemaMySqlIndexPhysicalFacts? MySqlPhysical { get; init; }
}

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
    SchemaOwnedSequenceModel? OwnedSequence = null)
{
    /// <summary>Required for physical MySQL comparison; null charset/collation inside a measured object remain distinct from no observation.</summary>
    public SchemaMySqlColumnPhysicalFacts? MySqlPhysical { get; init; }
}

public sealed class SchemaTableModel(
    string name,
    Dictionary<string, SchemaColumnModel> columns,
    IEnumerable<string> indexes,
    IReadOnlyDictionary<string, SchemaIndexModel>? indexDefinitions = null,
    IReadOnlyDictionary<string, SchemaConstraintModel>? constraints = null,
    SchemaOwnerModel? owner = null)
{
    [System.Text.Json.Serialization.JsonConstructor]
    public SchemaTableModel(
        string name,
        Dictionary<string, SchemaColumnModel> columns,
        HashSet<string> indexes,
        IReadOnlyDictionary<string, SchemaIndexModel> indexDefinitions,
        IReadOnlyDictionary<string, SchemaConstraintModel> constraints,
        SchemaOwnerModel? owner)
        : this(name, columns, (IEnumerable<string>)indexes, indexDefinitions, constraints, owner)
    {
    }

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
    /// <summary>Required for physical MySQL comparison; originates in the same current-owned definition as compiler output.</summary>
    public SchemaMySqlTablePhysicalFacts? MySqlPhysical { get; init; }
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
