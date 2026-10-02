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
                        Conversion = ProjectStorageConversion(column.Value),
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

    /// <summary>Projects the original complete owned facts without maintaining another field mapping.</summary>
    /// <param name="input">The complete original entity and recipe input, whose producer ownership is independently verified by the consumer.</param>
    /// <param name="provider">The native provider; a recipe for another provider is not substituted.</param>
    /// <returns>The relational target and the separate effects which native observers/apply postconditions must still verify.</returns>
    public static CurrentSchemaCompletePhysicalProjection ProjectOwnedTarget(CurrentSchemaBootstrapInput input, SchemaProviderKind provider)
    {
        CurrentSchemaIdentity target = CurrentSchemaOwnedTargetProjection.Observe(input);
        if (provider != SchemaProviderKind.PostgreSql || input.RequiredRecipes.Any(reference => reference.Provider != provider))
        {
            throw new InvalidOperationException("current_schema_complete_target_provider_unavailable");
        }
        var semantic = new Dictionary<string, SchemaTableModel>(input.EntityProjection.Schema.Tables, StringComparer.Ordinal);
        foreach (CurrentSchemaRequiredRecipeReference reference in input.RequiredRecipes)
        {
            if (!semantic.TryAdd(reference.TableName, reference.SemanticDescription!.Table))
            {
                throw new InvalidOperationException("current_schema_complete_target_table_overlap");
            }
        }
        SchemaModelSnapshot projected = ProjectProvider(Create(semantic, target.SourceDigest), provider);
        var tables = new Dictionary<string, SchemaTableModel>(projected.Tables, StringComparer.Ordinal);
        foreach (CurrentSchemaRequiredRecipeReference reference in input.RequiredRecipes)
        {
            SchemaTableModel original = reference.SemanticDescription!.Table;
            SchemaTableModel physical = tables[reference.TableName];
            var columns = new Dictionary<string, SchemaColumnModel>(physical.Columns, StringComparer.Ordinal);
            foreach ((string name, SchemaColumnModel column) in original.Columns)
            {
                // Original recipes use BY DEFAULT identity, unlike entity serials.
                columns[name] = columns[name] with { GenerationKind = column.GenerationKind };
            }
            var constraints = new Dictionary<string, SchemaConstraintModel>(StringComparer.Ordinal);
            var indexes = new Dictionary<string, SchemaIndexModel>(physical.IndexDefinitions, StringComparer.Ordinal);
            foreach (SchemaConstraintModel constraint in physical.Constraints.Values)
            {
                string name = constraint.Kind == "primary-key" ? "pk_" + physical.Name : constraint.Name;
                constraints.Add(name, constraint with { Name = name });
                if (constraint.Kind == "unique")
                {
                    indexes.Add(name, ConstraintIndex(name, constraint.Columns));
                }
            }
            tables[reference.TableName] = new SchemaTableModel(physical.Name, columns, indexes.Keys, indexes, constraints, physical.Owner);
        }
        var schemaEffects = new List<CurrentSchemaRecipeOperation>();
        var dataEffects = new List<CurrentSchemaRecipeOperation>();
        foreach (CurrentSchemaRecipeOperation operation in input.RequiredRecipes.SelectMany(static reference => reference.SemanticDescription!.AdditionalOperations))
        {
            if (operation.Kind is CurrentSchemaRecipeOperationKind.CreateSequence
                or CurrentSchemaRecipeOperationKind.DefineImmutableGuard
                or CurrentSchemaRecipeOperationKind.RemoveTrigger
                or CurrentSchemaRecipeOperationKind.CreateImmutableTrigger)
            {
                schemaEffects.Add(operation);
                continue;
            }
            if (operation.Kind == CurrentSchemaRecipeOperationKind.InsertIfAbsent)
            {
                dataEffects.Add(operation);
                continue;
            }
            if (operation.Table is null || !tables.TryGetValue(operation.Table, out SchemaTableModel? table))
            {
                throw new InvalidOperationException("current_schema_complete_target_effect_table_missing");
            }
            var columns = new Dictionary<string, SchemaColumnModel>(table.Columns, StringComparer.Ordinal);
            var constraints = new Dictionary<string, SchemaConstraintModel>(table.Constraints, StringComparer.Ordinal);
            var indexes = new Dictionary<string, SchemaIndexModel>(table.IndexDefinitions, StringComparer.Ordinal);
            switch (operation.Kind)
            {
                case CurrentSchemaRecipeOperationKind.CreateIndex:
                    SchemaIndexModel index = operation.Index ?? throw new InvalidOperationException("current_schema_complete_target_effect_index_missing");
                    if (index.Name != operation.Name || !indexes.TryAdd(index.Name, index))
                    {
                        throw new InvalidOperationException("current_schema_complete_target_effect_index_conflict");
                    }
                    if (index.IsUnique)
                    {
                        constraints.Add(index.Name, new SchemaConstraintModel(index.Name, "unique", index.Keys.Select(static key => key.Column).ToArray()));
                    }
                    break;
                case CurrentSchemaRecipeOperationKind.AddColumnIfAbsent:
                    SchemaColumnModel logicalColumn = operation.Column ?? throw new InvalidOperationException("current_schema_complete_target_effect_column_missing");
                    SchemaColumnModel column = logicalColumn with
                    {
                        Conversion = ProjectStorageConversion(logicalColumn),
                        PhysicalType = SchemaPhysicalTypeProjection.ToPhysical(provider, logicalColumn.DataType, logicalColumn.MaxLength, logicalColumn.PhysicalType),
                        Collation = SchemaPhysicalTypeProjection.ToCollation(provider, logicalColumn.DataType)
                    };
                    if (column.Name != operation.Name || column.IsIdentity)
                    {
                        throw new InvalidOperationException("current_schema_complete_target_effect_column_invalid");
                    }
                    if (columns.TryGetValue(column.Name, out SchemaColumnModel? existing))
                    {
                        if (existing != column)
                        {
                            throw new InvalidOperationException("current_schema_complete_target_effect_column_conflict");
                        }
                    }
                    else
                    {
                        columns.Add(column.Name, column);
                    }
                    break;
                case CurrentSchemaRecipeOperationKind.AddConstraintIfAbsent:
                    SchemaConstraintModel constraint = operation.Constraint ?? throw new InvalidOperationException("current_schema_complete_target_effect_constraint_missing");
                    if (constraint.Name != operation.Name || !constraints.TryAdd(constraint.Name, constraint))
                    {
                        throw new InvalidOperationException("current_schema_complete_target_effect_constraint_conflict");
                    }
                    break;
                default:
                    throw new InvalidOperationException("current_schema_complete_target_effect_unknown");
            }
            tables[table.Name] = new SchemaTableModel(table.Name, columns, indexes.Keys, indexes, constraints, table.Owner);
        }
        return new CurrentSchemaCompletePhysicalProjection(new SchemaModelSnapshot(tables, target, provider),
            schemaEffects.ToArray(), dataEffects.ToArray());
    }

    private static SchemaIndexModel ConstraintIndex(string name, IReadOnlyList<string> columns)
        => new(name, true, columns.Select(static column => new SchemaIndexKeyModel(column, "asc", "last", "default", "default")).ToArray(),
            [], "btree", null, false);

    private static string ProjectStorageConversion(SchemaColumnModel column)
    {
        // Conversion is the compiled CLR/ORM converter, not a database catalog
        // property. Its original value remains in the semantic model, owner input
        // digest and target identity. Physical JSON storage remains independently
        // projected and compared through DataType/PhysicalType and all other facts.
        // An unsupported converter cannot be silently erased by this projection.
        if (column.Conversion is not (null or "none" or "json"))
        {
            throw new InvalidOperationException("current_schema_storage_conversion_unavailable");
        }
        return "none";
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
