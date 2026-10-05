using System.Collections.ObjectModel;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

using FsusBlog.Contracts.Schema;

namespace FsusBlog.Migration;

// Pure provider compilation, not a DAG, native session, execution grant or receipt.
// Full bootstrap dispatch remains with the original owner until all effects and
// actual provider postconditions are supported. No PostgreSQL SQL is rewritten.
internal static class CurrentSchemaPortableBootstrapCompiler
{
    // Even source-bound commands omit the original native control/operation and
    // unknown allocator/effect owners. Consumers must not register a complete DAG.
    internal const bool ProducesCompleteCurrentBootstrap = false;

    internal static CompiledCurrentSchemaBootstrap CompileEntitySubset(
        CurrentSchemaProjection projection, SchemaProviderKind provider)
    {
        RequireProvider(provider);
        CurrentSchemaCanonicalAuthority.VerifyIdentity(projection.Schema, projection.Identity);
        if (projection.Schema.Provider != SchemaProviderKind.Semantic || projection.Schema.Tables.Count == 0)
            throw new InvalidOperationException("portable_bootstrap_semantic_input_required");
        return Freeze(provider, projection.Identity, CompileTables(projection.Schema.Tables, provider, projection.Identity.SourceDigest));
    }

    internal static CompiledCurrentSchemaBootstrap CompileOwnedFacts(
        CurrentSchemaBootstrapInput input, CurrentSchemaProducerIdentity expectedOwner,
        SchemaProviderKind provider, string verifiedOwnedInputDigest)
    {
        RequireProvider(provider);
        ArgumentNullException.ThrowIfNull(input);
        // Rejection-only capability preflight: this is not owner admission. In
        // particular an unavailable sequence/guard/seed never reaches a renderer
        // or obtains commands merely because the original PG grammar supports it.
        if (input.RequiredRecipes.Any(static reference => reference.SemanticDescription is { } facts
            && facts.AdditionalOperations.Any(static operation => operation.Kind is not
                (CurrentSchemaRecipeOperationKind.CreateIndex or CurrentSchemaRecipeOperationKind.AddColumnIfAbsent
                or CurrentSchemaRecipeOperationKind.AddConstraintIfAbsent))))
            throw new InvalidOperationException("portable_bootstrap_recipe_effect_unavailable");
        // Reuse original closed owner/recipe admission and the sole composite target.
        // Only the typed facts below are rendered; these PG commands are never used.
        CompiledCurrentSchemaBootstrap admitted = CurrentSchemaBootstrapCompiler.Compile(
            input, expectedOwner, SchemaProviderKind.PostgreSql, verifiedOwnedInputDigest);
        var tables = new Dictionary<string, SchemaTableModel>(input.EntityProjection.Schema.Tables, StringComparer.Ordinal);
        foreach (CurrentSchemaRequiredRecipeReference reference in input.RequiredRecipes)
        {
            if (!tables.TryAdd(reference.TableName, reference.SemanticDescription!.Table))
                throw new InvalidOperationException("portable_bootstrap_recipe_overlap");
        }
        foreach (CurrentSchemaRequiredRecipeReference reference in input.RequiredRecipes)
        {
            foreach (CurrentSchemaRecipeOperation operation in reference.SemanticDescription!.AdditionalOperations)
            {
                if (operation.Table is null || !tables.TryGetValue(operation.Table, out SchemaTableModel? table))
                    throw new InvalidOperationException("portable_bootstrap_recipe_effect_unavailable");
                var columns = new Dictionary<string, SchemaColumnModel>(table.Columns, StringComparer.Ordinal);
                var constraints = new Dictionary<string, SchemaConstraintModel>(table.Constraints, StringComparer.Ordinal);
                var indexes = new Dictionary<string, SchemaIndexModel>(table.IndexDefinitions, StringComparer.Ordinal);
                switch (operation.Kind)
                {
                    case CurrentSchemaRecipeOperationKind.CreateIndex:
                        if (operation.Index is not { } index || index.Name != operation.Name
                            || !indexes.TryAdd(index.Name, index)
                            || operation != new CurrentSchemaRecipeOperation(operation.Kind, operation.Name, operation.Table, Index: index))
                            throw new InvalidOperationException("portable_bootstrap_recipe_effect_unavailable");
                        break;
                    case CurrentSchemaRecipeOperationKind.AddColumnIfAbsent:
                        if (operation.Column is not { } column || column.Name != operation.Name
                            || operation != new CurrentSchemaRecipeOperation(operation.Kind, operation.Name, operation.Table, Column: column))
                            throw new InvalidOperationException("portable_bootstrap_recipe_effect_unavailable");
                        if (columns.TryGetValue(column.Name, out SchemaColumnModel? existing) && existing != column)
                            throw new InvalidOperationException("portable_bootstrap_recipe_column_conflict");
                        columns[column.Name] = column;
                        break;
                    case CurrentSchemaRecipeOperationKind.AddConstraintIfAbsent:
                        if (operation.Constraint is not { } constraint || constraint.Name != operation.Name
                            || !constraints.TryAdd(constraint.Name, constraint)
                            || operation != new CurrentSchemaRecipeOperation(operation.Kind, operation.Name, operation.Table, Constraint: constraint))
                            throw new InvalidOperationException("portable_bootstrap_recipe_effect_unavailable");
                        break;
                    default:
                        throw new InvalidOperationException("portable_bootstrap_recipe_effect_unavailable");
                }
                // Copy only the source's typed facts. Rendering a final empty
                // table avoids nonportable ALTER/IF NOT EXISTS syntax and never
                // mutates the original producer input or its complete identity.
                tables[table.Name] = new(table.Name, columns, indexes.Keys, indexes, constraints, table.Owner);
            }
        }
        List<SchemaMigrationCommand> commands = CompileTables(tables, provider, input.EntityProjection.Identity.SourceDigest);
        return Freeze(provider, admitted.Target, commands);
    }

