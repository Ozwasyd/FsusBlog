using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace FsusBlog.Contracts.Schema;

/// <summary>
/// Seals current extractor facts with versioned digests and derives semantic and provider-specific schema projections.
/// </summary>
/// <remarks>Projection and identity verification do not observe a live database or grant permission to apply a migration.</remarks>
public static class CurrentSchemaCanonicalAuthority
{
    public const string ModelVersion = "fsusblog.current-schema.v4";
    public const string ExtractorVersion = "fsusblog.current-schema-reflection.v2";
    public const string GeneratorVersion = "fsusblog.current-schema-projection.v4";

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
                table.Value.Owner)
            {
                MySqlPhysical = CopyMySqlTableFacts(table.Value.MySqlPhysical)
            },
            StringComparer.Ordinal);
        return new SchemaModelSnapshot(tables, canonical.Identity, provider);
    }

    /// <summary>Projects the original complete owned facts without maintaining another field mapping.</summary>
    /// <param name="input">The complete original entity and recipe input, whose producer ownership is independently verified by the consumer.</param>
    /// <param name="provider">The native provider; only explicitly projected neutral facts may cross the original recipe's provider boundary.</param>
    /// <returns>The relational target and the separate effects which native observers/apply postconditions must still verify.</returns>
    public static CurrentSchemaCompletePhysicalProjection ProjectOwnedTarget(CurrentSchemaBootstrapInput input, SchemaProviderKind provider)
    {
        ArgumentNullException.ThrowIfNull(input);
        return ProjectOwnedTarget(input.EntityProjection, input.RequiredRecipes, provider);
    }

    /// <summary>Projects the same original entity/recipe facts for live read-only comparison, without a fabricated producer.</summary>
    public static CurrentSchemaCompletePhysicalProjection ProjectOwnedTarget(CurrentSchemaProjection entityProjection,
        IReadOnlyList<CurrentSchemaRequiredRecipeReference> requiredRecipes, SchemaProviderKind provider)
    {
        CurrentSchemaIdentity target = CurrentSchemaOwnedTargetProjection.Observe(entityProjection, requiredRecipes);
        if (provider is SchemaProviderKind.MySql or SchemaProviderKind.Sqlite)
        {
            return ProjectPortableOwnedTarget(entityProjection, requiredRecipes, target, provider);
        }
        if (provider != SchemaProviderKind.PostgreSql || requiredRecipes.Any(reference => reference.Provider != provider))
        {
            throw new InvalidOperationException("current_schema_complete_target_provider_unavailable");
        }
        var semantic = new Dictionary<string, SchemaTableModel>(entityProjection.Schema.Tables, StringComparer.Ordinal);
        foreach (CurrentSchemaRequiredRecipeReference reference in requiredRecipes)
        {
            if (!semantic.TryAdd(reference.TableName, reference.SemanticDescription!.Table))
            {
                throw new InvalidOperationException("current_schema_complete_target_table_overlap");
            }
        }
        SchemaModelSnapshot projected = ProjectProvider(Create(semantic, target.SourceDigest), provider);
        var tables = new Dictionary<string, SchemaTableModel>(projected.Tables, StringComparer.Ordinal);
        foreach (CurrentSchemaRequiredRecipeReference reference in requiredRecipes)
        {
            SchemaTableModel original = reference.SemanticDescription!.Table;
            SchemaTableModel physical = tables[reference.TableName];
            var columns = new Dictionary<string, SchemaColumnModel>(physical.Columns, StringComparer.Ordinal);
            foreach ((string name, SchemaColumnModel column) in original.Columns)
            {
                // Original recipes use BY DEFAULT identity, unlike entity serials.
                columns[name] = columns[name] with
                {
                    GenerationKind = column.GenerationKind
                };
            }
            var constraints = new Dictionary<string, SchemaConstraintModel>(StringComparer.Ordinal);
            var indexes = new Dictionary<string, SchemaIndexModel>(physical.IndexDefinitions, StringComparer.Ordinal);
            foreach (SchemaConstraintModel constraint in physical.Constraints.Values)
            {
                string name = constraint.Kind == "primary-key" ? "pk_" + physical.Name : constraint.Name;
                constraints.Add(name, constraint with
                {
                    Name = name
                });
                if (constraint.Kind == "unique")
                {
                    indexes.Add(name, ConstraintIndex(name, constraint.Columns));
                }
            }
            tables[reference.TableName] = new SchemaTableModel(physical.Name, columns, indexes.Keys, indexes, constraints, physical.Owner);
        }
        var schemaEffects = new List<CurrentSchemaRecipeOperation>();
        var dataEffects = new List<CurrentSchemaRecipeOperation>();
        var independentSequences = new List<CurrentSchemaIndependentSequencePhysicalProjection>();
        foreach (CurrentSchemaRecipeOperation operation in requiredRecipes.SelectMany(static reference => reference.SemanticDescription!.AdditionalOperations))
        {
            if (operation.Kind == CurrentSchemaRecipeOperationKind.CreateSequence)
            {
                CurrentSchemaIndependentSequencePhysicalProjection sequence = ProjectIndependentSequence(operation, provider);
                if (independentSequences.Any(value => value.Name == sequence.Name))
                {
                    throw new InvalidOperationException("current_schema_independent_sequence_duplicate");
                }
                independentSequences.Add(sequence);
            }
            else if (operation.Sequence is not null)
            {
                throw new InvalidOperationException("current_schema_independent_sequence_unused_fact");
            }
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
        SchemaTableModel control = CurrentSchemaControlShape.ProjectApplyJournal(provider);
        if (!tables.TryAdd(control.Name, control))
            throw new InvalidOperationException("current_schema_control_table_overlap");
        return new CurrentSchemaCompletePhysicalProjection(new SchemaModelSnapshot(tables, target, provider),
            schemaEffects.ToArray(), dataEffects.ToArray())
        {
            IndependentSequences = independentSequences.ToArray()
        };
    }

    /// <summary>Projects the original independent sequence facts without choosing an unimplemented provider allocation policy.</summary>
    /// <param name="operation">The exact current-owned sequence effect, including its typed configuration.</param>
    /// <param name="provider">The actual physical provider.</param>
    /// <returns>The existing native PostgreSQL sequence representation; other provider mappings remain unavailable.</returns>
    public static CurrentSchemaIndependentSequencePhysicalProjection ProjectIndependentSequence(
        CurrentSchemaRecipeOperation operation, SchemaProviderKind provider)
    {
        ArgumentNullException.ThrowIfNull(operation);
        CurrentSchemaIndependentSequenceFacts facts = operation.Sequence
            ?? throw new InvalidOperationException("current_schema_independent_sequence_facts_missing");
        if (facts != CurrentSchemaIndependentSequenceFacts.PostgreSqlBigIntDefaults
            || operation != new CurrentSchemaRecipeOperation(CurrentSchemaRecipeOperationKind.CreateSequence,
                operation.Name, Sequence: facts)
            || string.IsNullOrEmpty(operation.Name) || operation.Name.Length > 63
            || operation.Name[0] is not (>= 'a' and <= 'z' or '_')
            || operation.Name.Any(static value => value is not (>= 'a' and <= 'z' or >= '0' and <= '9' or '_')))
        {
            throw new InvalidOperationException("current_schema_independent_sequence_facts_invalid");
        }
        if (provider != SchemaProviderKind.PostgreSql)
        {
            throw new InvalidOperationException("current_schema_independent_sequence_provider_unavailable");
        }
        return new(operation.Name, provider, CurrentSchemaSequencePhysicalKind.NativeIndependentSequence, facts);
    }

    private static SchemaIndexModel ConstraintIndex(string name, IReadOnlyList<string> columns)
        => new(name, true, columns.Select(static column => new SchemaIndexKeyModel(column, "asc", "last", "default", "default")).ToArray(),
            [], "btree", null, false);

    private static CurrentSchemaCompletePhysicalProjection ProjectPortableOwnedTarget(
        CurrentSchemaProjection entityProjection, IReadOnlyList<CurrentSchemaRequiredRecipeReference> recipes,
        CurrentSchemaIdentity target, SchemaProviderKind provider)
    {
        // Provider identifies the original recipe source, not permission to reuse
        // that source's SQL on another engine. Only closed structural facts below
        // have a portable projection; raw expressions and allocator/guard policies
        // still require their original semantic owner, never a guessed replacement.
        if (recipes.Any(static reference => reference.Provider != SchemaProviderKind.PostgreSql))
        {
            throw new InvalidOperationException("current_schema_complete_target_recipe_provider_unavailable");
        }
        var semantic = new Dictionary<string, SchemaTableModel>(entityProjection.Schema.Tables, StringComparer.Ordinal);
        foreach (CurrentSchemaRequiredRecipeReference reference in recipes)
        {
            if (!semantic.TryAdd(reference.TableName, reference.SemanticDescription!.Table))
            {
                throw new InvalidOperationException("current_schema_complete_target_table_overlap");
            }
        }
        if (semantic.Any(static entry => entry.Key != entry.Value.Name))
        {
            throw new InvalidOperationException("current_schema_complete_target_relational_facts_invalid");
        }
        foreach (CurrentSchemaRecipeOperation effect in recipes.SelectMany(static reference => reference.SemanticDescription!.AdditionalOperations))
        {
            if (effect.Kind == CurrentSchemaRecipeOperationKind.CreateSequence)
            {
                _ = ProjectIndependentSequence(effect, provider);
            }
            if (effect.Sequence is not null)
            {
                throw new InvalidOperationException("current_schema_independent_sequence_unused_fact");
            }
            if (effect.Kind is CurrentSchemaRecipeOperationKind.DefineImmutableGuard
                or CurrentSchemaRecipeOperationKind.RemoveTrigger or CurrentSchemaRecipeOperationKind.CreateImmutableTrigger)
            {
                throw new InvalidOperationException("current_schema_immutable_guard_provider_unavailable");
            }
            if (effect.Kind == CurrentSchemaRecipeOperationKind.InsertIfAbsent)
            {
                throw new InvalidOperationException("current_schema_complete_target_expression_provider_unavailable");
            }
            if (effect.Table is null || !semantic.TryGetValue(effect.Table, out SchemaTableModel? table))
            {
                throw new InvalidOperationException("current_schema_complete_target_effect_table_missing");
            }
            var columns = new Dictionary<string, SchemaColumnModel>(table.Columns, StringComparer.Ordinal);
            var indexes = new Dictionary<string, SchemaIndexModel>(table.IndexDefinitions, StringComparer.Ordinal);
            var constraints = new Dictionary<string, SchemaConstraintModel>(table.Constraints, StringComparer.Ordinal);
            switch (effect.Kind)
            {
                case CurrentSchemaRecipeOperationKind.CreateIndex:
                    if (effect.Index is not { } index || index.Name != effect.Name || !indexes.TryAdd(index.Name, index)
                        || effect != new CurrentSchemaRecipeOperation(effect.Kind, effect.Name, effect.Table, Index: index))
                    {
                        throw new InvalidOperationException("current_schema_complete_target_effect_index_conflict");
                    }
                    break;
                case CurrentSchemaRecipeOperationKind.AddColumnIfAbsent:
                    if (effect.Column is not { } column || column.Name != effect.Name
                        || effect != new CurrentSchemaRecipeOperation(effect.Kind, effect.Name, effect.Table, Column: column))
                    {
                        throw new InvalidOperationException("current_schema_complete_target_effect_column_invalid");
                    }
                    if (columns.TryGetValue(column.Name, out SchemaColumnModel? existing) && existing != column)
                    {
                        throw new InvalidOperationException("current_schema_complete_target_effect_column_conflict");
                    }
                    columns[column.Name] = column;
                    break;
                case CurrentSchemaRecipeOperationKind.AddConstraintIfAbsent:
                    if (effect.Constraint is not { } constraint || constraint.Name != effect.Name
                        || !constraints.TryAdd(constraint.Name, constraint)
                        || effect != new CurrentSchemaRecipeOperation(effect.Kind, effect.Name, effect.Table, Constraint: constraint))
                    {
                        throw new InvalidOperationException("current_schema_complete_target_effect_constraint_conflict");
                    }
                    break;
                default:
                    throw new InvalidOperationException("current_schema_complete_target_effect_unknown");
            }
            semantic[table.Name] = new(table.Name, columns, indexes.Keys, indexes, constraints, table.Owner);
        }
        SchemaModelSnapshot physical = ProjectProvider(Create(semantic, target.SourceDigest), provider);
        var tables = physical.Tables.ToDictionary(static entry => entry.Key,
            entry => ProjectPortableRelationalFacts(semantic[entry.Key], entry.Value, provider), StringComparer.Ordinal);
        SchemaTableModel control = CurrentSchemaControlShape.ProjectApplyJournal(provider);
        if (!tables.TryAdd(control.Name, control))
        {
            throw new InvalidOperationException("current_schema_control_table_overlap");
        }
        return new(new SchemaModelSnapshot(tables, target, provider), [], []);
    }

    private static SchemaTableModel ProjectPortableRelationalFacts(
        SchemaTableModel semantic, SchemaTableModel physical, SchemaProviderKind provider)
    {
        if (semantic.Name != physical.Name || !semantic.Indexes.SetEquals(semantic.IndexDefinitions.Keys)
            || semantic.Constraints.Any(static entry => entry.Key != entry.Value.Name))
        {
            throw new InvalidOperationException("current_schema_complete_target_relational_facts_invalid");
        }
        var columns = new Dictionary<string, SchemaColumnModel>(physical.Columns, StringComparer.Ordinal);
        foreach ((string name, SchemaColumnModel original) in semantic.Columns)
        {
            if (name != original.Name || original.IsIdentity || original.OwnedSequence is not null || original.GenerationKind != "none")
            {
                throw new InvalidOperationException("current_schema_complete_target_allocator_provider_unavailable");
            }
            if (original.DefaultValue is not null || original.ComputedExpression is not null)
            {
                throw new InvalidOperationException("current_schema_complete_target_expression_provider_unavailable");
            }
            if (provider == SchemaProviderKind.MySql && original.DataType == "string")
            {
                // Business text collation has no complete portable owner fact yet.
                // The separately owned exact journal keys have their own projection.
                throw new InvalidOperationException("current_schema_complete_target_text_collation_unavailable");
            }
            columns[name] = columns[name] with
            {
                MaxLength = provider == SchemaProviderKind.Sqlite ? null : original.MaxLength,
                Collation = provider == SchemaProviderKind.Sqlite && original.DataType == "string" ? "BINARY" : columns[name].Collation
            };
        }
        // Native MySQL key names are case-insensitive on every platform. Use its
        // comparison only for collisions; retain the original owned names and
        // never normalize semantic input or change another provider's namespace.
        StringComparer keyNames = provider == SchemaProviderKind.MySql ? StringComparer.OrdinalIgnoreCase : StringComparer.Ordinal;
        var constraints = new Dictionary<string, SchemaConstraintModel>(keyNames);
        var indexes = new Dictionary<string, SchemaIndexModel>(keyNames);
        int ordinal = 0;
        foreach (SchemaConstraintModel constraint in semantic.Constraints.Values.OrderBy(static value => value.Name, StringComparer.Ordinal))
        {
            if (constraint.Kind is not ("primary-key" or "unique") || constraint.Expression is not null
                || constraint.IsDeferrable || constraint.IsInitiallyDeferred || !constraint.IsValidated
                || constraint.ReferencedTable is not null || constraint.ReferencedColumns is not null
                || constraint.ReferencedSchema is not null || constraint.ForeignKeyUpdateAction is not null
                || constraint.ForeignKeyDeleteAction is not null || constraint.ForeignKeyMatchType is not null
                || constraint.Columns.Count == 0 || constraint.Columns.Distinct(StringComparer.Ordinal).Count() != constraint.Columns.Count
                || constraint.Columns.Any(name => !columns.ContainsKey(name))
                || constraints.Values.Any(value => value.Columns.SequenceEqual(constraint.Columns)))
            {
                throw new InvalidOperationException("current_schema_complete_target_constraint_provider_unavailable");
            }
            if (provider == SchemaProviderKind.Sqlite && constraint.Kind == "primary-key" && constraint.Columns.Count == 1
                && columns[constraint.Columns[0]].PhysicalType == "INTEGER")
            {
                throw new InvalidOperationException("current_schema_complete_target_allocator_provider_unavailable");
            }
            string constraintName = provider == SchemaProviderKind.MySql && constraint.Kind == "primary-key" ? "PRIMARY" : constraint.Name;
            if (provider == SchemaProviderKind.MySql && keyNames.Equals(constraintName, "PRIMARY") && constraint.Kind != "primary-key")
            {
                throw new InvalidOperationException("current_schema_complete_target_constraint_provider_unavailable");
            }
            if (!constraints.TryAdd(constraintName, constraint with
            {
                Name = constraintName
            }))
            {
                throw new InvalidOperationException("current_schema_complete_target_constraint_provider_unavailable");
            }
            if (provider == SchemaProviderKind.MySql && constraint.Kind == "primary-key")
            {
                // Native MySQL primary keys implicitly make every key column NOT
                // NULL. Derive only physical facts; the original input and its
                // semantic/source/content identity retain the declared nullability.
                foreach (string name in constraint.Columns)
                {
                    columns[name] = columns[name] with
                    {
                        IsNullable = false,
                        IsPrimaryKey = true
                    };
                }
            }
            ordinal++;
            string indexName = provider == SchemaProviderKind.Sqlite ? $"sqlite_autoindex_{physical.Name}_{ordinal}" : constraintName;
            indexes.Add(indexName, PortableIndex(new(indexName, true,
                constraint.Columns.Select(static name => new SchemaIndexKeyModel(name, "asc", "first", "default", "default")).ToArray(),
                [], "btree", null, false), columns, provider));
        }
        foreach ((string name, SchemaIndexModel index) in semantic.IndexDefinitions)
        {
            if (name != index.Name || provider == SchemaProviderKind.MySql && keyNames.Equals(index.Name, "PRIMARY")
                || !indexes.TryAdd(index.Name, PortableIndex(index, columns, provider)))
            {
                throw new InvalidOperationException("current_schema_complete_target_effect_index_conflict");
            }
            // MySQL exposes each explicit UNIQUE index as a TABLE_CONSTRAINTS
            // member too. This is the same owned key, not another semantic index
            // or a second constraint backing index to synthesize.
            if (provider == SchemaProviderKind.MySql && index.IsUnique
                && !constraints.TryAdd(index.Name, new(index.Name, "unique", index.Keys.Select(static key => key.Column).ToArray())))
            {
                throw new InvalidOperationException("current_schema_complete_target_effect_constraint_conflict");
            }
        }
        return new(physical.Name, columns, indexes.Keys, indexes, constraints, physical.Owner);
    }

    private static SchemaIndexModel PortableIndex(SchemaIndexModel index, IReadOnlyDictionary<string, SchemaColumnModel> columns,
        SchemaProviderKind provider)
    {
        if (index.Keys.Count == 0 || index.IncludedColumns.Count != 0 || index.AccessMethod != "btree"
            || index.Predicate is not null || index.NullsNotDistinct)
        {
            throw new InvalidOperationException("current_schema_complete_target_index_provider_unavailable");
        }
        SchemaIndexKeyModel[] keys = index.Keys.Select(key =>
        {
            if (!columns.TryGetValue(key.Column, out SchemaColumnModel? column) || key.Direction is not ("asc" or "desc")
                || key.NullPlacement is not ("first" or "last") || key.OperatorClass != "default" || key.Collation != "default")
            {
                throw new InvalidOperationException("current_schema_complete_target_index_provider_unavailable");
            }
            string nulls = key.Direction == "asc" ? "first" : "last";
            if (column.IsNullable && key.NullPlacement != nulls)
            {
                throw new InvalidOperationException("current_schema_complete_target_index_null_placement_unavailable");
            }
            return key with
            {
                NullPlacement = nulls,
                Collation = provider == SchemaProviderKind.Sqlite ? "BINARY" : "default"
            };
        }).ToArray();
        return index with
        {
            Keys = keys
        };
    }

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
                table.Value.MySqlPhysical,
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
                        column.Value.MySqlPhysical,
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
                table.Value.MySqlPhysical,
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
                        column.Value.ComputedExpression,
                        column.Value.MySqlPhysical
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
                table.Value.Owner)
            {
                MySqlPhysical = CopyMySqlTableFacts(table.Value.MySqlPhysical)
            },
            StringComparer.Ordinal);
        return new SchemaModelSnapshot(tables, identity, provider);
    }

    private static string ProjectGenerationKind(SchemaProviderKind provider, SchemaColumnModel column)
        => provider == SchemaProviderKind.PostgreSql && column.IsIdentity
            ? "owned-sequence-default"
            : "none";

    private static SchemaMySqlTablePhysicalFacts? CopyMySqlTableFacts(SchemaMySqlTablePhysicalFacts? facts)
        => facts is null ? null : facts with
        {
            Partitions = facts.Partitions?.ToArray()
                ?? throw new InvalidOperationException("current_schema_mysql_partition_facts_unavailable")
        };

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
