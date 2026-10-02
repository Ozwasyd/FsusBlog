using System.Collections.Immutable;
using System.Data;
using System.Data.Common;
using System.Globalization;

using MySqlConnector;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration;

internal enum MySqlCatalogPart
{
    Tables, Columns, IndexParts, Constraints, ConstraintColumns, Checks,
    References, Triggers, Routines, RoutineParameters, Events, Views, Partitions
}

// These retain measured native names, NULLs and definitions. They are not an
// expected target, an expression normalizer or an independent-allocator protocol.
internal sealed record MySqlCatalogCell(string Name, string? Value);
internal sealed record MySqlCatalogRow(MySqlCatalogPart Part, ImmutableArray<MySqlCatalogCell> Cells);
internal sealed record MySqlCurrentSchemaCatalog(
    CurrentSchemaDatabaseIdentity Database,
    ImmutableArray<MySqlCatalogCell> Session,
    ImmutableArray<MySqlCatalogRow> Rows);

/// <summary>
/// Reads the caller's actual native MySQL catalog/effects without opening another
/// connection, changing session options, executing effects or granting admission.
/// Canonical MySQL target/allocator projection must be supplied by its original
/// Shared owner before these raw observations can participate in full comparison.
/// </summary>
internal static class MySqlCurrentSchemaCatalogObserver
{
    internal static async Task<MySqlCurrentSchemaCatalog> ReadAsync(
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        RequireSession(connection, transaction, cancellationToken);
        var budget = new MetadataBudget();
        MySqlCurrentSchemaCatalog before = await ReadOnceAsync(connection, transaction, budget, cancellationToken).ConfigureAwait(false);
        MySqlCurrentSchemaCatalog after = await ReadOnceAsync(connection, transaction, budget, cancellationToken).ConfigureAwait(false);
        RequireUnchanged(before, after);
        RequireSession(connection, transaction, cancellationToken);
        return after;
    }

    private static async Task<MySqlCurrentSchemaCatalog> ReadOnceAsync(
        DbConnection connection, DbTransaction transaction, MetadataBudget budget, CancellationToken cancellationToken)
    {
        ImmutableArray<ImmutableArray<MySqlCatalogCell>> sessions = await QueryAsync(connection, transaction,
            "SELECT " + SelectFields("@@server_uuid", "DATABASE()", "@@session.transaction_isolation",
                "@@session.transaction_read_only", "@@session.sql_mode", "@@session.character_set_connection",
                "@@session.collation_connection", "@@session.auto_increment_increment", "@@session.auto_increment_offset",
                "@@show_gipk_in_create_table_and_information_schema"),
            SessionNames,
            budget, cancellationToken).ConfigureAwait(false);
        if (sessions.Length != 1)
            throw Failure("session_observation_invalid");
        ImmutableArray<MySqlCatalogCell> session = sessions[0];
        CurrentSchemaDatabaseIdentity database = RequireObservedSession(session);

        // Restricted information_schema visibility cannot establish absence. Retain
        // the original source owner's complete global visibility requirement; global
        // SELECT also allows complete routine definitions, not only routine names.
        ImmutableArray<ImmutableArray<MySqlCatalogCell>> privileges = await QueryAsync(connection, transaction,
            "SELECT CAST(COUNT(DISTINCT PRIVILEGE_TYPE) AS CHAR) FROM information_schema.USER_PRIVILEGES " +
            "WHERE GRANTEE=CONCAT(QUOTE(SUBSTRING_INDEX(CURRENT_USER(),'@',1)),'@',QUOTE(SUBSTRING_INDEX(CURRENT_USER(),'@',-1))) " +
            "AND PRIVILEGE_TYPE IN ('SELECT','SHOW VIEW','TRIGGER','EVENT')", ["visibility"], budget, cancellationToken).ConfigureAwait(false);
        if (privileges.Length != 1 || privileges[0][0].Value != "4")
            throw Failure("complete_visibility_required");

        var rows = ImmutableArray.CreateBuilder<MySqlCatalogRow>();
        foreach (CatalogQuery query in Queries)
        {
            ImmutableArray<ImmutableArray<MySqlCatalogCell>> actual = await QueryAsync(connection, transaction,
                query.Sql, query.Names, budget, cancellationToken).ConfigureAwait(false);
            foreach (ImmutableArray<MySqlCatalogCell> cells in actual)
            {
                var row = new MySqlCatalogRow(query.Part, cells);
                RequireCompleteDefinition(row);
                rows.Add(row);
            }
        }
        return new(database, session, rows.ToImmutable());
    }

