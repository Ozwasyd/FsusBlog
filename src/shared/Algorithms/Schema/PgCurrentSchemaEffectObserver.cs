using System.Data;
using System.Data.Common;
using System.Text.RegularExpressions;

using FsusBlog.Contracts.Schema;

namespace FsusBlog.Shared.Algorithms.Schema;

/// <summary>Untruncated native expression and actual column/sequence dependencies.</summary>
public sealed record PgCurrentRawExpression(string Kind, string Table, string Name, string Expression, string[] Columns, string[] SequenceReferences);
/// <summary>One actual native index expression and its result representation; Columns measures the complete index's source dependencies.</summary>
public sealed record PgCurrentIndexExpression(string Table, string Index, int Position, string Expression, string PhysicalType, string[] Columns);
/// <summary>Native unowned sequence configuration, not its mutable current value.</summary>
public sealed record PgCurrentSequence(string Name, string DataType, long Start, long Increment, long Minimum, long Maximum, long Cache, bool Cyclic);
/// <summary>Native function body and full current-contract execution/security semantics.</summary>
public sealed record PgCurrentFunction(string Name, string Language, string ReturnType, int ArgumentCount, string Body,
    string Volatility, bool Strict, bool SecurityDefiner, string Parallel, bool Leakproof, string? Configuration,
    string Kind = "f", bool ReturnsSet = false, bool Variadic = false, int DefaultArguments = 0, string? AllArgumentTypes = null,
    string? ArgumentModes = null);
/// <summary>Native trigger identity, invocation shape and enabled/constraint semantics.</summary>
public sealed record PgCurrentTrigger(string Table, string Name, string Function, int Type, string Enabled, string? Condition,
    int ArgumentCount, string ArgumentsHex, bool Constraint, bool Deferrable, bool InitiallyDeferred, string? OldTable, string? NewTable,
    string ColumnNumbers = "", bool IsClone = false);
/// <summary>Actual current PostgreSQL expression/effect facts and their string interpretation context.</summary>
public sealed record PgCurrentSchemaEffectObservation(bool StandardConformingStrings,
    IReadOnlyList<PgCurrentRawExpression> Expressions, IReadOnlyList<PgCurrentSequence> Sequences,
    IReadOnlyList<PgCurrentFunction> Functions, IReadOnlyList<PgCurrentTrigger> Triggers)
{
    /// <summary>Raw expression keys and actual dependencies, measured on the same caller-owned RR snapshot.</summary>
    public IReadOnlyList<PgCurrentIndexExpression> IndexExpressions { get; init; } = [];
}

