using System.Data;
using System.Data.Common;
using System.Text.Json;

using FsusBlog.Contracts.Schema;

namespace FsusBlog.Shared.Algorithms.Schema;

/// <summary>
/// Single current-schema algorithm measuring the actual PostgreSQL catalog, not a current
/// expected-schema producer. It uses only the caller's open native RR session and
/// leaves connection, transaction, commit, target authority and admission ownership
/// with the original caller. SQL never enters the neutral Shared contracts.
/// </summary>
public static class PgCurrentSchemaCatalogObserver
{
    /// <summary>Reads all public relational catalog facts on the caller's open PostgreSQL RR transaction.</summary>
    public static Task<SchemaModelSnapshot> ReadAsync(
        DbConnection connection,
        DbTransaction transaction,
        CancellationToken cancellationToken)
        => ReadCoreAsync(connection, transaction, cancellationToken, null);

    /// <summary>Measures one actual table with the same complete decoder, before a legacy source becomes current.</summary>
    /// <param name="connection">The actual open PostgreSQL connection.</param>
    /// <param name="transaction">Its same caller-owned RepeatableRead transaction.</param>
    /// <param name="tableName">The explicit measured table, not an allowed-extra-table grant.</param>
    /// <param name="cancellationToken">The original caller's cancellation boundary.</param>
    /// <returns>Every actual column, constraint and index of the selected table.</returns>
    public static Task<SchemaModelSnapshot> ReadTableAsync(
        DbConnection connection, DbTransaction transaction, string tableName, CancellationToken cancellationToken)
        => ReadCoreAsync(connection, transaction, cancellationToken,
            CurrentSchemaCanonicalAuthority.NormalizeIdentifier(tableName));

