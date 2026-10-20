using System.Collections.ObjectModel;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

using FsusBlog.Contracts.Schema;

namespace FsusBlog.Migration;

internal static partial class CurrentSchemaBootstrapCompiler
{
    /// <summary>Identity of the exact artifact; independent owner verification must precede consumption.</summary>
    internal static string OwnedInputDigest(CurrentSchemaBootstrapInput input)
        => CurrentSchemaOwnedTargetProjection.ComputeInputDigest(input);

    private static CompiledCurrentSchemaBootstrap CompileOwnedRecipes(CurrentSchemaBootstrapInput input, SchemaProviderKind provider)
    {
        CompiledCurrentSchemaBootstrap entities = CompileEntityProjection(input.EntityProjection, provider);
        var tables = new Dictionary<string, SchemaTableModel>(input.EntityProjection.Schema.Tables, StringComparer.Ordinal);
        foreach (CurrentSchemaRequiredRecipeReference reference in input.RequiredRecipes)
        {
            CurrentSchemaRecipeFacts facts = reference.SemanticDescription!;
            if (reference.Provider != SchemaProviderKind.PostgreSql || facts.Table.Name != reference.TableName
                || !tables.TryAdd(facts.Table.Name, facts.Table))
            {
                throw new InvalidOperationException("current_schema_bootstrap_recipe_target_overlap_or_provider_invalid");
            }
        }
        var commands = entities.Commands.ToList();
        // Preserve the original owner order: every table before additional effects.
        foreach (CurrentSchemaRequiredRecipeReference reference in input.RequiredRecipes)
        {
            SchemaTableModel table = reference.SemanticDescription!.Table;
            if (table.Columns.Count == 0 || table.Indexes.Count != 0 || table.IndexDefinitions.Count != 0)
                throw new InvalidOperationException("current_schema_bootstrap_recipe_table_invalid");
            string[] definitions = table.Columns.OrderBy(static item => item.Key, StringComparer.Ordinal)
                .Select(item => item.Key == item.Value.Name ? RecipeColumn(item.Value)
                    : throw new InvalidOperationException("current_schema_bootstrap_recipe_column_name_invalid")).ToArray();
            string[] constraints = table.Constraints.OrderBy(static item => item.Key, StringComparer.Ordinal)
                .Select(item => item.Key == item.Value.Name ? RecipeConstraint(item.Value, table, tables)
                    : throw new InvalidOperationException("current_schema_bootstrap_recipe_constraint_name_invalid")).ToArray();
            commands.Add(new($"CREATE TABLE {Identifier(table.Name)} ({string.Join(", ", definitions.Concat(constraints))});", IsDdl: true));
        }
        foreach (CurrentSchemaRequiredRecipeReference reference in input.RequiredRecipes)
        {
            foreach (CurrentSchemaRecipeOperation operation in reference.SemanticDescription!.AdditionalOperations)
                commands.Add(RenderRecipeOperation(operation, tables));
        }
        CurrentSchemaIdentity identity = CurrentSchemaOwnedTargetProjection.Observe(input);
        var frozen = new ReadOnlyCollection<SchemaMigrationCommand>(commands);
        return new(provider, identity, frozen, Digest(JsonSerializer.Serialize(frozen)));
    }

