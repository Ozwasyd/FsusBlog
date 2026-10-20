using System.Data.Common;
using System.Runtime.ExceptionServices;

using FsusBlog.Contracts.Migration;
using FsusBlog.Contracts.Schema;

namespace FsusBlog.Migration;

// Provider rendering consumes the sole current-control model. It does not define
// another column/constraint roster, read history as target, or admit a whole schema.
internal static class OfflineMigrationApplyJournalDialect
{
    internal static string Table(CurrentSchemaProviderKind provider) => provider switch
    {
        CurrentSchemaProviderKind.PostgreSql => "public." + CurrentSchemaControlShape.ApplyJournalTableName,
        CurrentSchemaProviderKind.MySql => "`" + CurrentSchemaControlShape.ApplyJournalTableName + "`",
        CurrentSchemaProviderKind.Sqlite => "main.\"" + CurrentSchemaControlShape.ApplyJournalTableName + "\"",
        _ => throw new InvalidOperationException("offline_apply_native_provider_not_supported")
    };

    internal static string CreateSql(CurrentSchemaProviderKind provider)
    {
        SchemaProviderKind physical = provider switch
        {
            CurrentSchemaProviderKind.MySql => SchemaProviderKind.MySql,
            CurrentSchemaProviderKind.Sqlite => SchemaProviderKind.Sqlite,
            _ => throw new InvalidOperationException("offline_apply_native_provider_not_supported")
        };
        SchemaTableModel shape = CurrentSchemaControlShape.DescribeApplyJournal();
        string Quote(string name) => physical == SchemaProviderKind.MySql ? "`" + name + "`" : "\"" + name + "\"";
        var definitions = shape.Columns.Values.Select(column =>
            $"{Quote(column.Name)} {SchemaPhysicalTypeProjection.ToPhysical(physical, column.DataType, column.MaxLength)}"
            + (physical == SchemaProviderKind.MySql && column.DataType == "string"
                ? " CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin" : string.Empty) + " NOT NULL").ToList();
        foreach (SchemaConstraintModel constraint in shape.Constraints.Values)
        {
            string keys = string.Join(", ", constraint.Columns.Select(Quote));
            string clause = constraint.Kind switch
            {
                "primary-key" => $"PRIMARY KEY ({keys})",
                "unique" => $"UNIQUE ({keys})",
                "check" => $"CHECK ({constraint.Expression})",
                _ => throw new InvalidOperationException("offline_apply_journal_constraint_unavailable")
            };
            definitions.Add($"CONSTRAINT {Quote(constraint.Name)} {clause}");
        }
        return $"CREATE TABLE {Quote(shape.Name)} ({string.Join(", ", definitions)})"
            + (physical == SchemaProviderKind.MySql ? " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_bin" : string.Empty);
    }

    internal static async Task<bool> ExistsAsync(CurrentSchemaProviderKind provider,
        DbConnection connection, DbTransaction transaction, CancellationToken token)
    {
        string sql = provider switch
        {
            CurrentSchemaProviderKind.PostgreSql => "SELECT to_regclass('public.__fsus_schema_offline_apply_journal') IS NOT NULL",
            CurrentSchemaProviderKind.MySql => "SELECT EXISTS(SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=@table)",
            CurrentSchemaProviderKind.Sqlite => "SELECT EXISTS(SELECT 1 FROM main.sqlite_schema WHERE name=@table)",
            _ => throw new InvalidOperationException("offline_apply_native_provider_not_supported")
        };
        object? actual = await UseCommandAsync(connection, transaction, sql,
            provider == CurrentSchemaProviderKind.PostgreSql ? null : "@table", CurrentSchemaControlShape.ApplyJournalTableName,
            command => command.ExecuteScalarAsync(token)).ConfigureAwait(false);
        if (actual is null or DBNull)
            throw ShapeChanged();
        return Convert.ToBoolean(actual);
    }

    internal static async Task CreateSqliteAsync(DbConnection connection, DbTransaction transaction, CancellationToken token)
    {
        await UseCommandAsync(connection, transaction, CreateSql(CurrentSchemaProviderKind.Sqlite), null, string.Empty,
            command => command.ExecuteNonQueryAsync(token)).ConfigureAwait(false);
    }