    private static async Task<SchemaModelSnapshot> ReadCoreAsync(
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken, string? tableScope)
    {
        ArgumentNullException.ThrowIfNull(connection);
        ArgumentNullException.ThrowIfNull(transaction);
        cancellationToken.ThrowIfCancellationRequested();
        if (connection.GetType().FullName != "Npgsql.NpgsqlConnection" || connection.State != ConnectionState.Open
            || !ReferenceEquals(transaction.Connection, connection)
            || transaction.IsolationLevel != IsolationLevel.RepeatableRead)
        {
            throw new InvalidOperationException("current_schema_native_catalog_transaction_mismatch");
        }
        DataTable tableRows = await QueryAsync(connection, transaction, """
            SELECT tables.table_name, relation.relkind::text AS relation_kind,
                relation.relpersistence::text AS persistence, relation.relispartition AS is_partition,
                relation.relrowsecurity AS row_security, relation.relforcerowsecurity AS force_row_security,
                EXISTS (SELECT 1 FROM pg_inherits inheritance
                    WHERE inheritance.inhrelid = relation.oid OR inheritance.inhparent = relation.oid) AS has_inheritance,
                EXISTS (SELECT 1 FROM pg_rewrite rule WHERE rule.ev_class = relation.oid) AS has_rules,
                EXISTS (SELECT 1 FROM pg_trigger trigger WHERE trigger.tgrelid = relation.oid) AS has_triggers
            FROM information_schema.tables tables
            JOIN pg_namespace namespace ON namespace.nspname = tables.table_schema
            JOIN pg_class relation ON relation.relnamespace = namespace.oid AND relation.relname = tables.table_name
            WHERE tables.table_schema = 'public' AND tables.table_type = 'BASE TABLE';
            """, cancellationToken, tableScope).ConfigureAwait(false);

        var tables = new Dictionary<string, SchemaTableModel>(StringComparer.Ordinal);
        foreach (DataRow row in tableRows.Rows)
        {
            string tableName = CurrentSchemaCanonicalAuthority.NormalizeIdentifier(Convert.ToString(row["table_name"])!);
            if (tableScope is not null && tableName != tableScope) continue;
            if (tableName == CurrentSchemaControlShape.ApplyJournalTableName)
            {
                CurrentSchemaControlTableFacts control = CurrentSchemaControlShape.DescribeApplyJournalFacts();
                if (Convert.ToString(row["relation_kind"]) != control.RelationKind || Convert.ToString(row["persistence"]) != control.Persistence
                    || Convert.ToBoolean(row["is_partition"]) != control.IsPartition || Convert.ToBoolean(row["row_security"]) != control.RowSecurity
                    || Convert.ToBoolean(row["force_row_security"]) != control.ForceRowSecurity || Convert.ToBoolean(row["has_inheritance"]) != control.HasInheritance
                    || Convert.ToBoolean(row["has_rules"]) != control.HasRules || Convert.ToBoolean(row["has_triggers"]) != control.HasTriggers)
                    throw new InvalidOperationException("current_schema_control_relation_effect_unavailable");
            }
            tables[tableName] = NewActualTable(tableName, [], []);
        }

        DataTable columnRows = await QueryAsync(connection, transaction, """
            SELECT
                c.table_name,
                c.column_name,
                c.is_nullable,
                CASE
                    WHEN type_meta.typtype = 'd'
                    THEN format_type(type_meta.typbasetype, type_meta.typtypmod)
                    ELSE c.data_type
                END AS semantic_data_type,
                c.udt_name,
                c.character_maximum_length,
                c.column_default,
                format_type(attribute_meta.atttypid, attribute_meta.atttypmod) AS physical_type,
                CASE
                    WHEN attribute_meta.attcollation = 0 THEN 'n/a'
                    WHEN attribute_meta.attcollation = type_meta.typcollation THEN 'default'
                    ELSE collation_namespace.nspname || '.' || collation_meta.collname
                END AS collation,
                attribute_meta.attidentity::text AS identity_kind,
                sequence_observation.sequence_schema,
                sequence_observation.sequence_name,
                sequence_observation.owned_table,
                sequence_observation.owned_column,
                sequence_observation.sequence_type,
                sequence_observation.start_value,
                sequence_observation.increment_by,
                sequence_observation.min_value,
                sequence_observation.max_value,
                sequence_observation.cache_size,
                sequence_observation.is_cyclic,
                sequence_observation.dependency_type,
                EXISTS (
                    SELECT 1
                    FROM information_schema.table_constraints tc
                    JOIN information_schema.key_column_usage kcu
                      ON tc.constraint_name = kcu.constraint_name
                     AND tc.table_schema = kcu.table_schema
                    WHERE tc.table_schema = 'public'
                      AND tc.table_name = c.table_name
                      AND tc.constraint_type = 'PRIMARY KEY'
                      AND kcu.column_name = c.column_name
                ) AS is_primary_key
            FROM information_schema.columns c
            JOIN pg_namespace table_namespace
              ON table_namespace.nspname = c.table_schema
            JOIN pg_class table_rel
              ON table_rel.relnamespace = table_namespace.oid
             AND table_rel.relname = c.table_name
            JOIN pg_attribute attribute_meta
              ON attribute_meta.attrelid = table_rel.oid
             AND attribute_meta.attname = c.column_name
             AND attribute_meta.attnum > 0
             AND NOT attribute_meta.attisdropped
            JOIN pg_type type_meta
              ON type_meta.oid = attribute_meta.atttypid
            LEFT JOIN pg_collation collation_meta
              ON collation_meta.oid = attribute_meta.attcollation
            LEFT JOIN pg_namespace collation_namespace
              ON collation_namespace.oid = collation_meta.collnamespace
            LEFT JOIN LATERAL (
                SELECT
                    sequence_namespace.nspname AS sequence_schema,
                    sequence_rel.relname AS sequence_name,
                    owner_rel.relname AS owned_table,
                    owner_attribute.attname AS owned_column,
                    format_type(sequence_meta.seqtypid, -1) AS sequence_type,
                    sequence_meta.seqstart AS start_value,
                    sequence_meta.seqincrement AS increment_by,
                    sequence_meta.seqmin AS min_value,
                    sequence_meta.seqmax AS max_value,
                    sequence_meta.seqcache AS cache_size,
                    sequence_meta.seqcycle AS is_cyclic,
                    sequence_dependency.deptype::text AS dependency_type
                FROM pg_class sequence_rel
                JOIN pg_namespace sequence_namespace
                  ON sequence_namespace.oid = sequence_rel.relnamespace
                JOIN pg_sequence sequence_meta
                  ON sequence_meta.seqrelid = sequence_rel.oid
                JOIN pg_depend sequence_dependency
                  ON sequence_dependency.classid = 'pg_class'::regclass
                 AND sequence_dependency.objid = sequence_rel.oid
                 AND sequence_dependency.refclassid = 'pg_class'::regclass
                 AND sequence_dependency.refobjid = table_rel.oid
                 AND sequence_dependency.refobjsubid = attribute_meta.attnum
                 AND sequence_dependency.deptype IN ('a', 'i')
                JOIN pg_class owner_rel
                  ON owner_rel.oid = sequence_dependency.refobjid
                JOIN pg_attribute owner_attribute
                  ON owner_attribute.attrelid = sequence_dependency.refobjid
                 AND owner_attribute.attnum = sequence_dependency.refobjsubid
                WHERE sequence_rel.oid = to_regclass(
                    pg_get_serial_sequence(
                        format('%I.%I', c.table_schema, c.table_name),
                        c.column_name))
            ) sequence_observation ON TRUE
            WHERE c.table_schema = 'public';
            """, cancellationToken, tableScope).ConfigureAwait(false);

        foreach (DataRow row in columnRows.Rows)
        {
            string tableName = CurrentSchemaCanonicalAuthority.NormalizeIdentifier(Convert.ToString(row["table_name"])!);
            if (!tables.TryGetValue(tableName, out SchemaTableModel? table))
            {
                continue;
            }

            string dataType = Convert.ToString(row["semantic_data_type"]) ?? string.Empty;
            string udtName = Convert.ToString(row["udt_name"]) ?? string.Empty;
            string columnName = CurrentSchemaCanonicalAuthority.NormalizeIdentifier(Convert.ToString(row["column_name"])!);
            bool isNullable = string.Equals(Convert.ToString(row["is_nullable"]), "YES", StringComparison.OrdinalIgnoreCase);
            string? rawDefault = row["column_default"] is DBNull ? null : Convert.ToString(row["column_default"]);
            string generationKind = ResolvePostgresGenerationKind(
                Convert.ToString(row["identity_kind"]),
                rawDefault,
                row["sequence_name"] is not DBNull);
            bool isIdentity = generationKind != "none";
            bool isPrimaryKey = Convert.ToBoolean(row["is_primary_key"]);
            int? maxLength = row["character_maximum_length"] is DBNull ? null : Convert.ToInt32(row["character_maximum_length"]);

            SchemaOwnedSequenceModel? ownedSequence = ReadOwnedSequence(
                row,
                tableName,
                columnName,
                generationKind);
            table.Columns[columnName] = new SchemaColumnModel(
                columnName,
                isNullable,
                isPrimaryKey,
                isIdentity,
                maxLength,
                NormalizePostgresSemanticType(dataType, udtName),
                isIdentity ? null : NormalizePostgresDefault(rawDefault),
                "none",
                PhysicalType: NormalizePostgresPhysicalType(
                    Convert.ToString(row["physical_type"]) ?? string.Empty),
                Owner: new SchemaOwnerModel("postgresql", $"public.{tableName}.{columnName}"),
                Collation: NormalizePostgresCollation(Convert.ToString(row["collation"])),
                GenerationKind: generationKind,
                OwnedSequence: ownedSequence);
        }

        var primaryIndexes = new HashSet<string>(StringComparer.Ordinal);
        DataTable indexRows = await QueryAsync(connection, transaction, $"""
            SELECT
                table_rel.relname AS table_name,
                index_rel.relname AS index_name,
                index_meta.indisunique AS is_unique,
                index_meta.indisprimary AS is_primary,
                index_meta.indisvalid AS is_valid,
                index_meta.indisready AS is_ready,
                index_meta.indislive AS is_live,
                access_method.amname AS access_method,
                pg_get_expr(index_meta.indpred, index_meta.indrelid) AS predicate,
                index_meta.indnullsnotdistinct AS nulls_not_distinct,
                index_meta.indexprs IS NOT NULL AS has_expressions,
                COALESCE((
                    SELECT json_agg(
                        json_build_object(
                            'column', key_column.attname,
                            'expression', CASE WHEN index_meta.indkey[key_position.position] = 0
                                THEN pg_catalog.pg_get_indexdef(index_meta.indexrelid, key_position.position + 1, true)
                                ELSE NULL END,
                            'direction', CASE
                                WHEN (index_meta.indoption[key_position.position] & 1) = 1 THEN 'desc'
                                ELSE 'asc'
                            END,
                            'nullPlacement', CASE
                                WHEN (index_meta.indoption[key_position.position] & 2) = 2 THEN 'first'
                                ELSE 'last'
                            END,
                            'operatorClass', CASE
                                WHEN operator_class.opcdefault THEN 'default'
                                ELSE operator_namespace.nspname || '.' || operator_class.opcname
                            END,
                            'collation', CASE
                                WHEN index_meta.indcollation[key_position.position] = 0
                                  OR index_meta.indcollation[key_position.position] = key_column.attcollation
                                THEN 'default'
                                ELSE collation_namespace.nspname || '.' || collation_meta.collname
                            END)
                        ORDER BY key_position.position)::text
                    FROM generate_series(0, index_meta.indnkeyatts - 1) AS key_position(position)
                    LEFT JOIN pg_attribute key_column
                      ON key_column.attrelid = table_rel.oid
                     AND key_column.attnum = index_meta.indkey[key_position.position]
                    LEFT JOIN pg_opclass operator_class
                      ON operator_class.oid = index_meta.indclass[key_position.position]
                    LEFT JOIN pg_namespace operator_namespace
                      ON operator_namespace.oid = operator_class.opcnamespace
                    LEFT JOIN pg_collation collation_meta
                      ON collation_meta.oid = index_meta.indcollation[key_position.position]
                    LEFT JOIN pg_namespace collation_namespace
                      ON collation_namespace.oid = collation_meta.collnamespace
                ), '[]') AS keys,
                COALESCE((
                    SELECT json_agg(included_column.attname ORDER BY included_position.position)::text
                    FROM generate_series(index_meta.indnkeyatts, index_meta.indnatts - 1) AS included_position(position)
                    LEFT JOIN pg_attribute included_column
                      ON included_column.attrelid = table_rel.oid
                     AND included_column.attnum = index_meta.indkey[included_position.position]
                ), '[]') AS included_columns
            FROM pg_index index_meta
            JOIN pg_class table_rel ON table_rel.oid = index_meta.indrelid
            JOIN pg_namespace table_namespace ON table_namespace.oid = table_rel.relnamespace
            JOIN pg_class index_rel ON index_rel.oid = index_meta.indexrelid
            JOIN pg_am access_method ON access_method.oid = index_rel.relam
            WHERE table_namespace.nspname = 'public'
              AND NOT EXISTS (
                  SELECT 1
                  FROM pg_constraint owning_constraint
                  WHERE owning_constraint.conindid = index_meta.indexrelid
                    AND owning_constraint.contype = 'p'
                    AND table_rel.relname <> '{CurrentSchemaControlShape.ApplyJournalTableName}'
              );
            """, cancellationToken, tableScope).ConfigureAwait(false);

        foreach (DataRow row in indexRows.Rows)
        {
            string tableName = CurrentSchemaCanonicalAuthority.NormalizeIdentifier(Convert.ToString(row["table_name"])!);
            if (tables.TryGetValue(tableName, out SchemaTableModel? table))
            {
                string indexName = CurrentSchemaCanonicalAuthority.NormalizeIdentifier(Convert.ToString(row["index_name"])!);
                if (tableName == CurrentSchemaControlShape.ApplyJournalTableName
                    && (!Convert.ToBoolean(row["is_valid"]) || !Convert.ToBoolean(row["is_ready"]) || !Convert.ToBoolean(row["is_live"])))
                    throw new InvalidOperationException("current_schema_control_index_unavailable");
                if (Convert.ToBoolean(row["is_primary"])) primaryIndexes.Add(tableName + "." + indexName);
                bool hasExpressions = Convert.ToBoolean(row["has_expressions"]);
                IReadOnlyList<SchemaIndexKeyModel> keys = ParsePostgresIndexKeys(
                    Convert.ToString(row["keys"]),
                    hasExpressions, table.Columns);
                string[] includedColumns = ParsePostgresIncludedColumns(Convert.ToString(row["included_columns"]));
                table.Indexes.Add(indexName);
                ((Dictionary<string, SchemaIndexModel>)table.IndexDefinitions).Add(
                    indexName,
                    new SchemaIndexModel(
                        indexName,
                        Convert.ToBoolean(row["is_unique"]),
                        keys,
                        includedColumns,
                        NormalizeRequiredPostgresIdentifier(Convert.ToString(row["access_method"]), "index access method"),
                        row["predicate"] is DBNull ? null : Convert.ToString(row["predicate"])?.Trim(),
                        Convert.ToBoolean(row["nulls_not_distinct"])));
            }
        }

        DataTable constraintRows = await QueryAsync(connection, transaction, $"""
            SELECT
                table_rel.relname AS table_name,
                constraint_meta.conname AS constraint_name,
                constraint_meta.contype AS constraint_type,
                COALESCE((
                    SELECT string_agg(column_meta.attname, ',' ORDER BY constraint_column.ordinality)
                    FROM unnest(constraint_meta.conkey) WITH ORDINALITY AS constraint_column(attnum, ordinality)
                    JOIN pg_attribute column_meta
                      ON column_meta.attrelid = constraint_meta.conrelid
                     AND column_meta.attnum = constraint_column.attnum
                ), '') AS columns,
                referenced_rel.relname AS referenced_table,
                referenced_namespace.nspname AS referenced_schema,
                COALESCE((
                    SELECT string_agg(column_meta.attname, ',' ORDER BY referenced_column.ordinality)
                    FROM unnest(constraint_meta.confkey) WITH ORDINALITY AS referenced_column(attnum, ordinality)
                    JOIN pg_attribute column_meta
                      ON column_meta.attrelid = constraint_meta.confrelid
                     AND column_meta.attnum = referenced_column.attnum
                ), '') AS referenced_columns,
                CASE
                    WHEN constraint_meta.contype = 'c'
                    THEN pg_get_expr(constraint_meta.conbin, constraint_meta.conrelid)
                    ELSE NULL
                END AS expression,
                constraint_meta.condeferrable AS is_deferrable,
                constraint_meta.condeferred AS is_initially_deferred,
                constraint_meta.convalidated AS is_validated,
                constraint_meta.connoinherit AS no_inherit,
                constraint_meta.conislocal AS is_local,
                constraint_meta.coninhcount AS inheritance_count,
                backing_index.relname AS backing_index_name,
                COALESCE(backing_meta.indrelid = constraint_meta.conrelid
                    AND backing_index.relnamespace = table_rel.relnamespace
                    AND backing_meta.indisunique
                    AND backing_meta.indimmediate
                    AND backing_meta.indisprimary = (constraint_meta.contype = 'p'), FALSE) AS backing_index_owned,
                constraint_meta.confupdtype::text AS foreign_key_update_action,
                constraint_meta.confdeltype::text AS foreign_key_delete_action,
                constraint_meta.confmatchtype::text AS foreign_key_match_type
            FROM pg_constraint constraint_meta
            JOIN pg_class table_rel ON table_rel.oid = constraint_meta.conrelid
            JOIN pg_namespace table_namespace ON table_namespace.oid = table_rel.relnamespace
            LEFT JOIN pg_class referenced_rel ON referenced_rel.oid = constraint_meta.confrelid
            LEFT JOIN pg_namespace referenced_namespace ON referenced_namespace.oid = referenced_rel.relnamespace
            LEFT JOIN pg_class backing_index ON backing_index.oid = constraint_meta.conindid
            LEFT JOIN pg_index backing_meta ON backing_meta.indexrelid = constraint_meta.conindid
            WHERE table_namespace.nspname = 'public'
              AND (constraint_meta.contype IN ('p', 'u', 'f', 'c')
                OR table_rel.relname = '{CurrentSchemaControlShape.ApplyJournalTableName}');
            """, cancellationToken, tableScope).ConfigureAwait(false);

        foreach (DataRow row in constraintRows.Rows)
        {
            string tableName = CurrentSchemaCanonicalAuthority.NormalizeIdentifier(Convert.ToString(row["table_name"])!);
            if (!tables.TryGetValue(tableName, out SchemaTableModel? table))
            {
                continue;
            }

            string physicalName = CurrentSchemaCanonicalAuthority.NormalizeIdentifier(Convert.ToString(row["constraint_name"])!);
            if (tableName == CurrentSchemaControlShape.ApplyJournalTableName
                && (Convert.ToString(row["constraint_type"]) is "p" or "u")
                && (!Convert.ToBoolean(row["backing_index_owned"])
                    || row["backing_index_name"] is DBNull
                    || !string.Equals(Convert.ToString(row["backing_index_name"]),
                        Convert.ToString(row["constraint_name"]), StringComparison.Ordinal)))
                throw new InvalidOperationException("current_schema_control_constraint_backing_index_unavailable");
            if (tableName == CurrentSchemaControlShape.ApplyJournalTableName
                && (Convert.ToBoolean(row["no_inherit"]) != (Convert.ToString(row["constraint_type"]) is "p" or "u")
                    || !Convert.ToBoolean(row["is_local"])
                    || Convert.ToInt32(row["inheritance_count"]) != 0))
                throw new InvalidOperationException("current_schema_control_constraint_inheritance_unavailable");
            string kind = Convert.ToString(row["constraint_type"]) switch
            {
                "p" => "primary-key",
                "u" => "unique",
                "f" => "foreign-key",
                "c" => "check",
                string unknown => throw new InvalidOperationException($"Unsupported PostgreSQL current schema constraint type: {unknown}."),
                null => throw new InvalidOperationException("PostgreSQL current schema constraint type is null.")
            };
            string name = kind == "primary-key" ? $"pk_{tableName}" : physicalName;
            string[] columns = ParseIdentifierList(Convert.ToString(row["columns"]));
            string? referencedTable = row["referenced_table"] is DBNull
                ? null
                : CurrentSchemaCanonicalAuthority.NormalizeIdentifier(Convert.ToString(row["referenced_table"])!);
            string? referencedSchema = kind == "foreign-key"
                ? CurrentSchemaCanonicalAuthority.NormalizeIdentifier(Convert.ToString(row["referenced_schema"])!)
                : null;
            string[] referencedColumns = ParseIdentifierList(Convert.ToString(row["referenced_columns"]));
            string? expression = row["expression"] is DBNull ? null : Convert.ToString(row["expression"])?.Trim();
            bool isDeferrable = Convert.ToBoolean(row["is_deferrable"]);
            bool isInitiallyDeferred = Convert.ToBoolean(row["is_initially_deferred"]);
            bool isValidated = Convert.ToBoolean(row["is_validated"]);
            string? foreignKeyUpdateAction = kind == "foreign-key"
                ? NormalizePostgresForeignKeyAction(Convert.ToString(row["foreign_key_update_action"]))
                : null;
            string? foreignKeyDeleteAction = kind == "foreign-key"
                ? NormalizePostgresForeignKeyAction(Convert.ToString(row["foreign_key_delete_action"]))
                : null;
            string? foreignKeyMatchType = kind == "foreign-key"
                ? NormalizePostgresForeignKeyMatchType(Convert.ToString(row["foreign_key_match_type"]))
                : null;
            ((Dictionary<string, SchemaConstraintModel>)table.Constraints).TryAdd(
                name,
                new SchemaConstraintModel(
                    name,
                    kind,
                    columns,
                    referencedTable,
                    referencedColumns.Length == 0 ? null : referencedColumns,
                    expression,
                    isDeferrable,
                    isInitiallyDeferred,
                    isValidated,
                    foreignKeyUpdateAction,
                    foreignKeyDeleteAction,
                    foreignKeyMatchType,
                    referencedSchema));
        }

        foreach ((string tableName, SchemaTableModel table) in tables.ToArray())
        {
            // Control constraints must be actual pg_constraint rows, not inferred unique indexes.
            if (tableName == CurrentSchemaControlShape.ApplyJournalTableName) continue;
            var constraints = (Dictionary<string, SchemaConstraintModel>)table.Constraints;
            foreach (SchemaIndexModel index in table.IndexDefinitions.Values.Where(static index => index.IsUnique))
            {
                if (primaryIndexes.Contains(tableName + "." + index.Name)) continue;
                constraints.TryAdd(index.Name, new SchemaConstraintModel(
                    index.Name,
                    "unique",
                    index.Keys.Select(static key => key.Column).ToArray()));
            }
        }

        return new SchemaModelSnapshot(tables, provider: SchemaProviderKind.PostgreSql);
    }