    internal static void RequireSession(DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(connection);
        ArgumentNullException.ThrowIfNull(transaction);
        cancellationToken.ThrowIfCancellationRequested();
        if (!cancellationToken.CanBeCanceled || connection.GetType() != typeof(MySqlConnection)
            || transaction.GetType() != typeof(MySqlTransaction) || connection.State != ConnectionState.Open
            || !ReferenceEquals(transaction.Connection, connection)
            || transaction.IsolationLevel is not (IsolationLevel.Snapshot or IsolationLevel.RepeatableRead))
            throw Failure("original_native_transaction_required");
    }

    internal static CurrentSchemaDatabaseIdentity RequireObservedSession(ImmutableArray<MySqlCatalogCell> session)
    {
        if (session.Length != SessionNames.Length || !session.Select(cell => cell.Name).SequenceEqual(SessionNames)
            || !Guid.TryParse(session[0].Value, out Guid server) || server == Guid.Empty
            || string.IsNullOrWhiteSpace(session[1].Value) || session[2].Value != "REPEATABLE-READ"
            || session[3].Value is not ("0" or "1") || session[4].Value is null
            || string.IsNullOrWhiteSpace(session[5].Value) || string.IsNullOrWhiteSpace(session[6].Value)
            || !ulong.TryParse(session[7].Value, NumberStyles.None, CultureInfo.InvariantCulture, out ulong increment) || increment == 0
            || !ulong.TryParse(session[8].Value, NumberStyles.None, CultureInfo.InvariantCulture, out ulong offset) || offset == 0
            || session[9].Value != "1")
            throw Failure("native_identity_or_visibility_unavailable");
        return new(CurrentSchemaProviderKind.MySql, "mysql:" + server.ToString("D"), session[1].Value!);
    }

    internal static void RequireUnchanged(MySqlCurrentSchemaCatalog before, MySqlCurrentSchemaCatalog after)
    {
        if (before.Database != after.Database || !before.Session.SequenceEqual(after.Session)
            || before.Rows.Length != after.Rows.Length || before.Rows.Where((row, index) =>
                row.Part != after.Rows[index].Part || !row.Cells.SequenceEqual(after.Rows[index].Cells)).Any())
            throw Failure("native_catalog_changed_during_read");
        // This is an observation-stability check, not a MySQL metadata-lock/snapshot
        // proof or semantic target comparison. Those remain distinct owner obligations.
    }

    internal static void RequireCompleteDefinition(MySqlCatalogRow row)
    {
        string? Field(string name) => row.Cells.Single(cell => cell.Name == name).Value;
        string? definition = row.Part switch
        {
            MySqlCatalogPart.Triggers => "ACTION_STATEMENT",
            MySqlCatalogPart.Routines => "ROUTINE_DEFINITION",
            MySqlCatalogPart.Events => "EVENT_DEFINITION",
            MySqlCatalogPart.Views => "VIEW_DEFINITION",
            MySqlCatalogPart.Checks => "CHECK_CLAUSE",
            _ => null
        };
        if (definition is not null && string.IsNullOrWhiteSpace(Field(definition)))
            throw Failure("complete_effect_definition_required");
        if (row.Part == MySqlCatalogPart.IndexParts
            && (Field("COLUMN_NAME") is null) == (Field("EXPRESSION") is null))
            throw Failure("index_key_observation_invalid");
        // Retain DEFAULT_GENERATED, ON UPDATE, generated/invisible columns, raw
        // defaults/collations and all extra objects. Nothing is normalized away
        // or allowed simply because the provider has a customary default.
        // TABLES.AUTO_INCREMENT is reported mutable state, not an independently
        // owned sequence/backing allocator or a proof of its latest next value.
    }