    private static List<SchemaMigrationCommand> CompileTables(
        IReadOnlyDictionary<string, SchemaTableModel> semantic, SchemaProviderKind provider, string sourceDigest)
    {
        // The sole authority owns the physical type projection; no business inventory here.
        CurrentSchemaCanonicalModel canonical = CurrentSchemaCanonicalAuthority.Create(semantic, sourceDigest);
        SchemaModelSnapshot physical = CurrentSchemaCanonicalAuthority.ProjectProvider(canonical, provider);
        var commands = new List<SchemaMigrationCommand>();
        foreach ((string name, SchemaTableModel table) in physical.Tables.OrderBy(static value => value.Key, StringComparer.Ordinal))
        {
            if (name != table.Name || table.Columns.Count == 0 || !table.Indexes.SetEquals(table.IndexDefinitions.Keys))
                throw new InvalidOperationException("portable_bootstrap_table_incomplete");
            SchemaColumnModel[] identities = table.Columns.Values.Where(static value => value.IsIdentity).ToArray();
            SchemaConstraintModel[] primary = table.Constraints.Values.Where(static value => value.Kind == "primary-key").ToArray();
            if (identities.Length > 1 || primary.Length > 1
                || table.Columns.Values.Where(static value => value.IsPrimaryKey).Select(static value => value.Name).Order(StringComparer.Ordinal)
                    .SequenceEqual(primary.SelectMany(static value => value.Columns).Order(StringComparer.Ordinal)) == false)
                throw new InvalidOperationException("portable_bootstrap_primary_key_incomplete");
            string? inlinePrimary = null;
            if (identities.Length == 1)
            {
                SchemaColumnModel identity = identities[0];
                if (identity.IsNullable || identity.DefaultValue is not null || identity.DataType is not ("int16" or "int32" or "int64")
                    || primary.Length != 1 || primary[0].Columns.Count != 1 || primary[0].Columns[0] != identity.Name)
                    throw new InvalidOperationException("portable_bootstrap_identity_unavailable");
                if (provider == SchemaProviderKind.Sqlite) inlinePrimary = primary[0].Name;
            }
            var definitions = table.Columns.OrderBy(static value => value.Key, StringComparer.Ordinal)
                .Select(value => value.Key == value.Value.Name ? Column(value.Value, provider, inlinePrimary)
                    : throw new InvalidOperationException("portable_bootstrap_column_name_invalid")).ToList();
            foreach ((string key, SchemaConstraintModel constraint) in table.Constraints.OrderBy(static value => value.Key, StringComparer.Ordinal))
            {
                if (key != constraint.Name || !constraint.IsValidated || constraint.IsDeferrable || constraint.IsInitiallyDeferred)
                    throw new InvalidOperationException("portable_bootstrap_constraint_state_unavailable");
                RequireColumns(table, constraint.Columns);
                if (constraint.Kind is not ("primary-key" or "unique") || constraint.Expression is not null
                    || constraint.ReferencedTable is not null || constraint.ReferencedColumns is not null
                    || constraint.ReferencedSchema is not null || constraint.ForeignKeyMatchType is not null
                    || constraint.ForeignKeyUpdateAction is not null || constraint.ForeignKeyDeleteAction is not null)
                    throw new InvalidOperationException("portable_bootstrap_constraint_effect_unavailable");
                if (constraint.Name == inlinePrimary) continue;
                definitions.Add($"CONSTRAINT {Identifier(constraint.Name, provider)} {(constraint.Kind == "primary-key" ? "PRIMARY KEY" : "UNIQUE")} ({Columns(constraint.Columns, provider)})");
            }
            string suffix = provider == SchemaProviderKind.MySql ? " ENGINE=InnoDB" : "";
            commands.Add(new($"CREATE TABLE {Identifier(name, provider)} ({string.Join(", ", definitions)}){suffix};", IsDdl: true));
        }
        foreach (SchemaTableModel table in physical.Tables.OrderBy(static value => value.Key, StringComparer.Ordinal).Select(static value => value.Value))
        {
            foreach (SchemaIndexModel index in table.IndexDefinitions.Values.OrderBy(static value => value.Name, StringComparer.Ordinal))
                commands.Add(RenderIndex(table, index, provider));
        }
        return commands;
    }