    private static async Task<DataTable> QueryAsync(
        DbConnection connection,
        DbTransaction transaction,
        string sql,
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
        {
            table.Columns.Add(reader.GetName(index), reader.GetFieldType(index));
        }
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            var values = new object[reader.FieldCount];
            reader.GetValues(values);
            table.Rows.Add(values);
        }
        return table;
    }

    private static SchemaTableModel NewActualTable(
        string tableName,
        Dictionary<string, SchemaColumnModel> columns,
        IEnumerable<string> indexes,
        IReadOnlyDictionary<string, SchemaConstraintModel>? constraints = null)
        => new(
            tableName,
            columns,
            indexes,
            constraints: constraints,
            owner: new SchemaOwnerModel("postgresql", $"public.{tableName}"));

    private static string NormalizePostgresSemanticType(string dataType, string udtName)
    {
        if (string.Equals(dataType, "ARRAY", StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException($"Unsupported PostgreSQL current schema array type: {udtName}.");
        }
        return SchemaPhysicalTypeProjection.NormalizeDeclaredSemantic(dataType);
    }

    /// <summary>Decodes the closed native foreign-key action vocabulary; unknown codes refuse.</summary>
    public static string NormalizePostgresForeignKeyAction(string? action)
        => action switch
        {
            "a" => "no-action",
            "r" => "restrict",
            "c" => "cascade",
            "n" => "set-null",
            "d" => "set-default",
            _ => throw new InvalidOperationException($"Unsupported PostgreSQL foreign-key action: {action ?? "null"}.")
        };

    /// <summary>Decodes native foreign-key match semantics without substituting a default.</summary>
    public static string NormalizePostgresForeignKeyMatchType(string? matchType)
        => matchType switch
        {
            "s" => "simple",
            "f" => "full",
            "p" => "partial",
            _ => throw new InvalidOperationException($"Unsupported PostgreSQL foreign-key match type: {matchType ?? "null"}.")
        };

    /// <summary>Decodes complete native index-key metadata; expression keys outside the current contract refuse.</summary>
    public static IReadOnlyList<SchemaIndexKeyModel> ParsePostgresIndexKeys(
        string? json,
        bool hasExpressions,
        IReadOnlyDictionary<string, SchemaColumnModel>? columns = null)
    {
        using JsonDocument document = JsonDocument.Parse(json ?? "null");
        if (document.RootElement.ValueKind != JsonValueKind.Array
            || document.RootElement.GetArrayLength() == 0)
        {
            throw new InvalidOperationException("PostgreSQL current schema index has no exact key observations.");
        }

        var keys = new List<SchemaIndexKeyModel>();
        foreach (JsonElement element in document.RootElement.EnumerateArray())
        {
            if (element.ValueKind != JsonValueKind.Object
                || element.EnumerateObject().Select(static property => property.Name).Order(StringComparer.Ordinal)
                    .SequenceEqual(
                        new[] { "collation", "column", "direction", "expression", "nullPlacement", "operatorClass" },
                        StringComparer.Ordinal) == false)
            {
                throw new InvalidOperationException("PostgreSQL current schema index key observation has an invalid shape.");
            }

            JsonElement rawExpression = element.GetProperty("expression");
            bool expressionKey = rawExpression.ValueKind != JsonValueKind.Null;
            string column = expressionKey ? string.Empty : NormalizeRequiredPostgresIdentifier(
                element.GetProperty("column").GetString(), "index key column");
            SchemaExpressionNode? expression = null;
            if (expressionKey)
            {
                if (!hasExpressions || columns is null || rawExpression.ValueKind != JsonValueKind.String
                    || element.GetProperty("column").ValueKind != JsonValueKind.Null)
                {
                    throw new InvalidOperationException("current_schema_native_index_expression_unobserved_or_unbound");
                }
                expression = PgCurrentSchemaExpressionParser.Parse(rawExpression.GetString()!, columns);
            }
            string direction = RequireExactValue(
                element.GetProperty("direction").GetString(),
                "index key direction",
                "asc",
                "desc");
            string nullPlacement = RequireExactValue(
                element.GetProperty("nullPlacement").GetString(),
                "index key null placement",
                "first",
                "last");
            string operatorClass = NormalizePostgresIndexIdentity(
                element.GetProperty("operatorClass").GetString(),
                "index operator class");
            string collation = NormalizePostgresIndexIdentity(
                element.GetProperty("collation").GetString(),
                "index collation");
            var key = new SchemaIndexKeyModel(
                column,
                direction,
                nullPlacement,
                operatorClass,
                collation)
            {
                Expression = expression
            };
            if (expression is not null)
            {
                _ = SchemaIndexExpressionSemantics.RequireColumns(key, columns!);
            }
            keys.Add(key);
        }
        if (hasExpressions != keys.Any(static key => key.Expression is not null))
        {
            throw new InvalidOperationException("current_schema_native_index_expression_roster_mismatch");
        }
        return keys;
    }

    /// <summary>Preserves ordered native included-column identities and rejects malformed metadata.</summary>
    public static string[] ParsePostgresIncludedColumns(string? json)
    {
        using JsonDocument document = JsonDocument.Parse(json ?? "null");
        if (document.RootElement.ValueKind != JsonValueKind.Array)
        {
            throw new InvalidOperationException("PostgreSQL current schema included-column observation is not an array.");
        }
        return document.RootElement.EnumerateArray()
            .Select(element => NormalizeRequiredPostgresIdentifier(element.GetString(), "included index column"))
            .ToArray();
    }

    private static string NormalizeRequiredPostgresIdentifier(string? value, string field)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new InvalidOperationException($"PostgreSQL current schema {field} is empty.");
        }
        return CurrentSchemaCanonicalAuthority.NormalizeIdentifier(value);
    }

    private static string NormalizePostgresIndexIdentity(string? value, string field)
    {
        string normalized = NormalizeRequiredPostgresIdentifier(value, field);
        if (normalized != "default" && !normalized.Contains('.', StringComparison.Ordinal))
        {
            throw new InvalidOperationException($"PostgreSQL current schema {field} is not default or schema-qualified: {value}.");
        }
        return normalized;
    }

    private static string RequireExactValue(string? value, string field, params string[] allowed)
    {
        if (value is null || !allowed.Contains(value, StringComparer.Ordinal))
        {
            throw new InvalidOperationException(
                $"PostgreSQL current schema {field} has unsupported value: {value ?? "null"}.");
        }
        return value;
    }

    /// <summary>Checks native identity/default/owned-sequence consistency before selecting a generation kind.</summary>
    public static string ResolvePostgresGenerationKind(
        string? identityKind,
        string? rawDefault,
        bool hasOwnedSequence)
    {
        string normalizedIdentity = identityKind?.Trim() ?? string.Empty;
        bool hasSequenceDefault = !string.IsNullOrWhiteSpace(rawDefault)
            && rawDefault.TrimStart().StartsWith("nextval(", StringComparison.OrdinalIgnoreCase);
        string generationKind = normalizedIdentity switch
        {
            "" when hasSequenceDefault => "owned-sequence-default",
            "" => "none",
            "d" => "identity-by-default",
            "a" => "identity-always",
            _ => throw new InvalidOperationException(
                $"Unsupported PostgreSQL current schema identity kind: {normalizedIdentity}.")
        };

        if ((generationKind == "none") == hasOwnedSequence)
        {
            throw new InvalidOperationException(
                "PostgreSQL current schema generation and owned-sequence observations disagree.");
        }
        if (generationKind == "owned-sequence-default" && !hasSequenceDefault)
        {
            throw new InvalidOperationException(
                "PostgreSQL owned sequence column is missing its nextval default.");
        }
        if (generationKind.StartsWith("identity-", StringComparison.Ordinal) && hasSequenceDefault)
        {
            throw new InvalidOperationException(
                "PostgreSQL identity column unexpectedly exposes a sequence default.");
        }
        return generationKind;
    }

    private static SchemaOwnedSequenceModel? ReadOwnedSequence(
        DataRow row,
        string tableName,
        string columnName,
        string generationKind)
    {
        if (generationKind == "none")
        {
            return null;
        }

        string expectedDependency = generationKind == "owned-sequence-default" ? "a" : "i";
        string dependency = RequireExactValue(
            Convert.ToString(row["dependency_type"]),
            "owned sequence dependency type",
            expectedDependency);
        _ = dependency;
        string sequenceSchema = NormalizeRequiredPostgresIdentifier(
            Convert.ToString(row["sequence_schema"]),
            "owned sequence schema");
        string sequenceName = NormalizeRequiredPostgresIdentifier(
            Convert.ToString(row["sequence_name"]),
            "owned sequence name");
        string ownedTable = NormalizeRequiredPostgresIdentifier(
            Convert.ToString(row["owned_table"]),
            "owned sequence table");
        string ownedColumn = NormalizeRequiredPostgresIdentifier(
            Convert.ToString(row["owned_column"]),
            "owned sequence column");
        if (sequenceSchema != "public" || ownedTable != tableName || ownedColumn != columnName)
        {
            throw new InvalidOperationException(
                $"PostgreSQL current schema owned sequence authority mismatch for {tableName}.{columnName}.");
        }

        return new SchemaOwnedSequenceModel(
            sequenceSchema,
            sequenceName,
            ownedTable,
            ownedColumn,
            SchemaPhysicalTypeProjection.NormalizePhysical(
                Convert.ToString(row["sequence_type"]) ?? string.Empty),
            ReadRequiredInt64(row, "start_value"),
            ReadRequiredInt64(row, "increment_by"),
            ReadRequiredInt64(row, "min_value"),
            ReadRequiredInt64(row, "max_value"),
            ReadRequiredInt64(row, "cache_size"),
            ReadRequiredBoolean(row, "is_cyclic"));
    }

    private static long ReadRequiredInt64(DataRow row, string field)
    {
        if (row[field] is DBNull)
        {
            throw new InvalidOperationException($"PostgreSQL current schema {field} is null.");
        }
        return Convert.ToInt64(row[field]);
    }

    private static bool ReadRequiredBoolean(DataRow row, string field)
    {
        if (row[field] is DBNull)
        {
            throw new InvalidOperationException($"PostgreSQL current schema {field} is null.");
        }
        return Convert.ToBoolean(row[field]);
    }

    /// <summary>Decodes native default or schema-qualified collation identity without an unknown-value fallback.</summary>
    public static string NormalizePostgresCollation(string? value)
    {
        string normalized = NormalizeRequiredPostgresIdentifier(value, "column collation");
        if (normalized != "n/a" && normalized != "default" && !normalized.Contains('.', StringComparison.Ordinal))
        {
            throw new InvalidOperationException(
                $"PostgreSQL current schema column collation is not n/a, default, or schema-qualified: {value}.");
        }
        return normalized;
    }

    /// <summary>Retains the original native physical-type normalization used by the physical snapshot digest.</summary>
    public static string NormalizePostgresPhysicalType(string value)
    {
        string normalized = SchemaPhysicalTypeProjection.NormalizePhysical(value);
        return normalized switch
        {
            "timestamp(6) without time zone" => "timestamp without time zone",
            "timestamp(6) with time zone" => "timestamp with time zone",
            _ => normalized
        };
    }

    /// <summary>Retains the original catalog snapshot representation; full expression comparison uses raw native facts.</summary>
    public static string? NormalizePostgresDefault(string? rawDefault)
    {
        if (string.IsNullOrWhiteSpace(rawDefault))
        {
            return null;
        }

        string value = rawDefault.Trim();
        int cast = value.IndexOf("::", StringComparison.Ordinal);
        if (cast >= 0)
        {
            value = value[..cast];
        }
        if (value.Length >= 2 && value[0] == '\'' && value[^1] == '\'')
        {
            value = value[1..^1].Replace("''", "'", StringComparison.Ordinal);
        }
        return string.Equals(value, "NULL", StringComparison.OrdinalIgnoreCase) ? null : value;
    }

    private static string[] ParseIdentifierList(string? value)
        => string.IsNullOrWhiteSpace(value)
            ? []
            : value.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Select(CurrentSchemaCanonicalAuthority.NormalizeIdentifier)
                .ToArray();
}
