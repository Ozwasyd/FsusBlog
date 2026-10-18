using System.Collections.Immutable;
using System.Data;
using System.Data.Common;

using Microsoft.Data.Sqlite;

namespace FsusBlog.Migration;

// These are measured SQLite facts, not a second expected schema or a provider-to-business
// type mapping. In particular INTEGER cannot establish whether an owner expected bool
// or int, and a namespace filename cannot establish a physical database incarnation.
internal sealed record SqliteCurrentSchemaCatalog(
    string NamespaceFile,
    long SchemaVersion,
    long ApplicationId,
    long UserVersion,
    string Encoding,
    bool ForeignKeysEnabled,
    bool CheckConstraintsIgnored,
    bool RecursiveTriggersEnabled,
    bool QueryOnly,
    ImmutableArray<SqliteSchemaObject> Objects,
    ImmutableArray<SqliteTableMetadata> Tables,
    ImmutableArray<SqliteColumnMetadata> Columns,
    ImmutableArray<SqliteIndexMetadata> Indexes,
    ImmutableArray<SqliteForeignKeyMetadata> ForeignKeys,
    ImmutableArray<SqliteForeignKeyViolation> ForeignKeyViolations,
    ImmutableArray<SqliteSequenceValue> SequenceValues);

internal sealed record SqliteSchemaObject(string Kind, string Name, string Table, long RootPage, string? Sql);
internal sealed record SqliteTableMetadata(string Name, string Kind, int ColumnCount, bool WithoutRowId, bool Strict);
internal sealed record SqliteColumnMetadata(
    string Table, int Ordinal, string Name, string DeclaredType, bool NotNull,
    string? DefaultSql, int PrimaryKeyOrdinal, int HiddenKind);
internal sealed record SqliteIndexMetadata(
    string Table, string Name, bool Unique, string Origin, bool Partial,
    ImmutableArray<SqliteIndexColumn> Columns);
internal sealed record SqliteIndexColumn(
    int Ordinal, int ColumnId, string? Name, bool Descending, string Collation, bool Key);
internal sealed record SqliteForeignKeyMetadata(
    string Table, int Id, int Ordinal, string TargetTable, string SourceColumn,
    string? TargetColumn, string OnUpdate, string OnDelete, string Match);
internal sealed record SqliteForeignKeyViolation(string Table, long? RowId, string Parent, int ForeignKeyId);
internal sealed record SqliteSequenceValue(string Table, long Value);