    private static string Column(SchemaColumnModel column, SchemaProviderKind provider, string? inlinePrimary)
    {
        if (column.ComputedExpression is not null || column.Conversion is not (null or "none" or "json")
            || column.OwnedSequence is not null || column.GenerationKind != "none")
            throw new InvalidOperationException("portable_bootstrap_column_effect_unavailable");
        string type = column.PhysicalType ?? throw new InvalidOperationException("portable_bootstrap_physical_type_missing");
        // ProjectProvider produced this value from the closed semantic type vocabulary.
        string definition = $"{Identifier(column.Name, provider)} {type}";
        if (column.IsIdentity)
            definition += provider == SchemaProviderKind.MySql ? " AUTO_INCREMENT"
                : $" CONSTRAINT {Identifier(inlinePrimary!, provider)} PRIMARY KEY AUTOINCREMENT";
        definition += column.IsNullable ? " NULL" : " NOT NULL";
        if (column.DefaultValue is not null)
        {
            string value = column.DefaultValue;
            if (column.DataType == "string" && Regex.IsMatch(value, @"\A[A-Za-z_][A-Za-z0-9_ .-]*\z", RegexOptions.CultureInvariant)
                && !value.Equals("NULL", StringComparison.OrdinalIgnoreCase))
                value = "'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
            if (!Regex.IsMatch(value, @"\A(?:-?[0-9]+(?:\.[0-9]+)?|true|false|NULL|'(?:[^']|'')*')\z",
                RegexOptions.CultureInvariant | RegexOptions.IgnoreCase))
                throw new InvalidOperationException("portable_bootstrap_default_effect_unavailable");
            // MySQL interprets backslashes in quoted literals unless a separately
            // owned SQL mode disables escapes. This compiler has no such proof.
            if (provider == SchemaProviderKind.MySql && value.StartsWith('\'') && value.Contains('\\'))
                throw new InvalidOperationException("portable_bootstrap_default_escape_unavailable");
            // MySQL large-object/JSON literal defaults have different expression rules.
            if (provider == SchemaProviderKind.MySql && column.DataType is ("bytes" or "json")
                || provider == SchemaProviderKind.MySql && column.DataType == "string" && column.MaxLength is null)
                throw new InvalidOperationException("portable_bootstrap_large_default_unavailable");
            definition += $" DEFAULT {value}";
        }
        return definition;
    }