// Generic actual catalog measurement on the caller's sole native snapshot. Raw
// expression/body bytes remain available; no truncated default substitutes for them.
/// <summary>Measures complete actual current effects on the caller's sole native snapshot; never issues admission.</summary>
public static class PgCurrentSchemaEffectObserver
{
    /// <summary>Reads raw expressions and sequence/function/trigger facts on the existing native RR transaction.</summary>
    public static Task<PgCurrentSchemaEffectObservation> ReadAsync(
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
        => ReadCoreAsync(connection, transaction, cancellationToken, null);

    /// <summary>Measures every expression and trigger on one control table; global functions and unowned sequences are not its properties.</summary>
    /// <param name="connection">The actual open PostgreSQL connection.</param>
    /// <param name="transaction">Its same caller-owned RepeatableRead transaction.</param>
    /// <param name="tableName">The explicit measured control table, not a name-based shape admission.</param>
    /// <param name="cancellationToken">The original caller's cancellation boundary.</param>
    /// <returns>Every raw expression and attached trigger on that table.</returns>
    public static Task<PgCurrentSchemaEffectObservation> ReadControlTableAsync(
        DbConnection connection, DbTransaction transaction, string tableName, CancellationToken cancellationToken)
        => ReadCoreAsync(connection, transaction, cancellationToken,
            CurrentSchemaCanonicalAuthority.NormalizeIdentifier(tableName));

    private static async Task<PgCurrentSchemaEffectObservation> ReadCoreAsync(
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken, string? tableScope)
    {
        RequireSnapshot(connection, transaction);
        var expressions = new List<PgCurrentRawExpression>();
        DataTable rows = await QueryAsync(connection, transaction, """
            SELECT 'default'::text AS kind, relation.relname AS table_name, attribute.attname AS name,
                   pg_catalog.pg_get_expr(definition.adbin, definition.adrelid) AS expression,
                   NULL::text AS columns,
                   (SELECT string_agg(sequence_namespace.nspname || '.' || sequence_relation.relname, ',' ORDER BY sequence_relation.oid)
                    FROM pg_catalog.pg_depend AS dependency
                    JOIN pg_catalog.pg_class AS sequence_relation ON sequence_relation.oid = dependency.refobjid AND sequence_relation.relkind = 'S'
                    JOIN pg_catalog.pg_namespace AS sequence_namespace ON sequence_namespace.oid = sequence_relation.relnamespace
                    WHERE dependency.classid = 'pg_catalog.pg_attrdef'::regclass AND dependency.objid = definition.oid
                      AND dependency.refclassid = 'pg_catalog.pg_class'::regclass) AS sequence_references
            FROM pg_catalog.pg_attrdef AS definition
            JOIN pg_catalog.pg_class AS relation ON relation.oid = definition.adrelid
            JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = definition.adrelid AND attribute.attnum = definition.adnum
            WHERE namespace.nspname = 'public' AND relation.relkind = 'r'
            UNION ALL
            SELECT 'check', relation.relname, constraint_meta.conname,
                   pg_catalog.pg_get_expr(constraint_meta.conbin, constraint_meta.conrelid),
                   (SELECT string_agg(attribute.attname, ',' ORDER BY item.ordinality)
                    FROM unnest(constraint_meta.conkey) WITH ORDINALITY AS item(number, ordinality)
                    JOIN pg_catalog.pg_attribute AS attribute ON attribute.attrelid = relation.oid AND attribute.attnum = item.number), NULL::text
            FROM pg_catalog.pg_constraint AS constraint_meta
            JOIN pg_catalog.pg_class AS relation ON relation.oid = constraint_meta.conrelid
            JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public' AND relation.relkind = 'r' AND constraint_meta.contype = 'c'
            UNION ALL
            SELECT 'index-predicate', relation.relname, index_relation.relname,
                   pg_catalog.pg_get_expr(index_meta.indpred, index_meta.indrelid), NULL::text, NULL::text
            FROM pg_catalog.pg_index AS index_meta
            JOIN pg_catalog.pg_class AS relation ON relation.oid = index_meta.indrelid
            JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            JOIN pg_catalog.pg_class AS index_relation ON index_relation.oid = index_meta.indexrelid
            WHERE namespace.nspname = 'public' AND relation.relkind = 'r' AND index_meta.indpred IS NOT NULL
            ORDER BY kind, table_name, name;
            """, cancellationToken, tableScope).ConfigureAwait(false);
        foreach (DataRow row in rows.Rows)
        {
            if (tableScope is not null && Text(row, "table_name") != tableScope)
                continue;
            expressions.Add(new(Text(row, "kind"), Text(row, "table_name"), Text(row, "name"), Text(row, "expression"),
                Optional(row, "columns")?.Split(',', StringSplitOptions.RemoveEmptyEntries) ?? [],
                Optional(row, "sequence_references")?.Split(',', StringSplitOptions.RemoveEmptyEntries) ?? []));
        }
        var sequences = new List<PgCurrentSequence>();
        rows = tableScope is null ? await QueryAsync(connection, transaction, """
            SELECT relation.relname AS name, pg_catalog.format_type(sequence.seqtypid, NULL) AS data_type,
                   sequence.seqstart AS start, sequence.seqincrement AS increment,
                   sequence.seqmin AS minimum, sequence.seqmax AS maximum, sequence.seqcache AS cache, sequence.seqcycle AS cyclic
            FROM pg_catalog.pg_sequence AS sequence
            JOIN pg_catalog.pg_class AS relation ON relation.oid = sequence.seqrelid
            JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            WHERE namespace.nspname = 'public' AND NOT EXISTS (
                SELECT 1 FROM pg_catalog.pg_depend AS dependency
                WHERE dependency.classid = 'pg_catalog.pg_class'::regclass AND dependency.objid = relation.oid
                  AND dependency.refclassid = 'pg_catalog.pg_class'::regclass AND dependency.deptype IN ('a', 'i'))
            ORDER BY relation.relname;
            """, cancellationToken).ConfigureAwait(false) : new DataTable();
        foreach (DataRow row in rows.Rows)
        {
            if (tableScope is not null)
                continue;
            sequences.Add(new(Text(row, "name"), Text(row, "data_type"), Convert.ToInt64(row["start"]), Convert.ToInt64(row["increment"]),
                Convert.ToInt64(row["minimum"]), Convert.ToInt64(row["maximum"]), Convert.ToInt64(row["cache"]), Convert.ToBoolean(row["cyclic"])));
        }
        var functions = new List<PgCurrentFunction>();
        rows = tableScope is null ? await QueryAsync(connection, transaction, """
            SELECT function.proname AS name, language.lanname AS language,
                   pg_catalog.format_type(function.prorettype, NULL) AS return_type,
                   function.pronargs::integer AS argument_count, function.prosrc AS body,
                   function.provolatile::text AS volatility, function.proisstrict AS strict,
                   function.prosecdef AS security_definer, function.proparallel::text AS parallel,
                   function.proleakproof AS leakproof, function.proconfig::text AS configuration,
                   function.prokind::text AS kind, function.proretset AS returns_set,
                   function.provariadic <> 0 AS variadic, function.pronargdefaults::integer AS default_arguments,
                   function.proallargtypes::text AS all_argument_types, function.proargmodes::text AS argument_modes
            FROM pg_catalog.pg_proc AS function
            JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = function.pronamespace
            JOIN pg_catalog.pg_language AS language ON language.oid = function.prolang
            WHERE namespace.nspname = 'public'
            ORDER BY function.proname, function.oid;
            """, cancellationToken).ConfigureAwait(false) : new DataTable();
        foreach (DataRow row in rows.Rows)
        {
            if (tableScope is not null)
                continue;
            functions.Add(new(Text(row, "name"), Text(row, "language"), Text(row, "return_type"), Convert.ToInt32(row["argument_count"]), Text(row, "body"),
                Text(row, "volatility"), Convert.ToBoolean(row["strict"]), Convert.ToBoolean(row["security_definer"]), Text(row, "parallel"),
                Convert.ToBoolean(row["leakproof"]), Optional(row, "configuration"), Text(row, "kind"), Convert.ToBoolean(row["returns_set"]),
                Convert.ToBoolean(row["variadic"]), Convert.ToInt32(row["default_arguments"]), Optional(row, "all_argument_types"), Optional(row, "argument_modes")));
        }
        var triggers = new List<PgCurrentTrigger>();
        rows = await QueryAsync(connection, transaction, """
            SELECT relation.relname AS table_name, trigger.tgname AS name, function.proname AS function_name,
                   trigger.tgtype::integer AS type, trigger.tgenabled::text AS enabled,
                   pg_catalog.pg_get_expr(trigger.tgqual, trigger.tgrelid) AS condition,
                   trigger.tgnargs::integer AS argument_count, encode(trigger.tgargs, 'hex') AS arguments_hex,
                   trigger.tgconstraint <> 0 AS is_constraint, trigger.tgdeferrable AS deferrable,
                   trigger.tginitdeferred AS initially_deferred, trigger.tgoldtable AS old_table, trigger.tgnewtable AS new_table,
                   function_namespace.nspname AS function_schema,
                   trigger.tgattr::text AS column_numbers, trigger.tgparentid <> 0 AS is_clone
            FROM pg_catalog.pg_trigger AS trigger
            JOIN pg_catalog.pg_class AS relation ON relation.oid = trigger.tgrelid
            JOIN pg_catalog.pg_namespace AS namespace ON namespace.oid = relation.relnamespace
            JOIN pg_catalog.pg_proc AS function ON function.oid = trigger.tgfoid
            JOIN pg_catalog.pg_namespace AS function_namespace ON function_namespace.oid = function.pronamespace
            WHERE namespace.nspname = 'public' AND NOT trigger.tgisinternal
            ORDER BY relation.relname, trigger.tgname;
            """, cancellationToken, tableScope).ConfigureAwait(false);
        foreach (DataRow row in rows.Rows)
        {
            if (tableScope is not null && Text(row, "table_name") != tableScope)
                continue;
            if (Text(row, "function_schema") != "public")
                throw new InvalidOperationException("current_schema_pg_trigger_function_schema_unknown");
            triggers.Add(new(Text(row, "table_name"), Text(row, "name"), Text(row, "function_name"), Convert.ToInt32(row["type"]), Text(row, "enabled"),
                Optional(row, "condition"), Convert.ToInt32(row["argument_count"]), Text(row, "arguments_hex"), Convert.ToBoolean(row["is_constraint"]),
                Convert.ToBoolean(row["deferrable"]), Convert.ToBoolean(row["initially_deferred"]), Optional(row, "old_table"), Optional(row, "new_table"),
                Text(row, "column_numbers"), Convert.ToBoolean(row["is_clone"])));
        }
        var indexExpressions = new List<PgCurrentIndexExpression>();
        rows = await QueryAsync(connection, transaction, """
            SELECT relation.relname AS table_name, index_relation.relname AS name,
                   position.number AS position,
                   pg_get_indexdef(index_meta.indexrelid, position.number + 1, true) AS expression,
                   format_type(index_column.atttypid, index_column.atttypmod) AS physical_type,
                   COALESCE((SELECT string_agg(DISTINCT source_column.attname, ',' ORDER BY source_column.attname)
                       FROM pg_depend dependency
                       JOIN pg_attribute source_column ON source_column.attrelid = index_meta.indrelid
                           AND source_column.attnum = dependency.refobjsubid
                       WHERE dependency.classid = 'pg_class'::regclass AND dependency.objid = index_meta.indexrelid
                           AND dependency.refclassid = 'pg_class'::regclass AND dependency.refobjid = index_meta.indrelid
                           AND dependency.refobjsubid > 0), '') AS columns
            FROM pg_index index_meta
            JOIN pg_class relation ON relation.oid = index_meta.indrelid
            JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
            JOIN pg_class index_relation ON index_relation.oid = index_meta.indexrelid
            CROSS JOIN LATERAL generate_series(0, index_meta.indnkeyatts - 1) AS position(number)
            JOIN pg_attribute index_column ON index_column.attrelid = index_meta.indexrelid
                AND index_column.attnum = position.number + 1
            WHERE namespace.nspname = 'public' AND relation.relkind = 'r'
                AND index_meta.indexprs IS NOT NULL AND index_meta.indkey[position.number] = 0
            ORDER BY table_name, name, position;
            """, cancellationToken, tableScope).ConfigureAwait(false);
        foreach (DataRow row in rows.Rows)
        {
            if (tableScope is not null && Text(row, "table_name") != tableScope)
                continue;
            indexExpressions.Add(new(Text(row, "table_name"), Text(row, "name"), Convert.ToInt32(row["position"]),
                Text(row, "expression"), Text(row, "physical_type"),
                Text(row, "columns").Split(',', StringSplitOptions.RemoveEmptyEntries)));
        }
        rows = await QueryAsync(connection, transaction, "SELECT current_setting('standard_conforming_strings') AS value;", cancellationToken).ConfigureAwait(false);
        if (rows.Rows.Count != 1 || Text(rows.Rows[0], "value") is not ("on" or "off"))
            throw new InvalidOperationException("current_schema_pg_string_semantics_unobserved");
        return new(Text(rows.Rows[0], "value") == "on", expressions, sequences, functions, triggers)
        {
            IndexExpressions = indexExpressions
        };
    }

    /// <summary>Compares every expected nonrelational effect and rejects unknown, duplicate, missing or altered facts.</summary>
    public static IReadOnlyList<string> CompareEffects(CurrentSchemaCompletePhysicalProjection expected, PgCurrentSchemaEffectObservation actual)
    {
        var errors = new List<string>();
        var sequences = new Dictionary<string, PgCurrentSequence>(StringComparer.Ordinal);
        var functions = new Dictionary<string, PgCurrentFunction>(StringComparer.Ordinal);
        var triggers = new Dictionary<string, PgCurrentTrigger>(StringComparer.Ordinal);
        foreach (CurrentSchemaRecipeOperation effect in expected.SchemaEffects)
        {
            switch (effect.Kind)
            {
                case CurrentSchemaRecipeOperationKind.CreateSequence:
                    sequences[effect.Name] = new(effect.Name, "bigint", 1, 1, 1, long.MaxValue, 1, false);
                    break;
                case CurrentSchemaRecipeOperationKind.DefineImmutableGuard:
                    string? sqlState = CurrentSchemaImmutableEffects.RequireSqlState(effect.SqlState);
                    if (effect != new CurrentSchemaRecipeOperation(effect.Kind, effect.Name, ErrorCode: effect.ErrorCode, SqlState: sqlState))
                        throw new InvalidOperationException("current_schema_pg_guard_unused_fact");
                    functions[effect.Name] = new(effect.Name, "plpgsql", "trigger", 0,
                        GuardIdentity(effect.ErrorCode!, sqlState), "v", false, false, "u", false, null);
                    break;
                case CurrentSchemaRecipeOperationKind.RemoveTrigger:
                    triggers.Remove(effect.Table + "." + effect.Name);
                    break;
                case CurrentSchemaRecipeOperationKind.CreateImmutableTrigger:
                    CurrentSchemaImmutableTriggerFacts trigger = CurrentSchemaImmutableEffects.RequireTrigger(effect.Trigger);
                    if (effect != new CurrentSchemaRecipeOperation(effect.Kind, effect.Name, effect.Table, Function: effect.Function, Trigger: effect.Trigger))
                        throw new InvalidOperationException("current_schema_pg_trigger_unused_fact");
                    int type = trigger.Level == CurrentSchemaTriggerLevel.Statement ? 58 : 27;
                    triggers.Add(effect.Table + "." + effect.Name, new(effect.Table!, effect.Name, effect.Function!, type, "O", null, 0, "", false, false, false, null, null));
                    break;
                default:
                    throw new InvalidOperationException("current_schema_pg_effect_kind_unknown");
            }
        }
        Compare(sequences, actual.Sequences, static value => value.Name, static value => value);
        Compare(functions, actual.Functions, static value => value.Name, static value => value with { Body = ParseReceiptGuard(value.Body) });
        Compare(triggers, actual.Triggers, static value => value.Table + "." + value.Name, static value => value);
        return errors;

        void Compare<T>(IReadOnlyDictionary<string, T> wanted, IReadOnlyList<T> observed, Func<T, string> name, Func<T, T> normalize)
        {
            var seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (T value in observed)
            {
                string key = name(value);
                if (!seen.Add(key) || !wanted.TryGetValue(key, out T? definition))
                {
                    errors.Add("extra_or_duplicate_effect:" + key);
                    continue;
                }
                if (!EqualityComparer<T>.Default.Equals(definition, normalize(value)))
                    errors.Add("effect_changed:" + key);
            }
            foreach (string key in wanted.Keys.Except(seen, StringComparer.Ordinal))
                errors.Add("effect_missing:" + key);
        }
    }

    /// <summary>Decodes only the original immutable guard body grammar; unrelated executable bodies refuse.</summary>
    public static string ParseGuard(string body)
    {
        Match match = Regex.Match(body, "^\\s*BEGIN\\s+RAISE\\s+EXCEPTION\\s+'(?<code>[a-z_][a-z0-9_]*)'\\s*;\\s*END\\s*;\\s*$",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));
        return match.Success ? match.Groups["code"].Value : throw new InvalidOperationException("current_schema_pg_guard_body_unknown");
    }