/// <summary>
/// Measures the complete supported main SQLite catalog in the caller's original native
/// Serializable transaction. It opens no connection, changes no pragma, commits no unit,
/// and grants neither write admission nor current-target/physical-incarnation authority.
/// </summary>
internal static class SqliteCurrentSchemaCatalogObserver
{
    internal static async Task<SqliteCurrentSchemaCatalog> ReadAsync(
        DbConnection connection, DbTransaction transaction, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        RequireSession(connection, transaction);
        var budget = new MetadataBudget();
        string namespaceFile = await ReadNamespaceAsync(connection, transaction, budget, cancellationToken).ConfigureAwait(false);
        long schemaVersion = await ScalarAsync(connection, transaction, "PRAGMA main.schema_version", cancellationToken).ConfigureAwait(false);
        ImmutableArray<SqliteSchemaObject> objects = await RowsAsync(connection, transaction,
            $"SELECT {Text("type")}, {Text("name")}, {Text("tbl_name")}, rootpage, {Text("sql")} FROM main.sqlite_schema ORDER BY type, name",
            null, budget, reader => new SqliteSchemaObject(budget.RequiredText(reader, 0), budget.RequiredText(reader, 1),
                budget.RequiredText(reader, 2), reader.GetInt64(3), budget.NullableText(reader, 4)), cancellationToken).ConfigureAwait(false);
        if (objects.Any(item => item.Kind is not ("table" or "index" or "view" or "trigger")
            || (item.Kind != "index" && item.Sql is null)))
        {
            throw Failure("sqlite_current_catalog_object_not_supported");
        }

        ImmutableArray<SqliteTableMetadata> tables = await RowsAsync(connection, transaction,
            $"SELECT {Text("name")}, {Text("type")}, ncol, wr, strict FROM pragma_table_list WHERE schema = 'main' ORDER BY name",
            null, budget, reader => new SqliteTableMetadata(budget.RequiredText(reader, 0), budget.RequiredText(reader, 1),
                Integer(reader, 2), Boolean(reader, 3), Boolean(reader, 4)), cancellationToken).ConfigureAwait(false);
        // Introspecting an arbitrary virtual module may invoke extension code. Refuse that
        // unsupported capability rather than silently dropping its shadow tables/effects.
        if (!tables.Any(item => item.Name == "sqlite_schema" && item.Kind == "table")
            || tables.Any(item => item.Kind is not ("table" or "view")))
        {
            throw Failure("sqlite_current_catalog_table_kind_not_supported");
        }
        string[] objectTables = objects.Where(item => item.Kind is "table" or "view")
            .Select(item => item.Name).Order(StringComparer.Ordinal).ToArray();
        string[] measuredTables = tables.Where(item => item.Name != "sqlite_schema")
            .Select(item => item.Name).Order(StringComparer.Ordinal).ToArray();
        if (!objectTables.SequenceEqual(measuredTables, StringComparer.Ordinal))
        {
            throw Failure("sqlite_current_catalog_table_inventory_incomplete");
        }

        var columns = ImmutableArray.CreateBuilder<SqliteColumnMetadata>();
        var indexes = ImmutableArray.CreateBuilder<SqliteIndexMetadata>();
        var foreignKeys = ImmutableArray.CreateBuilder<SqliteForeignKeyMetadata>();
        foreach (SqliteTableMetadata table in tables.Where(item => item.Name != "sqlite_schema"))
        {
            ImmutableArray<SqliteColumnMetadata> tableColumns = await RowsAsync(connection, transaction,
                $"SELECT cid, {Text("name")}, {Text("type")}, [notnull], {Text("dflt_value")}, pk, hidden FROM pragma_table_xinfo($name, 'main') ORDER BY cid",
                table.Name, budget, reader => new SqliteColumnMetadata(table.Name, Integer(reader, 0), budget.RequiredText(reader, 1),
                    budget.RequiredText(reader, 2), Boolean(reader, 3), budget.NullableText(reader, 4), Integer(reader, 5), Integer(reader, 6)),
                cancellationToken).ConfigureAwait(false);
            if (tableColumns.Length != table.ColumnCount || table.ColumnCount < 1
                || tableColumns.Any(item => item.HiddenKind is not (0 or 2 or 3)))
            {
                throw Failure("sqlite_current_catalog_columns_incomplete");
            }
            columns.AddRange(tableColumns);
            ImmutableArray<SqliteIndexMetadata> tableIndexes = await RowsAsync(connection, transaction,
                $"SELECT {Text("name")}, [unique], {Text("origin")}, partial FROM pragma_index_list($name, 'main') ORDER BY name",
                table.Name, budget, reader => new SqliteIndexMetadata(table.Name, budget.RequiredText(reader, 0), Boolean(reader, 1),
                    budget.RequiredText(reader, 2), Boolean(reader, 3), []), cancellationToken).ConfigureAwait(false);
            foreach (SqliteIndexMetadata index in tableIndexes)
            {
                ImmutableArray<SqliteIndexColumn> indexColumns = await RowsAsync(connection, transaction,
                    $"SELECT seqno, cid, {Text("name")}, [desc], {Text("coll")}, [key] FROM pragma_index_xinfo($name, 'main') ORDER BY seqno",
                    index.Name, budget, reader => new SqliteIndexColumn(Integer(reader, 0), Integer(reader, 1), budget.NullableText(reader, 2),
                        Boolean(reader, 3), budget.RequiredText(reader, 4), Boolean(reader, 5)), cancellationToken).ConfigureAwait(false);
                if (index.Origin is not ("c" or "u" or "pk") || indexColumns.IsEmpty || !indexColumns.Any(item => item.Key))
                {
                    throw Failure("sqlite_current_catalog_index_incomplete");
                }
                indexes.Add(index with
                {
                    Columns = indexColumns
                });
            }
            foreignKeys.AddRange(await RowsAsync(connection, transaction,
                $"SELECT id, seq, {Text("[table]")}, {Text("[from]")}, {Text("[to]")}, {Text("on_update")}, {Text("on_delete")}, {Text("match")} FROM pragma_foreign_key_list($name, 'main') ORDER BY id, seq",
                table.Name, budget, reader => new SqliteForeignKeyMetadata(table.Name, Integer(reader, 0), Integer(reader, 1),
                    budget.RequiredText(reader, 2), budget.RequiredText(reader, 3), budget.NullableText(reader, 4),
                    budget.RequiredText(reader, 5), budget.RequiredText(reader, 6), budget.RequiredText(reader, 7)), cancellationToken).ConfigureAwait(false));
        }

        ImmutableArray<SqliteForeignKeyViolation> violations = await RowsAsync(connection, transaction,
            $"SELECT {Text("[table]")}, rowid, {Text("parent")}, fkid FROM pragma_foreign_key_check(NULL, 'main') ORDER BY [table], rowid, parent, fkid",
            null, budget, reader => new SqliteForeignKeyViolation(budget.RequiredText(reader, 0),
                reader.IsDBNull(1) ? null : reader.GetInt64(1), budget.RequiredText(reader, 2), Integer(reader, 3)), cancellationToken).ConfigureAwait(false);
        // sqlite_sequence is an actual AUTOINCREMENT high-water mark, not a replacement
        // for an unsupported PostgreSQL sequence recipe. Keep its observed values verbatim.
        ImmutableArray<SqliteSequenceValue> sequenceValues = objects.Any(item => item.Kind == "table" && item.Name == "sqlite_sequence")
            ? await RowsAsync(connection, transaction, $"SELECT {Text("name")}, seq, TYPEOF(name), TYPEOF(seq) FROM main.sqlite_sequence ORDER BY name", null,
                budget, reader => ReadSequenceValue(reader, budget), cancellationToken).ConfigureAwait(false)
            : [];
        long applicationId = await ScalarAsync(connection, transaction, "PRAGMA main.application_id", cancellationToken).ConfigureAwait(false);
        long userVersion = await ScalarAsync(connection, transaction, "PRAGMA main.user_version", cancellationToken).ConfigureAwait(false);
        ImmutableArray<string> encoding = await RowsAsync(connection, transaction, "PRAGMA main.encoding", null, budget,
            reader => budget.RequiredText(reader, 0), cancellationToken).ConfigureAwait(false);
        if (encoding.Length != 1 || encoding[0] is not ("UTF-8" or "UTF-16le" or "UTF-16be"))
        {
            throw Failure("sqlite_current_catalog_encoding_not_supported");
        }
        bool foreignKeysEnabled = await ScalarBooleanAsync(connection, transaction, "PRAGMA foreign_keys", cancellationToken).ConfigureAwait(false);
        bool checkConstraintsIgnored = await ScalarBooleanAsync(connection, transaction, "PRAGMA ignore_check_constraints", cancellationToken).ConfigureAwait(false);
        bool recursiveTriggersEnabled = await ScalarBooleanAsync(connection, transaction, "PRAGMA recursive_triggers", cancellationToken).ConfigureAwait(false);
        bool queryOnly = await ScalarBooleanAsync(connection, transaction, "PRAGMA query_only", cancellationToken).ConfigureAwait(false);
        if (await ScalarAsync(connection, transaction, "PRAGMA read_uncommitted", cancellationToken).ConfigureAwait(false) != 0
            || schemaVersion != await ScalarAsync(connection, transaction, "PRAGMA main.schema_version", cancellationToken).ConfigureAwait(false)
            || namespaceFile != await ReadNamespaceAsync(connection, transaction, budget, cancellationToken).ConfigureAwait(false))
        {
            throw Failure("sqlite_current_catalog_session_changed");
        }
        RequireSession(connection, transaction);
        cancellationToken.ThrowIfCancellationRequested();
        return new(namespaceFile, schemaVersion, applicationId, userVersion, encoding[0], foreignKeysEnabled,
            checkConstraintsIgnored, recursiveTriggersEnabled, queryOnly, objects, tables, columns.ToImmutable(),
            indexes.ToImmutable(), foreignKeys.ToImmutable(), violations, sequenceValues);
    }

