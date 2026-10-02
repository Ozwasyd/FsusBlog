using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace FsusBlog.Contracts.Schema;

public static class CurrentSchemaCanonicalAuthority
{
    public const string ModelVersion = "fsusblog.current-schema.v2";
    public const string ExtractorVersion = "fsusblog.current-schema-reflection.v2";
    public const string GeneratorVersion = "fsusblog.current-schema-projection.v2";

    /// <summary>Seals facts supplied by the single current extractor, not by migration descriptors.</summary>
    /// <param name="tables">The current extractor's complete entity descriptions.</param>
    /// <param name="sourceDigest">The extractor's lowercase SHA-256 source identity.</param>
    /// <returns>A copied semantic snapshot with its recomputed content identity, not an execution grant.</returns>
    public static CurrentSchemaCanonicalModel Create(IReadOnlyDictionary<string, SchemaTableModel> tables, string sourceDigest)
    {
        ArgumentNullException.ThrowIfNull(tables);
        if (string.IsNullOrWhiteSpace(sourceDigest) || sourceDigest.Length != 64
            || sourceDigest.Any(static character => character is not (>= '0' and <= '9' or >= 'a' and <= 'f')))
        {
            throw new InvalidOperationException("Current schema source digest is invalid.");
        }
        var identity = new CurrentSchemaIdentity(ModelVersion, ExtractorVersion, GeneratorVersion, sourceDigest, ComputeContentDigest(tables));
        return new CurrentSchemaCanonicalModel(Clone(tables, identity, SchemaProviderKind.Semantic), identity);
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

    public static void VerifyIdentity(SchemaModelSnapshot snapshot, CurrentSchemaIdentity identity)
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

    public static string NormalizeIdentifier(string name)
        => name.Trim().ToLowerInvariant();

    public static string ComputeContentDigest(IReadOnlyDictionary<string, SchemaTableModel> tables)
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

    public static string ComputeObservationDigest(IReadOnlyDictionary<string, SchemaTableModel> tables)
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

    private static string Sha256(string value)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
}