    internal static async Task ValidateAsync(CurrentSchemaProviderKind provider,
        DbConnection connection, DbTransaction transaction, CancellationToken token)
    {
        if (provider == CurrentSchemaProviderKind.Sqlite)
        {
            await ReadAsync(connection, transaction,
                "SELECT type, sql FROM main.sqlite_schema WHERE name=@table", "@table", CurrentSchemaControlShape.ApplyJournalTableName, token, async reader =>
            {
                if (!await reader.ReadAsync(token).ConfigureAwait(false) || reader.GetString(0) != "table"
                    || reader.GetString(1) != CreateSql(provider) || await reader.ReadAsync(token).ConfigureAwait(false))
                    throw ShapeChanged();
            }).ConfigureAwait(false);
            await ValidateSqliteColumnsAsync(connection, transaction, token).ConfigureAwait(false);
            await ValidateSqliteIndexesAsync(connection, transaction, token).ConfigureAwait(false);
            await RequireNoAttachedEffectsAsync(provider, connection, transaction, token).ConfigureAwait(false);
            return;
        }

        if (provider != CurrentSchemaProviderKind.MySql)
            throw ShapeChanged();
        SchemaTableModel shape = CurrentSchemaControlShape.DescribeApplyJournal();
        await ReadAsync(connection, transaction,
            "SELECT TABLE_TYPE, ENGINE, TABLE_COLLATION, CREATE_OPTIONS, TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=@table", "@table", shape.Name, token, async reader =>
        {
            if (!await reader.ReadAsync(token).ConfigureAwait(false) || reader.GetString(0) != "BASE TABLE"
                || reader.GetString(1) != "InnoDB" || reader.GetString(2) != "utf8mb4_0900_bin"
                || reader.GetString(3).Length != 0 || reader.GetString(4) != shape.Name
                || await reader.ReadAsync(token).ConfigureAwait(false))
                throw ShapeChanged();
        }).ConfigureAwait(false);
        await ReadAsync(connection, transaction, """
            SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLLATION_NAME, GENERATION_EXPRESSION
            FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=@table ORDER BY ORDINAL_POSITION
            """, "@table", shape.Name, token, async reader =>
        {
            foreach (SchemaColumnModel expected in shape.Columns.Values)
            {
                if (!await reader.ReadAsync(token).ConfigureAwait(false) || reader.GetString(0) != expected.Name
                    || reader.GetString(1) != SchemaPhysicalTypeProjection.ToPhysical(SchemaProviderKind.MySql, expected.DataType, expected.MaxLength)
                    || reader.GetString(2) != "NO" || !reader.IsDBNull(3) || reader.GetString(4).Length != 0
                    || (expected.DataType == "string" ? reader.GetString(5) != "utf8mb4_0900_bin" : !reader.IsDBNull(5))
                    || reader.GetString(6).Length != 0)
                    throw ShapeChanged();
            }
            if (await reader.ReadAsync(token).ConfigureAwait(false))
                throw ShapeChanged();
        }).ConfigureAwait(false);
        await ReadAsync(connection, transaction, """
            SELECT tc.CONSTRAINT_NAME, tc.CONSTRAINT_TYPE, tc.ENFORCED,
                k.COLUMN_NAME, k.ORDINAL_POSITION, k.REFERENCED_TABLE_NAME, ck.CHECK_CLAUSE
            FROM information_schema.TABLE_CONSTRAINTS tc
            LEFT JOIN information_schema.KEY_COLUMN_USAGE k ON k.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA
                AND k.TABLE_NAME=tc.TABLE_NAME AND k.CONSTRAINT_NAME=tc.CONSTRAINT_NAME
            LEFT JOIN information_schema.CHECK_CONSTRAINTS ck ON ck.CONSTRAINT_SCHEMA=tc.CONSTRAINT_SCHEMA
                AND ck.CONSTRAINT_NAME=tc.CONSTRAINT_NAME
            WHERE tc.TABLE_SCHEMA=DATABASE() AND tc.TABLE_NAME=@table
            ORDER BY BINARY tc.CONSTRAINT_NAME, k.ORDINAL_POSITION
            """, "@table", shape.Name, token, async reader =>
        {
            foreach (SchemaConstraintModel expected in shape.Constraints.Values.OrderBy(value => value.Kind == "primary-key" ? "PRIMARY" : value.Name, StringComparer.Ordinal))
            {
                string name = expected.Kind == "primary-key" ? "PRIMARY" : expected.Name;
                string kind = expected.Kind switch
                {
                    "primary-key" => "PRIMARY KEY",
                    "unique" => "UNIQUE",
                    "check" => "CHECK",
                    _ => throw ShapeChanged()
                };
                int rows = expected.Kind == "check" ? 1 : expected.Columns.Count;
                for (int index = 0; index < rows; index++)
                {
                    if (!await reader.ReadAsync(token).ConfigureAwait(false) || reader.GetString(0) != name
                        || reader.GetString(1) != kind || reader.GetString(2) != "YES" || !reader.IsDBNull(5))
                        throw ShapeChanged();
                    if (expected.Kind == "check")
                    {
                        // MySQL's exact native spelling of the one sole neutral check.
                        if (!reader.IsDBNull(3) || !reader.IsDBNull(4)
                            || expected.Columns.Count != 1 || expected.Expression is null
                            || reader.GetString(6) != "(" + expected.Expression.Replace(expected.Columns[0], "`" + expected.Columns[0] + "`", StringComparison.Ordinal) + ")")
                            throw ShapeChanged();
                    }
                    else if (reader.GetString(3) != expected.Columns[index] || reader.GetInt64(4) != index + 1 || !reader.IsDBNull(6))
                        throw ShapeChanged();
                }
            }
            if (await reader.ReadAsync(token).ConfigureAwait(false))
                throw ShapeChanged();
        }).ConfigureAwait(false);
        await ReadAsync(connection, transaction, """
            SELECT INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, COLLATION, SUB_PART, INDEX_TYPE, IS_VISIBLE, EXPRESSION
            FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=@table ORDER BY BINARY INDEX_NAME, SEQ_IN_INDEX
            """, "@table", shape.Name, token, async reader =>
        {
            foreach (SchemaConstraintModel expected in shape.Constraints.Values.Where(value => value.Kind != "check")
                .OrderBy(value => value.Kind == "primary-key" ? "PRIMARY" : value.Name, StringComparer.Ordinal))
                for (int index = 0; index < expected.Columns.Count; index++)
                    if (!await reader.ReadAsync(token).ConfigureAwait(false)
                        || reader.GetString(0) != (expected.Kind == "primary-key" ? "PRIMARY" : expected.Name)
                        || reader.GetInt64(1) != 0 || reader.GetInt64(2) != index + 1 || reader.GetString(3) != expected.Columns[index]
                        || reader.GetString(4) != "A" || !reader.IsDBNull(5) || reader.GetString(6) != "BTREE"
                        || reader.GetString(7) != "YES" || !reader.IsDBNull(8))
                        throw ShapeChanged();
            if (await reader.ReadAsync(token).ConfigureAwait(false))
                throw ShapeChanged();
        }).ConfigureAwait(false);
        await RequireNoAttachedEffectsAsync(provider, connection, transaction, token).ConfigureAwait(false);
    }