    private static string ParseReceiptGuard(string body)
    {
        Match match = Regex.Match(body,
            "^\\s*BEGIN\\s+RAISE\\s+EXCEPTION\\s+'(?<code>[a-z_][a-z0-9_]*)'\\s*(?:USING\\s+ERRCODE\\s*=\\s*'(?<state>[0-9A-Z]{5})'\\s*)?;\\s*END\\s*;?\\s*$",
            RegexOptions.IgnoreCase | RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));
        if (!match.Success)
            throw new InvalidOperationException("current_schema_pg_guard_body_unknown");
        string? sqlState = match.Groups["state"].Success ? match.Groups["state"].Value : null;
        return GuardIdentity(match.Groups["code"].Value, CurrentSchemaImmutableEffects.RequireSqlState(sqlState));
    }

    private static string GuardIdentity(string message, string? sqlState)
        => sqlState is null ? message : message + ":sqlstate:" + sqlState;

    /// <summary>Requires the actual open PostgreSQL connection and its same RepeatableRead transaction.</summary>
    public static void RequireSnapshot(DbConnection connection, DbTransaction transaction)
    {
        if (connection.GetType().FullName != "Npgsql.NpgsqlConnection" || connection.State != ConnectionState.Open
            || !ReferenceEquals(transaction.Connection, connection) || transaction.IsolationLevel != IsolationLevel.RepeatableRead)
            throw new InvalidOperationException("current_schema_pg_effect_snapshot_mismatch");
    }

    private static async Task<DataTable> QueryAsync(DbConnection connection, DbTransaction transaction, string sql,
        CancellationToken cancellationToken, string? tableScope = null)
    {
        cancellationToken.ThrowIfCancellationRequested();
        await using DbCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = tableScope is null ? sql
            : $"SELECT * FROM ({sql.TrimEnd().TrimEnd(';')}) AS current_table_facts WHERE table_name = @current_table;";
        if (tableScope is not null)
        {
            DbParameter parameter = command.CreateParameter();
            parameter.ParameterName = "@current_table";
            parameter.Value = tableScope;
            command.Parameters.Add(parameter);
        }
        await using DbDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        var table = new DataTable();
        for (int index = 0; index < reader.FieldCount; index++)
            table.Columns.Add(reader.GetName(index), reader.GetFieldType(index));
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            var values = new object[reader.FieldCount];
            reader.GetValues(values);
            table.Rows.Add(values);
        }
        return table;
    }

    private static string Text(DataRow row, string name) => Optional(row, name) ?? throw new InvalidOperationException("current_schema_pg_catalog_field_missing");
    private static string? Optional(DataRow row, string name) => row[name] is DBNull ? null : Convert.ToString(row[name]);
}
