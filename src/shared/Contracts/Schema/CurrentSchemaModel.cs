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
