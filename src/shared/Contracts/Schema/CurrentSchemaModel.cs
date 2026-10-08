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

public sealed record SchemaIndexKeyModel(
    string Column,
    string Direction,
    string NullPlacement,
    string OperatorClass,
    string Collation)
{
    /// <summary>Complete neutral expression facts; expression keys have an empty Column, never a fabricated column name.</summary>
    [System.Text.Json.Serialization.JsonIgnore(Condition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull)]
    public SchemaExpressionNode? Expression
    {
        get; init;
    }

    /// <summary>Required for physical MySQL comparison; null is unobserved, not a complete key.</summary>
    public SchemaMySqlIndexKeyPhysicalFacts? MySqlPhysical
    {
        get; init;
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
    public SchemaMySqlIndexPhysicalFacts? MySqlPhysical
    {
        get; init;
    }
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
    public SchemaMySqlColumnPhysicalFacts? MySqlPhysical
    {
        get; init;
    }
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
    public SchemaMySqlTablePhysicalFacts? MySqlPhysical
    {
        get; init;
    }
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