    private static void RequireSession(DbConnection connection, DbTransaction transaction)
    {
        if (connection?.GetType() != typeof(SqliteConnection) || transaction?.GetType() != typeof(SqliteTransaction)
            || connection.State != ConnectionState.Open || transaction.Connection != connection
            || transaction.IsolationLevel != IsolationLevel.Serializable)
        {
            throw Failure("sqlite_current_catalog_native_serializable_session_required");
        }
    }

    private static async Task<string> ReadNamespaceAsync(DbConnection connection, DbTransaction transaction,
        MetadataBudget budget, CancellationToken cancellationToken)
    {
        ImmutableArray<(string Name, string File)> databases = await RowsAsync(connection, transaction,
            $"SELECT {Text("name")}, {Text("file")} FROM pragma_database_list ORDER BY seq", null, budget,
            reader => (budget.RequiredText(reader, 0), budget.RequiredText(reader, 1)), cancellationToken).ConfigureAwait(false);
        if (databases.Length != 1 || databases[0].Name != "main")
        {
            throw Failure("sqlite_current_catalog_single_main_namespace_required");
        }
        return databases[0].File;
    }

    private static async Task<ImmutableArray<T>> RowsAsync<T>(DbConnection connection, DbTransaction transaction,
        string sql, string? name, MetadataBudget budget, Func<DbDataReader, T> decode, CancellationToken cancellationToken)
    {
        await using DbCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = sql;
        if (name is not null)
        {
            DbParameter parameter = command.CreateParameter();
            parameter.ParameterName = "$name";
            parameter.Value = name;
            command.Parameters.Add(parameter);
        }
        await using DbDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        var rows = ImmutableArray.CreateBuilder<T>();
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            cancellationToken.ThrowIfCancellationRequested();
            budget.AddRow();
            rows.Add(decode(reader));
        }
        return rows.ToImmutable();
    }

    private static async Task<long> ScalarAsync(DbConnection connection, DbTransaction transaction,
        string sql, CancellationToken cancellationToken)
    {
        await using DbCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandText = sql;
        await using DbDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false) || reader.FieldCount != 1 || reader.IsDBNull(0))
        {
            throw Failure("sqlite_current_catalog_scalar_missing");
        }
        long value = reader.GetInt64(0);
        if (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            throw Failure("sqlite_current_catalog_scalar_ambiguous");
        }
        return value;
    }

    private static async Task<bool> ScalarBooleanAsync(DbConnection connection, DbTransaction transaction,
        string sql, CancellationToken cancellationToken)
    {
        return (await ScalarAsync(connection, transaction, sql, cancellationToken).ConfigureAwait(false)) switch
        {
            0 => false,
            1 => true,
            _ => throw Failure("sqlite_current_catalog_boolean_invalid")
        };
    }

    // Byte-prefix first prevents both unbounded native hydration and SQLite's text
    // SUBSTR stopping at embedded NUL. UTF-8/UTF-16 need no more than four bytes per
    // UTF-16 character; oversize text still exceeds the original character limit.
    // Native SUBSTR of an empty BLOB yields NULL. Preserve legitimate empty text
    // before taking the bounded byte prefix; an actual NULL retains NULL through
    // the ELSE branch and remains subject to the original RequiredText refusal.
    private static string Text(string column) => $"CASE WHEN LENGTH(CAST({column} AS BLOB)) = 0 THEN '' ELSE CAST(SUBSTR(CAST({column} AS BLOB), 1, {(OfflineMigrationSourceObserver.MaximumCellCharacters + 1) * 4}) AS TEXT) END";
    private static int Integer(DbDataReader reader, int ordinal) => checked((int)reader.GetInt64(ordinal));

    private static SqliteSequenceValue ReadSequenceValue(DbDataReader reader, MetadataBudget budget)
    {
        // sqlite_sequence has no column affinity. The native GetInt64 conversion
        // would otherwise turn caller-edited text/real/null storage into a false
        // integer fact; unsupported storage is refused before that conversion.
        if (budget.RequiredText(reader, 2) != "text" || budget.RequiredText(reader, 3) != "integer")
        {
            throw Failure("sqlite_current_catalog_sequence_storage_type_invalid");
        }
        return new(budget.RequiredText(reader, 0), reader.GetInt64(1));
    }

    private static bool Boolean(DbDataReader reader, int ordinal) => reader.GetInt64(ordinal) switch
    {
        0 => false,
        1 => true,
        _ => throw Failure("sqlite_current_catalog_boolean_invalid")
    };
    private static InvalidOperationException Failure(string code) => new(code);

    private sealed class MetadataBudget
    {
        private int _rows;
        private int _characters;

        internal void AddRow()
        {
            if (++_rows > OfflineMigrationSourceObserver.MaximumMetadataRows)
            {
                throw Failure("sqlite_current_catalog_metadata_budget_exceeded");
            }
        }

        internal string RequiredText(DbDataReader reader, int ordinal) => NullableText(reader, ordinal)
            ?? throw Failure("sqlite_current_catalog_text_missing");

        internal string? NullableText(DbDataReader reader, int ordinal)
        {
            if (reader.IsDBNull(ordinal))
            {
                return null;
            }
            string value = reader.GetString(ordinal);
            _characters = checked(_characters + value.Length);
            if (value.Contains('\0') || value.Length > OfflineMigrationSourceObserver.MaximumCellCharacters
                || _characters > OfflineMigrationSourceObserver.MaximumMetadataCharacters)
            {
                throw Failure("sqlite_current_catalog_metadata_budget_exceeded");
            }
            return value;
        }
    }
}