    private static async Task<ImmutableArray<ImmutableArray<MySqlCatalogCell>>> QueryAsync(
        DbConnection connection, DbTransaction transaction, string sql, string[] names,
        MetadataBudget budget, CancellationToken cancellationToken)
    {
        await using DbCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = sql;
        command.CommandTimeout = 30; // Original source metadata command policy, not a new total deadline.
        await using DbDataReader reader = await command.ExecuteReaderAsync(CommandBehavior.SequentialAccess, cancellationToken).ConfigureAwait(false);
        if (reader.FieldCount != names.Length)
            throw Failure("native_metadata_shape_invalid");
        var rows = ImmutableArray.CreateBuilder<ImmutableArray<MySqlCatalogCell>>();
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            budget.AddRow();
            var cells = ImmutableArray.CreateBuilder<MySqlCatalogCell>(names.Length);
            for (int index = 0; index < names.Length; index++)
                cells.Add(new(names[index], budget.ReadCell(reader.IsDBNull(index) ? null : reader.GetString(index))));
            rows.Add(cells.ToImmutable());
        }
        return rows.ToImmutable();
    }

    internal sealed class MetadataBudget
    {
        private int _rows;
        private int _characters;
        internal void AddRow()
        {
            if (++_rows > OfflineMigrationSourceObserver.MaximumMetadataRows)
                throw Failure("metadata_budget_exceeded");
        }
        internal string? ReadCell(string? value)
        {
            if (value is null) return null;
            if (value.Length > OfflineMigrationSourceObserver.MaximumCellCharacters
                || value.Length > OfflineMigrationSourceObserver.MaximumMetadataCharacters - _characters)
                throw Failure("metadata_budget_exceeded");
            _characters += value.Length;
            return value;
        }
    }

    // All expressions are owned source constants, never caller SQL/identifiers.
    // Limit in SQL before hydration; the extra character is rejected, never accepted
    // as a truncated/default expression or an incomplete trigger/routine body.
    private static string SelectFields(params string[] expressions)
        => string.Join(',', expressions.Select(expression => $"LEFT(CAST({expression} AS CHAR),{OfflineMigrationSourceObserver.MaximumCellCharacters + 1})"));

    private sealed record CatalogQuery(MySqlCatalogPart Part, string Sql, string[] Names);
    private static readonly string[] SessionNames =
        ["server_uuid", "database", "isolation", "read_only", "sql_mode", "connection_charset",
            "connection_collation", "auto_increment_increment", "auto_increment_offset", "gipk_visible"];
    private static CatalogQuery Q(MySqlCatalogPart part, string table, string filter, string order, params string[] fields)
        => new(part, $"SELECT {SelectFields(fields)} FROM information_schema.{table} WHERE {filter} ORDER BY {order}", fields);

    private static readonly CatalogQuery[] Queries =
    [
        Q(MySqlCatalogPart.Tables, "TABLES", "TABLE_SCHEMA=DATABASE()", "BINARY TABLE_NAME",
            "TABLE_NAME", "TABLE_TYPE", "ENGINE", "ROW_FORMAT", "TABLE_COLLATION", "CREATE_OPTIONS", "TABLE_COMMENT", "AUTO_INCREMENT"),
        Q(MySqlCatalogPart.Columns, "COLUMNS", "TABLE_SCHEMA=DATABASE()", "BINARY TABLE_NAME,ORDINAL_POSITION",
            "TABLE_NAME", "COLUMN_NAME", "ORDINAL_POSITION", "COLUMN_TYPE", "IS_NULLABLE", "COLUMN_DEFAULT", "EXTRA",
            "CHARACTER_SET_NAME", "COLLATION_NAME", "GENERATION_EXPRESSION", "COLUMN_COMMENT", "SRS_ID"),
        Q(MySqlCatalogPart.IndexParts, "STATISTICS", "TABLE_SCHEMA=DATABASE()", "BINARY TABLE_NAME,BINARY INDEX_NAME,SEQ_IN_INDEX",
            "TABLE_NAME", "INDEX_NAME", "NON_UNIQUE", "SEQ_IN_INDEX", "COLUMN_NAME", "COLLATION", "SUB_PART",
            "NULLABLE", "INDEX_TYPE", "COMMENT", "INDEX_COMMENT", "IS_VISIBLE", "EXPRESSION"),
        Q(MySqlCatalogPart.Constraints, "TABLE_CONSTRAINTS", "TABLE_SCHEMA=DATABASE()", "BINARY TABLE_NAME,BINARY CONSTRAINT_NAME",
            "TABLE_NAME", "CONSTRAINT_NAME", "CONSTRAINT_TYPE", "ENFORCED"),
        Q(MySqlCatalogPart.ConstraintColumns, "KEY_COLUMN_USAGE", "TABLE_SCHEMA=DATABASE()", "BINARY TABLE_NAME,BINARY CONSTRAINT_NAME,ORDINAL_POSITION",
            "TABLE_NAME", "CONSTRAINT_NAME", "COLUMN_NAME", "ORDINAL_POSITION", "POSITION_IN_UNIQUE_CONSTRAINT",
            "REFERENCED_TABLE_SCHEMA", "REFERENCED_TABLE_NAME", "REFERENCED_COLUMN_NAME"),
        Q(MySqlCatalogPart.Checks, "CHECK_CONSTRAINTS", "CONSTRAINT_SCHEMA=DATABASE()", "BINARY CONSTRAINT_NAME",
            "CONSTRAINT_NAME", "CHECK_CLAUSE"),
        Q(MySqlCatalogPart.References, "REFERENTIAL_CONSTRAINTS", "CONSTRAINT_SCHEMA=DATABASE()", "BINARY TABLE_NAME,BINARY CONSTRAINT_NAME",
            "TABLE_NAME", "CONSTRAINT_NAME", "UNIQUE_CONSTRAINT_SCHEMA", "UNIQUE_CONSTRAINT_NAME", "MATCH_OPTION",
            "UPDATE_RULE", "DELETE_RULE", "REFERENCED_TABLE_NAME"),
        Q(MySqlCatalogPart.Triggers, "TRIGGERS", "TRIGGER_SCHEMA=DATABASE()", "BINARY EVENT_OBJECT_TABLE,BINARY TRIGGER_NAME",
            "TRIGGER_NAME", "EVENT_MANIPULATION", "EVENT_OBJECT_SCHEMA", "EVENT_OBJECT_TABLE", "ACTION_ORDER",
            "ACTION_STATEMENT", "ACTION_ORIENTATION", "ACTION_TIMING", "SQL_MODE", "DEFINER", "CHARACTER_SET_CLIENT",
            "COLLATION_CONNECTION", "DATABASE_COLLATION"),
        Q(MySqlCatalogPart.Routines, "ROUTINES", "ROUTINE_SCHEMA=DATABASE()", "BINARY ROUTINE_NAME,ROUTINE_TYPE",
            "ROUTINE_NAME", "ROUTINE_TYPE", "DTD_IDENTIFIER", "ROUTINE_BODY", "ROUTINE_DEFINITION", "EXTERNAL_LANGUAGE",
            "PARAMETER_STYLE", "IS_DETERMINISTIC", "SQL_DATA_ACCESS", "SECURITY_TYPE", "SQL_MODE", "DEFINER",
            "CHARACTER_SET_CLIENT", "COLLATION_CONNECTION", "DATABASE_COLLATION"),
        Q(MySqlCatalogPart.RoutineParameters, "PARAMETERS", "SPECIFIC_SCHEMA=DATABASE()", "BINARY SPECIFIC_NAME,ORDINAL_POSITION",
            "SPECIFIC_NAME", "ORDINAL_POSITION", "PARAMETER_MODE", "PARAMETER_NAME", "DTD_IDENTIFIER", "CHARACTER_SET_NAME", "COLLATION_NAME"),
        Q(MySqlCatalogPart.Events, "EVENTS", "EVENT_SCHEMA=DATABASE()", "BINARY EVENT_NAME",
            "EVENT_NAME", "DEFINER", "TIME_ZONE", "EVENT_BODY", "EVENT_DEFINITION", "EVENT_TYPE", "EXECUTE_AT",
            "INTERVAL_VALUE", "INTERVAL_FIELD", "SQL_MODE", "STARTS", "ENDS", "STATUS", "ON_COMPLETION",
            "CHARACTER_SET_CLIENT", "COLLATION_CONNECTION", "DATABASE_COLLATION"),
        Q(MySqlCatalogPart.Views, "VIEWS", "TABLE_SCHEMA=DATABASE()", "BINARY TABLE_NAME",
            "TABLE_NAME", "VIEW_DEFINITION", "CHECK_OPTION", "IS_UPDATABLE", "DEFINER", "SECURITY_TYPE", "CHARACTER_SET_CLIENT", "COLLATION_CONNECTION"),
        Q(MySqlCatalogPart.Partitions, "PARTITIONS", "TABLE_SCHEMA=DATABASE()", "BINARY TABLE_NAME,PARTITION_ORDINAL_POSITION,SUBPARTITION_ORDINAL_POSITION",
            "TABLE_NAME", "PARTITION_NAME", "SUBPARTITION_NAME", "PARTITION_ORDINAL_POSITION", "SUBPARTITION_ORDINAL_POSITION",
            "PARTITION_METHOD", "SUBPARTITION_METHOD", "PARTITION_EXPRESSION", "SUBPARTITION_EXPRESSION", "PARTITION_DESCRIPTION", "TABLESPACE_NAME")
    ];

    private static InvalidOperationException Failure(string code) => new("mysql_current_catalog_" + code);
}
