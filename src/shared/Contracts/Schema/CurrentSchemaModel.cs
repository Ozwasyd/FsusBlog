using System.Text.Json.Serialization;

namespace FsusBlog.Contracts.Schema;

/// <summary>Identifies a provider-neutral semantic snapshot or the database provider represented by a physical projection.</summary>
public enum SchemaProviderKind
{
    Semantic,
    PostgreSql,
    MySql,
    Sqlite
}

/// <summary>Binds model, extractor and projection versions to the source digest and canonical schema content digest.</summary>
public sealed record CurrentSchemaIdentity(
    string ModelVersion,
    string ExtractorVersion,
    string GeneratorVersion,
    string SourceDigest,
    string ContentDigest);

/// <summary>Associates a schema fact with its declared source owner and source range for provenance tracking.</summary>
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

/// <summary>Describes a named constraint with ordered columns, optional reference or expression, validation and deferral facts.</summary>
/// <remarks>Foreign-key actions, match type and referenced schema retain the supplied provider facts.</remarks>
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

/// <summary>Describes one ordered index key, including direction, null placement, operator class and collation.</summary>
public sealed record SchemaIndexKeyModel(
    string Column,
    string Direction,
    string NullPlacement,
    string OperatorClass,
    string Collation)
{
    /// <summary>Required for physical MySQL comparison; null is unobserved, not a complete key.</summary>
    public SchemaMySqlIndexKeyPhysicalFacts? MySqlPhysical
    {
        get; init;
    }
}

/// <summary>Describes a named index with ordered keys, included columns, access method, predicate and uniqueness semantics.</summary>
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

/// <summary>Describes a sequence bound to a table column, retaining its type, bounds, increment, cache and cycling configuration.</summary>
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

/// <summary>Declares a named constraint on a current entity class for extraction into the canonical schema model.</summary>
/// <remarks>Multiple declarations are allowed on the same class; declarations are not inherited by derived classes.</remarks>
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

/// <summary>Combines a column's neutral storage and nullability facts with optional defaults, conversion, ownership and physical representation.</summary>
/// <remarks>Generation and owned-sequence facts describe the represented schema; constructing this record performs no database operation.</remarks>
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

/// <summary>Groups a table's columns, index names, index definitions, constraints and optional source ownership.</summary>
/// <remarks>Index names are copied into a set; omitted index definitions and constraints become empty dictionaries.</remarks>
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

/// <summary>Carries a table dictionary with its represented provider and optional current-schema identity.</summary>
/// <remarks>Construction retains the supplied tables and identity without verifying their digest binding.</remarks>
public sealed class SchemaModelSnapshot(
    IReadOnlyDictionary<string, SchemaTableModel> tables,
    CurrentSchemaIdentity? identity = null,
    SchemaProviderKind provider = SchemaProviderKind.Semantic)
{
    public IReadOnlyDictionary<string, SchemaTableModel> Tables { get; } = tables;
    public CurrentSchemaIdentity? Identity { get; } = identity;
    public SchemaProviderKind Provider { get; } = provider;
}

/// <summary>Pairs the current semantic schema with the identity used when verifying and deriving its projections.</summary>
public sealed record CurrentSchemaCanonicalModel(
    SchemaModelSnapshot SemanticSchema,
    CurrentSchemaIdentity Identity);

/// <summary>Carries a schema projection and its current-schema identity for downstream comparison and verification.</summary>
public sealed record CurrentSchemaProjection(
    SchemaModelSnapshot Schema,
    CurrentSchemaIdentity Identity);

/// <summary>Adapts a canonical model to the copied semantic projection produced by <see cref="CurrentSchemaCanonicalAuthority.Generate"/>.</summary>
/// <remarks>The adapter delegates identity verification to the canonical authority and supplies no independent schema facts.</remarks>
public sealed class GeneratedCurrentSchemaProjectionAdapter
{
    public CurrentSchemaProjection Observe(CurrentSchemaCanonicalModel canonical)
        => CurrentSchemaCanonicalAuthority.Generate(canonical);
}

/// <summary>Exposes the canonical authority's verified semantic projection as the schema snapshot consumed by migration planning.</summary>
/// <remarks>This adapter neither observes a database nor authorizes migration execution.</remarks>
public sealed class MigrationTargetSchemaAdapter
{
    public SchemaModelSnapshot Observe(CurrentSchemaCanonicalModel canonical)
        => CurrentSchemaCanonicalAuthority.Generate(canonical).Schema;
}
