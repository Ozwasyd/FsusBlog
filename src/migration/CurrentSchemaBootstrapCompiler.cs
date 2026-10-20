using System.Collections.ObjectModel;
using System.Data.Common;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

using FsusBlog.Contracts.Schema;

namespace FsusBlog.Migration;

/// <summary>Frozen commands compiled from the sole current facts, not an apply grant.</summary>
internal sealed record CompiledCurrentSchemaBootstrap(
    SchemaProviderKind Provider,
    CurrentSchemaIdentity Target,
    IReadOnlyList<SchemaMigrationCommand> Commands,
    string CommandDigest);

/// <summary>
/// Current bootstrap operation owner. It neither reconstructs business mapping
/// nor loads Server; callers must supply independently bound owned current input.
/// </summary>
internal static partial class CurrentSchemaBootstrapCompiler
{
    internal static CompiledCurrentSchemaBootstrap Compile(
        CurrentSchemaBootstrapInput input,
        CurrentSchemaProducerIdentity expectedOwner,
        SchemaProviderKind provider,
        string? expectedOwnedInputDigest = null)
    {
        ArgumentNullException.ThrowIfNull(input);
        if (input.Producer != expectedOwner || input.Producer.ProducerId != "fsusblog.current-schema-owned-projection.v1"
            || !IsDigest(input.Producer.ProducerAssemblySha256) || !IsDigest(input.Producer.ContractAssemblySha256)
            || input.Producer.SourceCommit.Length != 40
            || input.Producer.SourceCommit.All(static value => value == '0')
            || input.Producer.SourceCommit.Any(static value => value is not (>= '0' and <= '9' or >= 'a' and <= 'f')))
        {
            throw new InvalidOperationException("current_schema_bootstrap_owner_binding_invalid");
        }
        if (input.RequiredRecipes.Select(static recipe => recipe.TableName).Distinct(StringComparer.Ordinal).Count()
            != input.RequiredRecipes.Count || input.RequiredRecipes.Any(static recipe => !IsDigest(recipe.RecipeDigest)))
        {
            throw new InvalidOperationException("current_schema_bootstrap_recipe_binding_invalid");
        }
        if (input.RequiredRecipes.Count == 0)
        {
            throw new InvalidOperationException("current_schema_bootstrap_recipe_closure_unavailable");
        }
        string[] missing = input.RequiredRecipes.Where(static recipe => recipe.SemanticDescription is null)
            .Select(static recipe => recipe.TableName).Order(StringComparer.Ordinal).ToArray();
        if (missing.Length > 0)
        {
            throw new InvalidOperationException($"current_schema_bootstrap_recipe_semantics_unavailable:{string.Join(',', missing)}");
        }
        // The caller's verified owned artifact supplies this digest. Matching
        // self-reported producer strings alone is not a recipe-source binding.
        if (!IsDigest(expectedOwnedInputDigest!) || expectedOwnedInputDigest != OwnedInputDigest(input))
        {
            throw new InvalidOperationException("current_schema_bootstrap_recipe_semantic_binding_invalid");
        }
        return CompileOwnedRecipes(input, provider);
    }