    private static SchemaMigrationCommand RenderRecipeOperation(CurrentSchemaRecipeOperation operation,
        IReadOnlyDictionary<string, SchemaTableModel> tables)
    {
        string name = Identifier(operation.Name);
        string Table()
            => operation.Table is not null && tables.ContainsKey(operation.Table) ? Identifier(operation.Table)
                : throw new InvalidOperationException("current_schema_bootstrap_recipe_operation_table_missing");
        CurrentSchemaRecipeOperation expected;
        string sql;
        bool ddl = true;
        switch (operation.Kind)
        {
            case CurrentSchemaRecipeOperationKind.CreateIndex:
                SchemaIndexModel index = operation.Index ?? throw new InvalidOperationException("current_schema_bootstrap_recipe_index_missing");
                _ = Table();
                if (index.Name != operation.Name || index.Keys.Count == 0 || index.AccessMethod != "btree"
                    || index.IncludedColumns.Count != 0 || index.NullsNotDistinct)
                    throw new InvalidOperationException("current_schema_bootstrap_recipe_index_capability_unavailable");
                string[] keys = index.Keys.Select(key =>
                {
                    if (key.OperatorClass != "default" || key.Collation != "default"
                        || key.Direction is not ("asc" or "desc") || key.NullPlacement is not ("first" or "last"))
                        throw new InvalidOperationException("current_schema_bootstrap_recipe_index_key_invalid");
                    return $"{IndexValue(key, tables[operation.Table!])} {key.Direction.ToUpperInvariant()} NULLS {key.NullPlacement.ToUpperInvariant()}";
                }).ToArray();
                string where = index.Predicate is null ? "" : $" WHERE {Expression(index.Predicate)}";
                sql = $"CREATE {(index.IsUnique ? "UNIQUE " : "")}INDEX {name} ON {Table()} ({string.Join(", ", keys)}){where};";
                expected = new(operation.Kind, operation.Name, operation.Table, Index: index);
                break;
            case CurrentSchemaRecipeOperationKind.CreateSequence:
                CurrentSchemaIndependentSequencePhysicalProjection sequence =
                    CurrentSchemaCanonicalAuthority.ProjectIndependentSequence(operation, SchemaProviderKind.PostgreSql);
                sql = $"CREATE SEQUENCE {name} AS bigint;";
                expected = new(operation.Kind, operation.Name, Sequence: sequence.Facts);
                break;
            case CurrentSchemaRecipeOperationKind.DefineImmutableGuard:
                string error = operation.ErrorCode ?? throw new InvalidOperationException("current_schema_bootstrap_recipe_guard_missing");
                _ = Identifier(error);
                string? sqlState = CurrentSchemaImmutableEffects.RequireSqlState(operation.SqlState);
                string exceptionState = sqlState is null ? "" : $" USING ERRCODE = '{sqlState}'";
                sql = $"CREATE FUNCTION {name}() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION '{error}'{exceptionState}; END; $$ LANGUAGE plpgsql;";
                expected = new(operation.Kind, operation.Name, ErrorCode: error, SqlState: sqlState);
                break;
            case CurrentSchemaRecipeOperationKind.RemoveTrigger:
                sql = $"DROP TRIGGER IF EXISTS {name} ON {Table()};";
                expected = new(operation.Kind, operation.Name, operation.Table);
                break;
            case CurrentSchemaRecipeOperationKind.CreateImmutableTrigger:
                string function = Identifier(operation.Function ?? throw new InvalidOperationException("current_schema_bootstrap_recipe_trigger_function_missing"));
                CurrentSchemaImmutableTriggerFacts trigger = CurrentSchemaImmutableEffects.RequireTrigger(operation.Trigger);
                string events = trigger.Events.HasFlag(CurrentSchemaTriggerEvents.Truncate) ? "UPDATE OR DELETE OR TRUNCATE" : "UPDATE OR DELETE";
                string level = trigger.Level == CurrentSchemaTriggerLevel.Statement ? "STATEMENT" : "ROW";
                sql = $"CREATE TRIGGER {name} BEFORE {events} ON {Table()} FOR EACH {level} EXECUTE FUNCTION {function}();";
                expected = new(operation.Kind, operation.Name, operation.Table, Function: operation.Function, Trigger: operation.Trigger);
                break;
            case CurrentSchemaRecipeOperationKind.InsertIfAbsent:
                _ = Table();
                if (operation.Columns is null || operation.Values is null || operation.Columns.Count != operation.Values.Count
                    || operation.ConflictColumn is null || !operation.Columns.Contains(operation.ConflictColumn, StringComparer.Ordinal))
                    throw new InvalidOperationException("current_schema_bootstrap_recipe_seed_invalid");
                RequireColumns(tables[operation.Table!], operation.Columns);
                sql = $"INSERT INTO {Table()} ({Columns(operation.Columns)}) VALUES ({string.Join(", ", operation.Values.Select(Expression))}) ON CONFLICT ({Identifier(operation.ConflictColumn)}) DO NOTHING;";
                expected = new(operation.Kind, operation.Name, operation.Table, Columns: operation.Columns,
                    Values: operation.Values, ConflictColumn: operation.ConflictColumn);
                ddl = false;
                break;
            case CurrentSchemaRecipeOperationKind.AddColumnIfAbsent:
                SchemaColumnModel column = operation.Column ?? throw new InvalidOperationException("current_schema_bootstrap_recipe_added_column_missing");
                if (operation.Name != column.Name)
                    throw new InvalidOperationException("current_schema_bootstrap_recipe_added_column_name_invalid");
                sql = $"ALTER TABLE {Table()} ADD COLUMN IF NOT EXISTS {RecipeColumn(column)};";
                expected = new(operation.Kind, operation.Name, operation.Table, Column: column);
                break;
            case CurrentSchemaRecipeOperationKind.AddConstraintIfAbsent:
                _ = Table();
                SchemaConstraintModel constraint = operation.Constraint ?? throw new InvalidOperationException("current_schema_bootstrap_recipe_added_constraint_missing");
                if (constraint.Name != operation.Name)
                    throw new InvalidOperationException("current_schema_bootstrap_recipe_added_constraint_name_invalid");
                // The empty bootstrap has no existing recipe constraint. Refuse a
                // conflicting pre-existing target through the original apply preflight.
                sql = $"ALTER TABLE {Table()} ADD {RecipeConstraint(constraint, tables[operation.Table!], tables)};";
                expected = new(operation.Kind, operation.Name, operation.Table, Constraint: constraint);
                break;
            default:
                throw new InvalidOperationException("current_schema_bootstrap_recipe_operation_capability_unavailable");
        }
        if (expected != operation)
            throw new InvalidOperationException("current_schema_bootstrap_recipe_unused_fact_invalid");
        return new(sql, IsDdl: ddl);
    }