    private static SchemaMigrationCommand RenderIndex(SchemaTableModel table, SchemaIndexModel index, SchemaProviderKind provider)
    {
        if (index.Keys.Count == 0 || index.AccessMethod != "btree" || index.IncludedColumns.Count != 0
            || index.Predicate is not null || index.NullsNotDistinct)
            throw new InvalidOperationException("portable_bootstrap_index_effect_unavailable");
        RequireColumns(table, index.Keys.Select(static value => value.Column).ToArray());
        string[] keys = index.Keys.Select(key =>
        {
            if (key.Direction is not ("asc" or "desc") || key.NullPlacement is not ("first" or "last")
                || key.OperatorClass != "default" || key.Collation != "default")
                throw new InvalidOperationException("portable_bootstrap_index_key_unavailable");
            // Both providers' native ascending order places NULL first. Do not add
            // expression keys or silently drop a requested opposite NULL ordering.
            if (table.Columns[key.Column].IsNullable && key.NullPlacement != (key.Direction == "asc" ? "first" : "last"))
                throw new InvalidOperationException("portable_bootstrap_index_null_order_unavailable");
            return $"{Identifier(key.Column, provider)} {key.Direction.ToUpperInvariant()}";
        }).ToArray();
        return new($"CREATE {(index.IsUnique ? "UNIQUE " : "")}INDEX {Identifier(index.Name, provider)} ON {Identifier(table.Name, provider)} ({string.Join(", ", keys)});", IsDdl: true);
    }

    private static void RequireColumns(SchemaTableModel table, IReadOnlyList<string> columns)
    {
        if (columns.Count == 0 || columns.Distinct(StringComparer.Ordinal).Count() != columns.Count
            || columns.Any(value => !table.Columns.ContainsKey(value)))
            throw new InvalidOperationException("portable_bootstrap_constraint_columns_invalid");
    }

    private static string Identifier(string value, SchemaProviderKind provider)
    {
        if (value is null || !Regex.IsMatch(value, @"\A[a-z_][a-z0-9_]{0,62}\z", RegexOptions.CultureInvariant))
            throw new InvalidOperationException("portable_bootstrap_identifier_invalid");
        return provider == SchemaProviderKind.MySql ? $"`{value}`" : $"\"{value}\"";
    }

    private static string Columns(IReadOnlyList<string> columns, SchemaProviderKind provider)
        => string.Join(", ", columns.Select(value => Identifier(value, provider)));

    private static void RequireProvider(SchemaProviderKind provider)
    {
        if (provider is not (SchemaProviderKind.MySql or SchemaProviderKind.Sqlite))
            throw new InvalidOperationException("portable_bootstrap_provider_unavailable");
    }

    private static CompiledCurrentSchemaBootstrap Freeze(SchemaProviderKind provider, CurrentSchemaIdentity target,
        List<SchemaMigrationCommand> commands)
    {
        var frozen = new ReadOnlyCollection<SchemaMigrationCommand>(commands);
        string digest = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(frozen))));
        return new(provider, target, frozen, digest);
    }
}