    private static async Task RequireNoAttachedEffectsAsync(CurrentSchemaProviderKind provider,
        DbConnection connection, DbTransaction transaction, CancellationToken token)
    {
        string sql = provider == CurrentSchemaProviderKind.MySql
            ? "SELECT count(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=@table"
            : "SELECT count(*) FROM main.sqlite_schema WHERE tbl_name=@table AND (type='trigger' OR (type='index' AND sql IS NOT NULL))";
        object? actual = await UseCommandAsync(connection, transaction, sql, "@table", CurrentSchemaControlShape.ApplyJournalTableName,
            command => command.ExecuteScalarAsync(token)).ConfigureAwait(false);
        if (actual is null or DBNull || Convert.ToInt64(actual) != 0)
            throw ShapeChanged();
    }

    private static async Task ValidateSqliteIndexesAsync(DbConnection connection, DbTransaction transaction, CancellationToken token)
    {
        SchemaTableModel shape = CurrentSchemaControlShape.DescribeApplyJournal();
        SchemaConstraintModel[] constraints = shape.Constraints.Values.Where(value => value.Kind != "check").ToArray();
        await ReadAsync(connection, transaction,
            "SELECT name, \"unique\", origin, partial FROM pragma_index_list(@table) ORDER BY name", "@table", shape.Name, token, async reader =>
        {
            for (int index = 0; index < constraints.Length; index++)
                if (!await reader.ReadAsync(token).ConfigureAwait(false)
                    || reader.GetString(0) != $"sqlite_autoindex_{shape.Name}_{index + 1}"
                    || reader.GetInt64(1) != 1 || reader.GetString(2) != (constraints[index].Kind == "primary-key" ? "pk" : "u")
                    || reader.GetInt64(3) != 0)
                    throw ShapeChanged();
            if (await reader.ReadAsync(token).ConfigureAwait(false))
                throw ShapeChanged();
        }).ConfigureAwait(false);
        for (int index = 0; index < constraints.Length; index++)
        {
            await ReadAsync(connection, transaction,
                "SELECT name, \"desc\", coll FROM pragma_index_xinfo(@index) WHERE \"key\"=1 ORDER BY seqno",
                "@index", $"sqlite_autoindex_{shape.Name}_{index + 1}", token, async reader =>
            {
                foreach (string column in constraints[index].Columns)
                    if (!await reader.ReadAsync(token).ConfigureAwait(false) || reader.IsDBNull(0)
                        || reader.GetString(0) != column || reader.GetInt64(1) != 0 || reader.GetString(2) != "BINARY")
                        throw ShapeChanged();
                if (await reader.ReadAsync(token).ConfigureAwait(false))
                    throw ShapeChanged();
            }).ConfigureAwait(false);
        }
    }