    internal static CompiledCurrentSchemaBootstrap CompileEntityProjection(
        CurrentSchemaProjection projection,
        SchemaProviderKind provider)
    {
        ArgumentNullException.ThrowIfNull(projection);
        CurrentSchemaCanonicalAuthority.VerifyIdentity(projection.Schema, projection.Identity);
        if (projection.Schema.Provider != SchemaProviderKind.Semantic || projection.Schema.Tables.Count == 0)
        {
            throw new InvalidOperationException("current_schema_bootstrap_semantic_input_required");
        }
        if (provider != SchemaProviderKind.PostgreSql)
        {
            throw new InvalidOperationException($"current_schema_bootstrap_provider_capability_not_implemented:{provider}");
        }
        SchemaModelSnapshot physical = CurrentSchemaCanonicalAuthority.ProjectProvider(
            new CurrentSchemaCanonicalModel(projection.Schema, projection.Identity), provider);
        var commands = new List<SchemaMigrationCommand>();
        foreach ((string tableName, SchemaTableModel table) in physical.Tables.OrderBy(static item => item.Key, StringComparer.Ordinal))
        {
            if (tableName != table.Name || table.Columns.Count == 0)
            {
                throw new InvalidOperationException("current_schema_bootstrap_table_description_invalid");
            }
            var definitions = new List<string>();
            foreach ((string columnName, SchemaColumnModel column) in table.Columns.OrderBy(static item => item.Key, StringComparer.Ordinal))
            {
                if (columnName != column.Name || column.ComputedExpression is not null
                    || column.Conversion is not (null or "none" or "json"))
                {
                    throw new InvalidOperationException($"current_schema_bootstrap_column_capability_unavailable:{tableName}.{columnName}");
                }
                string type = PhysicalType(column);
                string definition = $"{Identifier(columnName)} {type} {(column.IsNullable ? "NULL" : "NOT NULL")}";
                if (column.DefaultValue is not null)
                {
                    if (column.IsIdentity)
                    {
                        throw new InvalidOperationException("current_schema_bootstrap_identity_default_conflict");
                    }
                    definition += $" DEFAULT {EntityDefaultValue(column)}";
                }
                definitions.Add(definition);
            }
            foreach (SchemaConstraintModel constraint in table.Constraints.Values.OrderBy(static item => item.Name, StringComparer.Ordinal))
            {
                RequireColumns(table, constraint.Columns);
                if (constraint.Kind == "foreign-key")
                {
                    continue;
                }
                if (constraint.Kind == "unique" && table.IndexDefinitions.TryGetValue(constraint.Name, out SchemaIndexModel? index)
                    && index.IsUnique && index.Keys.Select(static key => key.Column).SequenceEqual(constraint.Columns))
                {
                    if (!constraint.IsValidated || constraint.IsDeferrable || constraint.IsInitiallyDeferred)
                    {
                        throw new InvalidOperationException("current_schema_bootstrap_constraint_state_capability_unavailable");
                    }
                    continue;
                }
                string clause = constraint.Kind switch
                {
                    "primary-key" => $"PRIMARY KEY ({Columns(constraint.Columns)})",
                    "unique" => $"UNIQUE ({Columns(constraint.Columns)})",
                    "check" => $"CHECK ({Expression(constraint.Expression)})",
                    _ => throw new InvalidOperationException($"current_schema_bootstrap_constraint_capability_unavailable:{constraint.Kind}")
                };
                if (!constraint.IsValidated || constraint.IsDeferrable || constraint.IsInitiallyDeferred)
                {
                    throw new InvalidOperationException("current_schema_bootstrap_constraint_state_capability_unavailable");
                }
                definitions.Add($"CONSTRAINT {Identifier(constraint.Name)} {clause}");
            }
            commands.Add(new SchemaMigrationCommand(
                $"CREATE TABLE {Identifier(tableName)} ({string.Join(", ", definitions)});", IsDdl: true));
        }
        // All tables exist before foreign keys, including cyclic current references.
        foreach ((string tableName, SchemaTableModel table) in physical.Tables.OrderBy(static item => item.Key, StringComparer.Ordinal))
        {
            foreach (SchemaConstraintModel constraint in table.Constraints.Values.Where(static value => value.Kind == "foreign-key")
                .OrderBy(static value => value.Name, StringComparer.Ordinal))
            {
                if (constraint.ReferencedTable is null || constraint.ReferencedColumns is null
                    || constraint.Columns.Count != constraint.ReferencedColumns.Count
                    || constraint.ReferencedSchema is not (null or "public")
                    || !physical.Tables.TryGetValue(constraint.ReferencedTable, out SchemaTableModel? parent))
                {
                    throw new InvalidOperationException("current_schema_bootstrap_foreign_key_target_invalid");
                }
                RequireColumns(parent, constraint.ReferencedColumns);
                string suffix = constraint.IsDeferrable
                    ? constraint.IsInitiallyDeferred ? " DEFERRABLE INITIALLY DEFERRED" : " DEFERRABLE INITIALLY IMMEDIATE"
                    : constraint.IsInitiallyDeferred ? throw new InvalidOperationException("current_schema_bootstrap_constraint_state_invalid") : "";
                if (!constraint.IsValidated)
                    suffix += " NOT VALID";
                string match = constraint.ForeignKeyMatchType is null or "simple" ? "SIMPLE"
                    : constraint.ForeignKeyMatchType == "full" ? "FULL"
                    : throw new InvalidOperationException("current_schema_bootstrap_foreign_key_match_unavailable");
                commands.Add(new SchemaMigrationCommand(
                    $"ALTER TABLE {Identifier(tableName)} ADD CONSTRAINT {Identifier(constraint.Name)} FOREIGN KEY ({Columns(constraint.Columns)}) REFERENCES {Identifier(parent.Name)} ({Columns(constraint.ReferencedColumns)}) MATCH {match} ON UPDATE {Action(constraint.ForeignKeyUpdateAction)} ON DELETE {Action(constraint.ForeignKeyDeleteAction)}{suffix};",
                    IsDdl: true));
            }
            if (!table.Indexes.SetEquals(table.IndexDefinitions.Keys))
            {
                throw new InvalidOperationException("current_schema_bootstrap_index_description_incomplete");
            }
            foreach (SchemaIndexModel index in table.IndexDefinitions.Values.OrderBy(static value => value.Name, StringComparer.Ordinal))
            {
                if (index.Keys.Count == 0 || index.AccessMethod != "btree")
                {
                    throw new InvalidOperationException("current_schema_bootstrap_index_method_unavailable");
                }
                RequireColumns(table, index.Keys.Select(static key => key.Column).ToArray());
                RequireColumns(table, index.IncludedColumns, allowEmpty: true);
                string[] keys = index.Keys.Select(key =>
                {
                    string direction = key.Direction is "asc" or "desc" ? key.Direction.ToUpperInvariant()
                        : throw new InvalidOperationException("current_schema_bootstrap_index_direction_invalid");
                    string nulls = key.NullPlacement is "first" or "last" ? key.NullPlacement.ToUpperInvariant()
                        : throw new InvalidOperationException("current_schema_bootstrap_index_nulls_invalid");
                    string collation = key.Collation == "default" ? "" : $" COLLATE {QualifiedIdentifier(key.Collation)}";
                    string opclass = key.OperatorClass == "default" ? "" : $" {QualifiedIdentifier(key.OperatorClass)}";
                    return $"{Identifier(key.Column)}{collation}{opclass} {direction} NULLS {nulls}";
                }).ToArray();
                string include = index.IncludedColumns.Count == 0 ? "" : $" INCLUDE ({Columns(index.IncludedColumns)})";
                string predicate = index.Predicate is null ? "" : $" WHERE {Expression(index.Predicate)}";
                string distinct = index.NullsNotDistinct ? " NULLS NOT DISTINCT" : "";
                if (index.NullsNotDistinct && !index.IsUnique)
                {
                    throw new InvalidOperationException("current_schema_bootstrap_index_nulls_distinct_invalid");
                }
                commands.Add(new SchemaMigrationCommand(
                    $"CREATE {(index.IsUnique ? "UNIQUE " : "")}INDEX {Identifier(index.Name)} ON {Identifier(tableName)} USING btree ({string.Join(", ", keys)}){include}{distinct}{predicate};", IsDdl: true));
            }
        }
        var frozen = new ReadOnlyCollection<SchemaMigrationCommand>(commands);
        string digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(frozen)))).ToLowerInvariant();
        return new CompiledCurrentSchemaBootstrap(provider, projection.Identity, frozen, digest);
    }

    /// <summary>
    /// Executes compiled commands on the original caller-owned transaction. It
    /// opens no connection and performs no commit, journal write or apply admission.
    /// </summary>
    internal static async Task ExecuteAsync(
        CompiledCurrentSchemaBootstrap compiled,
        DbConnection connection,
        DbTransaction transaction,
        CancellationToken cancellationToken)
    {
        if (compiled.Provider != SchemaProviderKind.PostgreSql
            || connection.GetType().FullName != "Npgsql.NpgsqlConnection"
            || !ReferenceEquals(transaction.Connection, connection))
        {
            throw new InvalidOperationException("current_schema_bootstrap_native_transaction_mismatch");
        }
        string actualDigest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(compiled.Commands)))).ToLowerInvariant();
        if (compiled.CommandDigest != actualDigest)
        {
            throw new InvalidOperationException("current_schema_bootstrap_compiled_commands_changed");
        }
        foreach (SchemaMigrationCommand item in compiled.Commands)
        {
            cancellationToken.ThrowIfCancellationRequested();
            await using DbCommand command = connection.CreateCommand();
            command.Transaction = transaction;
            command.CommandText = item.Sql;
            await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
        }
    }

    private static bool IsDigest(string value)
        => value is not null && Regex.IsMatch(value, "^[a-f0-9]{64}$", RegexOptions.CultureInvariant);

    private static string Identifier(string value)
        => Regex.IsMatch(value, "^[a-z_][a-z0-9_]{0,62}$", RegexOptions.CultureInvariant)
            ? $"\"{value}\"" : throw new InvalidOperationException("current_schema_bootstrap_identifier_invalid");

    private static string QualifiedIdentifier(string value)
        => string.Join('.', value.Split('.').Select(Identifier));

    private static string Columns(IReadOnlyList<string> values) => string.Join(", ", values.Select(Identifier));

    private static void RequireColumns(SchemaTableModel table, IReadOnlyList<string> values, bool allowEmpty = false)
    {
        if ((!allowEmpty && values.Count == 0) || values.Distinct(StringComparer.Ordinal).Count() != values.Count
            || values.Any(value => !table.Columns.ContainsKey(value)))
        {
            throw new InvalidOperationException("current_schema_bootstrap_constraint_columns_invalid");
        }
    }

    private static string PhysicalType(SchemaColumnModel column)
    {
        if (column.IsIdentity)
        {
            if (column.OwnedSequence is null || column.GenerationKind != "owned-sequence-default")
            {
                throw new InvalidOperationException("current_schema_bootstrap_identity_owner_incomplete");
            }
            _ = Identifier(column.OwnedSequence.Name);
            return column.DataType switch
            {
                "int16" => "smallserial",
                "int32" => "serial",
                "int64" => "bigserial",
                _ => throw new InvalidOperationException("current_schema_bootstrap_identity_type_unavailable")
            };
        }
        string value = column.PhysicalType ?? throw new InvalidOperationException("current_schema_bootstrap_physical_type_missing");
        return Regex.IsMatch(value,
            "^(?:smallint|integer(?:\\[\\])?|bigint|boolean|text|bytea|uuid|jsonb|real|double precision|numeric(?:\\([0-9]+(?:,[0-9]+)?\\))?|date|time(?:\\([0-9]+\\))?(?: without time zone)?|timestamp(?:\\([0-9]+\\))?(?: without time zone| with time zone)?|character varying\\([1-9][0-9]*\\))$",
            RegexOptions.CultureInvariant) ? value : throw new InvalidOperationException($"current_schema_bootstrap_physical_type_unavailable:{value}");
    }

    private static string DefaultValue(string value)
        => Regex.IsMatch(value, "^(?:-?[0-9]+(?:\\.[0-9]+)?|true|false|NULL|'(?:[^']|'')*'|now\\(\\)|CURRENT_TIMESTAMP)$",
            RegexOptions.CultureInvariant | RegexOptions.IgnoreCase) ? value
            : throw new InvalidOperationException("current_schema_bootstrap_default_capability_unavailable");

    internal static string EntityDefaultValue(SchemaColumnModel column)
    {
        string value = column.DefaultValue!;
        // SugarColumn string defaults are literal values, not a second list of
        // business statuses. The current column type supplies this interpretation.
        if (column.DataType == "string" && Regex.IsMatch(value, "^[A-Za-z_][A-Za-z0-9_ .-]*$", RegexOptions.CultureInvariant)
            && !value.Equals("NULL", StringComparison.OrdinalIgnoreCase))
            return "'" + value.Replace("'", "''", StringComparison.Ordinal) + "'";
        return DefaultValue(value);
    }

    private static string Expression(string? value)
        => !string.IsNullOrWhiteSpace(value) && !value.Contains(';') && !value.Contains("--", StringComparison.Ordinal)
            && !value.Contains("/*", StringComparison.Ordinal) ? value
            : throw new InvalidOperationException("current_schema_bootstrap_expression_capability_unavailable");

    private static string Action(string? value)
        => value switch
        {
            null or "no-action" => "NO ACTION",
            "restrict" => "RESTRICT",
            "cascade" => "CASCADE",
            "set-null" => "SET NULL",
            "set-default" => "SET DEFAULT",
            _ => throw new InvalidOperationException("current_schema_bootstrap_foreign_key_action_unavailable")
        };
}