    private static string RecipeColumn(SchemaColumnModel column)
    {
        if (column.ComputedExpression is not null || column.Conversion is not (null or "none") || column.OwnedSequence is not null
            || column.Collation is not ("default" or "n/a"))
            throw new InvalidOperationException("current_schema_bootstrap_recipe_column_capability_unavailable");
        string type = PhysicalType(column with
        {
            IsIdentity = false
        });
        string identity = column.IsIdentity && column.GenerationKind == "identity-by-default"
            ? " GENERATED BY DEFAULT AS IDENTITY" : !column.IsIdentity && column.GenerationKind == "none" ? ""
            : throw new InvalidOperationException("current_schema_bootstrap_recipe_identity_capability_unavailable");
        if (column.IsIdentity && column.DefaultValue is not null)
            throw new InvalidOperationException("current_schema_bootstrap_recipe_identity_default_invalid");
        string value = column.DefaultValue is null ? "" : $" DEFAULT {Expression(column.DefaultValue)}";
        return $"{Identifier(column.Name)} {type}{identity} {(column.IsNullable ? "NULL" : "NOT NULL")}{value}";
    }

    private static string RecipeConstraint(SchemaConstraintModel constraint, SchemaTableModel table,
        IReadOnlyDictionary<string, SchemaTableModel> tables)
    {
        if (!constraint.IsValidated || constraint.IsInitiallyDeferred && !constraint.IsDeferrable)
            throw new InvalidOperationException("current_schema_bootstrap_recipe_constraint_state_invalid");
        if (constraint.Kind != "check")
            RequireColumns(table, constraint.Columns);
        string clause;
        if (constraint.Kind == "foreign-key")
        {
            if (constraint.ReferencedTable is null || constraint.ReferencedColumns is null
                || constraint.ReferencedSchema != "public" || constraint.ForeignKeyMatchType != "simple"
                || !tables.TryGetValue(constraint.ReferencedTable, out SchemaTableModel? parent)
                || constraint.Columns.Count != constraint.ReferencedColumns.Count)
                throw new InvalidOperationException("current_schema_bootstrap_recipe_foreign_key_invalid");
            RequireColumns(parent, constraint.ReferencedColumns);
            clause = $"FOREIGN KEY ({Columns(constraint.Columns)}) REFERENCES {Identifier(parent.Name)} ({Columns(constraint.ReferencedColumns)}) ON UPDATE {Action(constraint.ForeignKeyUpdateAction)} ON DELETE {Action(constraint.ForeignKeyDeleteAction)}";
        }
        else
            clause = constraint.Kind switch
            {
                "primary-key" => $"PRIMARY KEY ({Columns(constraint.Columns)})",
                "unique" => $"UNIQUE ({Columns(constraint.Columns)})",
                "check" when constraint.Columns.Count == 0 && !constraint.IsDeferrable => $"CHECK ({Expression(constraint.Expression)})",
                _ => throw new InvalidOperationException("current_schema_bootstrap_recipe_constraint_capability_unavailable")
            };
        string state = constraint.IsDeferrable
            ? constraint.IsInitiallyDeferred ? " DEFERRABLE INITIALLY DEFERRED" : " DEFERRABLE INITIALLY IMMEDIATE" : "";
        return $"CONSTRAINT {Identifier(constraint.Name)} {clause}{state}";
    }

    private static string Digest(string value)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value))).ToLowerInvariant();
}