    private static async Task ValidateSqliteColumnsAsync(DbConnection connection, DbTransaction transaction, CancellationToken token)
    {
        SchemaTableModel shape = CurrentSchemaControlShape.DescribeApplyJournal();
        SchemaConstraintModel primary = shape.Constraints.Values.Single(value => value.Kind == "primary-key");
        await ReadAsync(connection, transaction,
            "SELECT name, type, \"notnull\", dflt_value, pk, hidden FROM pragma_table_xinfo(@table) ORDER BY cid",
            "@table", shape.Name, token, async reader =>
        {
            foreach (SchemaColumnModel column in shape.Columns.Values)
            {
                int primaryOrdinal = primary.Columns.ToList().IndexOf(column.Name) + 1;
                if (!await reader.ReadAsync(token).ConfigureAwait(false) || reader.GetString(0) != column.Name
                    || reader.GetString(1) != SchemaPhysicalTypeProjection.ToPhysical(SchemaProviderKind.Sqlite, column.DataType, column.MaxLength)
                    || reader.GetInt64(2) != 1 || !reader.IsDBNull(3) || reader.GetInt64(4) != primaryOrdinal
                    || reader.GetInt64(5) != 0)
                    throw ShapeChanged();
            }
            if (await reader.ReadAsync(token).ConfigureAwait(false))
                throw ShapeChanged();
        }).ConfigureAwait(false);
    }

    // Finish each reader before the next native query and retain its primary
    // failure independently of reader/command disposal.
    private static async Task ReadAsync(DbConnection connection, DbTransaction transaction, string sql,
        string parameterName, object parameterValue, CancellationToken token, Func<DbDataReader, Task> read)
    {
        await UseCommandAsync(connection, transaction, sql, parameterName, parameterValue, async command =>
        {
            DbDataReader reader = await command.ExecuteReaderAsync(token).ConfigureAwait(false);
            Exception? first = null;
            try
            {
                await read(reader).ConfigureAwait(false);
            }
            catch (Exception failure)
            {
                first = failure;
            }
            try
            {
                await reader.DisposeAsync().ConfigureAwait(false);
            }
            catch (Exception cleanup)
            {
                first ??= cleanup;
                first.Data[OfflineMigrationStateStore.JournalCleanupFailuresKey] = "offline_apply_journal_command_disposal_failed";
            }
            if (first is not null)
                ExceptionDispatchInfo.Capture(first).Throw();
            return true;
        }).ConfigureAwait(false);
    }

    private static async Task<T> UseCommandAsync<T>(DbConnection connection, DbTransaction transaction,
        string sql, string? parameterName, object parameterValue, Func<DbCommand, Task<T>> execute)
    {
        DbCommand command = OfflineMigrationStateStore.NativeCommand(connection, transaction, sql);
        Exception? first = null;
        T result = default!;
        try
        {
            if (parameterName is not null)
                OfflineMigrationStateStore.Parameter(command, parameterName, parameterValue);
            result = await execute(command).ConfigureAwait(false);
        }
        catch (Exception failure)
        {
            first = failure;
        }
        try
        {
            await command.DisposeAsync().ConfigureAwait(false);
        }
        catch (Exception cleanup)
        {
            first ??= cleanup;
            first.Data[OfflineMigrationStateStore.JournalCleanupFailuresKey] = "offline_apply_journal_command_disposal_failed";
        }
        if (first is not null)
            ExceptionDispatchInfo.Capture(first).Throw();
        return result;
    }

    private static InvalidOperationException ShapeChanged() => new("offline_apply_journal_physical_shape_changed");
}
