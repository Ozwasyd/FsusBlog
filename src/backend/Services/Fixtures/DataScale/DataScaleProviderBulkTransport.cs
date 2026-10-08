using System.Data;
using System.Data.Common;
using System.Diagnostics;
using System.Text;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

internal enum DataScaleBulkProvider
{
    PostgreSql,
    MySql,
    Sqlite
}

internal enum DataScaleBulkCommitState
{
    Committed,
    RolledBack,
    CommitUncertain,
    RollbackUncertain
}

internal sealed record DataScaleBulkColumn(string Name, DbType Type);

internal sealed record DataScaleBulkTableRows(
    string Table,
    IReadOnlyList<DataScaleBulkColumn> Columns,
    IReadOnlyList<IReadOnlyList<object?>> Rows);

internal sealed record DataScaleBulkPostconditions(string SemanticDigest, IReadOnlyList<string> Violations);

internal sealed record DataScaleBulkExecution(
    DataScaleBulkCommitState State,
    int WriteCommands,
    long RowsSubmitted,
    long ElapsedMilliseconds,
    string? SemanticDigest,
    string? Failure);

/// <summary>
/// Executes already bound physical rows in one transaction. It supplies only provider transport:
/// the canonical host owns factory references, identity binding, dependency order, checkpoints,
/// semantic projection and receipts. A committed transport batch is not verified seed acceptance.
/// </summary>
internal static class DataScaleProviderBulkTransport
{
    private const int MaximumTables = 32;
    private const int MaximumColumns = 128;
    private const long MaximumRows = 50_000;
    private const long MaximumTextBytes = 64L * 1024 * 1024;
    private const int MaximumRowsPerCommand = 256;

    // Current-schema native staging: complete canonical values, no ID column or product
    // placeholders. Each native statement explicitly echoes its role with its own generated
    // ID, so identical inputs and arbitrary result ordering cannot require range prediction.
    // A packet is bounded SQL, not an ORM/HTTP call per article. Native statement counts
    // remain explicit: MySQL lacks INSERT RETURNING and needs a tagged scalar per insert.
    internal static async Task<DataScaleGeneratedIdentityExecution> InsertGeneratedRowsAsync(
        DbConnection connection, DbTransaction transaction, DataScaleBulkProvider provider,
        DataScaleGeneratedIdentityRows input, CancellationToken cancellationToken,
        DataScaleGeneratedIdentityExecution? originalCommitted = null)
    {
        if (provider is not (DataScaleBulkProvider.MySql or DataScaleBulkProvider.Sqlite)
            || transaction.Connection != connection || transaction.IsolationLevel != IsolationLevel.Serializable)
        {
            throw new InvalidOperationException("generated_identity_provider_or_transaction_mismatch");
        }
        ValidateRows(connection, provider, [input.Values]);
        if (input.Roles.Count != input.Values.Rows.Count || input.Roles.Sum(group => (long)group.SemanticRoles.Count) > MaximumRows)
        {
            throw new InvalidOperationException("generated_identity_role_bound_exceeded");
        }
        DataScaleBulkTableRows values = Snapshot([input.Values])[0];
        var groups = input.Roles.Select(group => group with
        {
            SemanticRoles = Array.AsReadOnly(group.SemanticRoles.ToArray())
        }).ToArray();
        ValidateRows(connection, provider, [values]);
        ValidateIdentifier(input.PrimaryKey.Name);
        if (input.PrimaryKey.Type is not (DbType.Int32 or DbType.Int64) || values.Rows.Count == 0
            || groups.Length != values.Rows.Count || values.Columns.Any(column => column.Name == input.PrimaryKey.Name))
        {
            throw new InvalidOperationException("generated_identity_key_or_role_shape_invalid");
        }
        var requested = new Dictionary<string, DataScaleNativeIdentityRoleGroup>(StringComparer.Ordinal);
        var aliases = new HashSet<string>(StringComparer.Ordinal);
        long roleBytes = 0;
        foreach (DataScaleNativeIdentityRoleGroup group in groups)
        {
            if (string.IsNullOrWhiteSpace(group.AllocationRole) || group.AllocationRole.Length > 1024
                || group.SemanticRoles.Count is < 1 or > 256 || !group.SemanticRoles.Contains(group.AllocationRole, StringComparer.Ordinal)
                || !requested.TryAdd(group.AllocationRole, group)
                || group.SemanticRoles.Any(role => string.IsNullOrWhiteSpace(role) || role.Length > 1024 || !aliases.Add(role)))
            {
                throw new InvalidOperationException("generated_identity_role_roster_invalid");
            }
            roleBytes += Encoding.UTF8.GetByteCount(group.AllocationRole) + group.SemanticRoles.Sum(role => (long)Encoding.UTF8.GetByteCount(role));
        }
        if (aliases.Count > MaximumRows || roleBytes > MaximumTextBytes)
        {
            throw new InvalidOperationException("generated_identity_role_bound_exceeded");
        }
        await ValidateGeneratedKeyAsync(connection, transaction, provider, values, input.PrimaryKey, cancellationToken).ConfigureAwait(false);
        // The enclosing host authenticates originalCommitted with its original checkpoint.
        // This transport never invents custody or reallocates a missing/changed original row.
        if (originalCommitted is not null)
        {
            var originalIds = new Dictionary<string, long>(originalCommitted.RoleIds, StringComparer.Ordinal);
            if (!aliases.SetEquals(originalIds.Keys) || groups.Any(group => group.SemanticRoles.Any(
                alias => originalIds[alias] <= 0 || input.PrimaryKey.Type == DbType.Int32 && originalIds[alias] > int.MaxValue
                    || originalIds[alias] != originalIds[group.AllocationRole]))
                || groups.Select(group => originalIds[group.AllocationRole]).Distinct().Count() != groups.Length)
            {
                throw new InvalidOperationException("generated_identity_original_role_mismatch");
            }
            var expectedRows = new DataScaleBulkTableRows(values.Table, new[] { input.PrimaryKey }.Concat(values.Columns).ToArray(),
                values.Rows.Select((row, index) => (IReadOnlyList<object?>)new object?[] { originalIds[groups[index].AllocationRole] }.Concat(row).ToArray()).ToArray());
            var expectedOriginal = new DataScaleArticlePhysicalBatch([expectedRows], new Dictionary<string, int> { [values.Table] = 0 }, [],
                new Dictionary<string, long>());
            var restored = await DataScalePhysicalBatchReadback.ObserveAsync(connection, transaction, provider, expectedOriginal, cancellationToken).ConfigureAwait(false);
            if (restored.Violations.Count != 0 || restored.SemanticDigest != DataScalePhysicalBatchReadback.ExpectedDigest(expectedOriginal))
            {
                throw new InvalidOperationException("generated_identity_original_rows_changed_or_missing");
            }
            return new(new System.Collections.ObjectModel.ReadOnlyDictionary<string, long>(originalIds), expectedRows, 0, 0, true);
        }
        string savepoint = "generated_rows_" + Guid.NewGuid().ToString("N");
        await transaction.SaveAsync(savepoint, cancellationToken).ConfigureAwait(false);
        var returned = new Dictionary<string, long>(StringComparer.Ordinal);
        var nativeIds = new HashSet<long>();
        int commands = 0;
        try
        {
            int parameterLimit = provider == DataScaleBulkProvider.Sqlite ? 999 : 2000;
            int rowsPerCommand = Math.Min(MaximumRowsPerCommand, parameterLimit / (values.Columns.Count + 1));
            string Quote(string name) => provider == DataScaleBulkProvider.MySql ? "`" + name + "`" : "\"" + name + "\"";
            for (int offset = 0; offset < groups.Length; offset += rowsPerCommand)
            {
                int count = Math.Min(rowsPerCommand, groups.Length - offset);
                await using DbCommand insert = connection.CreateCommand();
                insert.Transaction = transaction;
                insert.CommandTimeout = 30;
                var sql = new StringBuilder();
                for (int row = 0; row < count; row++)
                {
                    sql.Append("INSERT INTO ").Append(Quote(values.Table)).Append('(')
                        .AppendJoin(',', values.Columns.Select(column => Quote(column.Name))).Append(") VALUES(");
                    for (int column = 0; column < values.Columns.Count; column++)
                    {
                        string parameterName = "@v" + row + "_" + column;
                        if (column != 0)
                        {
                            sql.Append(',');
                        }
                        sql.Append(parameterName);
                        DbParameter parameter = insert.CreateParameter();
                        parameter.ParameterName = parameterName;
                        parameter.DbType = values.Columns[column].Type;
                        parameter.Value = values.Rows[offset + row][column] ?? DBNull.Value;
                        insert.Parameters.Add(parameter);
                    }
                    string roleName = "@role" + row;
                    DbParameter role = insert.CreateParameter();
                    role.ParameterName = roleName;
                    role.DbType = DbType.String;
                    role.Value = groups[offset + row].AllocationRole;
                    insert.Parameters.Add(role);
                    sql.Append(')').Append(provider == DataScaleBulkProvider.MySql ? ";SELECT " : " RETURNING ")
                        .Append(roleName).Append(" AS fsus_native_role,")
                        .Append(provider == DataScaleBulkProvider.MySql ? "LAST_INSERT_ID()" : Quote(input.PrimaryKey.Name))
                        .Append(" AS fsus_native_id;");
                }
                insert.CommandText = sql.ToString();
                commands++;
                await using DbDataReader reader = await insert.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
                do
                {
                    if (reader.FieldCount == 0)
                    {
                        continue;
                    }
                    if (reader.FieldCount != 2 || reader.GetName(0) != "fsus_native_role" || reader.GetName(1) != "fsus_native_id")
                    {
                        throw new InvalidOperationException("generated_identity_result_shape_mismatch");
                    }
                    while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                    {
                        string role = reader.GetString(0);
                        long id = reader.GetInt64(1);
                        if (!requested.ContainsKey(role) || id <= 0 || input.PrimaryKey.Type == DbType.Int32 && id > int.MaxValue
                            || !returned.TryAdd(role, id) || !nativeIds.Add(id))
                        {
                            throw new InvalidOperationException("generated_identity_result_role_or_id_mismatch");
                        }
                    }
                }
                while (await reader.NextResultAsync(cancellationToken).ConfigureAwait(false));
            }
            if (returned.Count != requested.Count)
            {
                throw new InvalidOperationException("generated_identity_result_incomplete");
            }
            var physical = new DataScaleBulkTableRows(values.Table, new[] { input.PrimaryKey }.Concat(values.Columns).ToArray(),
                values.Rows.Select((row, index) => (IReadOnlyList<object?>)new object?[] { returned[groups[index].AllocationRole] }.Concat(row).ToArray()).ToArray());
            var expected = new DataScaleArticlePhysicalBatch([physical], new Dictionary<string, int> { [values.Table] = 0 }, [],
                new Dictionary<string, long>());
            var observed = await DataScalePhysicalBatchReadback.ObserveAsync(connection, transaction, provider, expected, cancellationToken).ConfigureAwait(false);
            if (observed.Violations.Count != 0 || observed.SemanticDigest != DataScalePhysicalBatchReadback.ExpectedDigest(expected))
            {
                throw new InvalidOperationException("generated_identity_inserted_values_not_exact");
            }
            var ids = new Dictionary<string, long>(StringComparer.Ordinal);
            foreach (DataScaleNativeIdentityRoleGroup group in groups)
            {
                foreach (string alias in group.SemanticRoles)
                {
                    ids.Add(alias, returned[group.AllocationRole]);
                }
            }
            await transaction.ReleaseAsync(savepoint, cancellationToken).ConfigureAwait(false);
            return new(new System.Collections.ObjectModel.ReadOnlyDictionary<string, long>(ids), physical, commands,
                groups.Length * (provider == DataScaleBulkProvider.MySql ? 2 : 1));
        }
        catch (Exception error)
        {
            using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(30));
            try
            {
                await transaction.RollbackAsync(savepoint, cleanup.Token).ConfigureAwait(false);
                await transaction.ReleaseAsync(savepoint, cleanup.Token).ConfigureAwait(false);
            }
            catch (Exception rollback)
            {
                throw new AggregateException("generated_identity_transaction_requires_disposal", error, rollback);
            }
            throw;
        }
    }

    private static async Task ValidateGeneratedKeyAsync(DbConnection db, DbTransaction transaction, DataScaleBulkProvider provider,
        DataScaleBulkTableRows rows, DataScaleBulkColumn key, CancellationToken token)
    {
        await ValidateNativePrimaryKeysAsync(db, transaction, provider, rows.Table, [key.Name], token).ConfigureAwait(false);
        await using DbCommand command = db.CreateCommand();
        command.Transaction = transaction;
        command.CommandTimeout = 30;
        if (provider == DataScaleBulkProvider.MySql)
        {
            command.CommandText = $"SHOW CREATE TABLE `{rows.Table}`";
            await using DbDataReader ddl = await command.ExecuteReaderAsync(token).ConfigureAwait(false);
            if (!await ddl.ReadAsync(token).ConfigureAwait(false) || !ddl.GetString(1).StartsWith("CREATE TABLE ", StringComparison.Ordinal))
            {
                throw new InvalidOperationException("generated_identity_temporary_table_refused");
            }
        }
        if (provider == DataScaleBulkProvider.Sqlite)
        {
            command.CommandText = "SELECT COUNT(*) FROM temp.sqlite_schema WHERE name=@table";
        }
        else
        {
            command.CommandText = "SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=@table";
        }
        DbParameter table = command.CreateParameter();
        table.ParameterName = "@table";
        table.Value = rows.Table;
        command.Parameters.Add(table);
        if (Convert.ToInt64(await command.ExecuteScalarAsync(token).ConfigureAwait(false)) != 0)
        {
            throw new InvalidOperationException("generated_identity_shadow_or_trigger_refused");
        }
        command.CommandText = provider == DataScaleBulkProvider.Sqlite
            ? $"SELECT name,type,pk,hidden FROM pragma_table_xinfo('{rows.Table}','main')"
            : "SELECT COLUMN_NAME,COLUMN_TYPE,EXTRA,0 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=@table";
        var actual = new HashSet<string>(StringComparer.Ordinal);
        bool generated = false;
        await using (DbDataReader reader = await command.ExecuteReaderAsync(token).ConfigureAwait(false))
        {
            while (await reader.ReadAsync(token).ConfigureAwait(false))
            {
                string name = reader.GetString(0);
                actual.Add(name);
                if (name == key.Name)
                {
                    generated = provider == DataScaleBulkProvider.Sqlite
                        ? reader.GetString(1) == "INTEGER" && reader.GetInt64(2) == 1 && reader.GetInt64(3) == 0
                        : reader.GetString(1) == (key.Type == DbType.Int32 ? "int" : "bigint") && reader.GetString(2) == "auto_increment";
                }
            }
        }
        if (!generated || !actual.SetEquals(rows.Columns.Select(column => column.Name).Append(key.Name)))
        {
            throw new InvalidOperationException("generated_identity_native_key_or_complete_columns_mismatch");
        }
        command.CommandText = provider == DataScaleBulkProvider.Sqlite
            ? "SELECT wr FROM pragma_table_list WHERE schema='main' AND name=@table"
            : "SELECT ENGINE='InnoDB' FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=@table";
        if (Convert.ToInt64(await command.ExecuteScalarAsync(token).ConfigureAwait(false)) != (provider == DataScaleBulkProvider.Sqlite ? 0 : 1))
        {
            throw new InvalidOperationException("generated_identity_native_table_kind_mismatch");
        }
    }

    internal static async Task<DataScaleBulkExecution> ExecuteAtomicBatchAsync(
        DbConnection connection,
        DataScaleBulkProvider provider,
        IReadOnlyList<DataScaleBulkTableRows> tables,
        string expectedSemanticDigest,
        Func<DbConnection, DbTransaction, CancellationToken, Task<DataScaleBulkPostconditions>> verify,
        CancellationToken cancellationToken)
        => await ExecuteAtomicBatchAsync(connection, provider, tables, [], expectedSemanticDigest,
            verify, cancellationToken).ConfigureAwait(false);

    // Updates contain the primary key first, then exact final values for deferred columns.
    // Their keys must be among this transaction's inserted rows; this is not a general updater.
    internal static async Task<DataScaleBulkExecution> ExecuteAtomicBatchAsync(
        DbConnection connection,
        DataScaleBulkProvider provider,
        IReadOnlyList<DataScaleBulkTableRows> tables,
        IReadOnlyList<DataScaleBulkTableRows> deferredUpdates,
        string expectedSemanticDigest,
        Func<DbConnection, DbTransaction, CancellationToken, Task<DataScaleBulkPostconditions>> verify,
        CancellationToken cancellationToken)
        => await ExecuteAtomicBatchAsync(connection, provider, tables, deferredUpdates,
            expectedSemanticDigest, verify, null, cancellationToken).ConfigureAwait(false);

    // The graph host reconciles authenticated checkpoints in this very transaction.
    // True writes the absent batch; false requires exact readback and commits no inserts.
    internal static async Task<DataScaleBulkExecution> ExecuteAtomicBatchAsync(
        DbConnection connection,
        DataScaleBulkProvider provider,
        IReadOnlyList<DataScaleBulkTableRows> tables,
        IReadOnlyList<DataScaleBulkTableRows> deferredUpdates,
        string expectedSemanticDigest,
        Func<DbConnection, DbTransaction, CancellationToken, Task<DataScaleBulkPostconditions>> verify,
        Func<DbConnection, DbTransaction, CancellationToken, Task<bool>>? reconcile,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(connection);
        ArgumentNullException.ThrowIfNull(tables);
        ArgumentNullException.ThrowIfNull(deferredUpdates);
        ArgumentNullException.ThrowIfNull(verify);
        Validate(connection, provider, tables, expectedSemanticDigest);
        Validate(connection, provider, deferredUpdates, expectedSemanticDigest);
        tables = Snapshot(tables);
        deferredUpdates = Snapshot(deferredUpdates);
        Validate(connection, provider, tables, expectedSemanticDigest);
        Validate(connection, provider, deferredUpdates, expectedSemanticDigest);
        ValidateUpdates(tables, deferredUpdates);

        var timer = Stopwatch.StartNew();
        int commands = 0;
        long rows = 0;
        bool commitStarted = false;
        string? digest = null;
        await using DbTransaction transaction = await connection.BeginTransactionAsync(
            IsolationLevel.Serializable, cancellationToken).ConfigureAwait(false);
        try
        {
            bool write = reconcile is null || await reconcile(connection, transaction, cancellationToken).ConfigureAwait(false);
            foreach (DataScaleBulkTableRows update in deferredUpdates)
            {
                await ValidateNativeUpdateKeyAsync(connection, transaction, provider, update, cancellationToken).ConfigureAwait(false);
            }
            foreach (DataScaleBulkTableRows table in write ? tables : [])
            {
                int parameterLimit = provider == DataScaleBulkProvider.Sqlite ? 999 : 2000;
                int rowsPerCommand = Math.Min(MaximumRowsPerCommand, parameterLimit / table.Columns.Count);
                for (int offset = 0; offset < table.Rows.Count; offset += rowsPerCommand)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    int count = Math.Min(rowsPerCommand, table.Rows.Count - offset);
                    await using DbCommand command = connection.CreateCommand();
                    command.Transaction = transaction;
                    command.CommandTimeout = 30;
                    command.CommandText = BuildInsert(command, provider, table, offset, count);
                    commands++;
                    await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
                    rows += count;
                }
            }

            foreach (DataScaleBulkTableRows update in write ? deferredUpdates : [])
            {
                int parameterLimit = provider == DataScaleBulkProvider.Sqlite ? 999 : 2000;
                int rowsPerCommand = Math.Min(MaximumRowsPerCommand, parameterLimit / update.Columns.Count);
                for (int offset = 0; offset < update.Rows.Count; offset += rowsPerCommand)
                {
                    cancellationToken.ThrowIfCancellationRequested();
                    int count = Math.Min(rowsPerCommand, update.Rows.Count - offset);
                    await using DbCommand command = connection.CreateCommand();
                    command.Transaction = transaction;
                    command.CommandTimeout = 30;
                    command.CommandText = BuildUpdate(command, provider, update, offset, count);
                    commands++;
                    await command.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
                }
            }

            DataScaleBulkPostconditions postconditions = await verify(
                connection, transaction, cancellationToken).ConfigureAwait(false);
            if (postconditions.Violations.Count != 0
                || !string.Equals(postconditions.SemanticDigest, expectedSemanticDigest, StringComparison.Ordinal))
            {
                throw new InvalidOperationException("bulk_postconditions_failed");
            }
            digest = postconditions.SemanticDigest;
            cancellationToken.ThrowIfCancellationRequested();
            commitStarted = true;
            await transaction.CommitAsync(cancellationToken).ConfigureAwait(false);
            return new(DataScaleBulkCommitState.Committed, commands, rows, timer.ElapsedMilliseconds, digest, null);
        }
        catch (Exception error)
        {
            DataScaleBulkCommitState state = commitStarted
                ? DataScaleBulkCommitState.CommitUncertain
                : DataScaleBulkCommitState.RolledBack;
            try
            {
                // Cleanup has its own bounded lifetime: caller cancellation must not abandon an open transaction.
                using var cleanup = new CancellationTokenSource(TimeSpan.FromSeconds(30));
                await transaction.RollbackAsync(cleanup.Token).ConfigureAwait(false);
            }
            catch (Exception)
            {
                if (!commitStarted)
                {
                    state = DataScaleBulkCommitState.RollbackUncertain;
                }
            }
            return new(state, commands, rows, timer.ElapsedMilliseconds, digest, error.GetType().Name);
        }
    }

    private static IReadOnlyList<DataScaleBulkTableRows> Snapshot(IReadOnlyList<DataScaleBulkTableRows> tables)
        => tables.Select(table => new DataScaleBulkTableRows(table.Table, table.Columns.ToArray(),
            table.Rows.Select(row => (IReadOnlyList<object?>)row.Select(value => value is byte[] bytes ? bytes.ToArray() : value).ToArray()).ToArray())).ToArray();

    private static Task ValidateNativeUpdateKeyAsync(DbConnection connection, DbTransaction transaction,
        DataScaleBulkProvider provider, DataScaleBulkTableRows update, CancellationToken cancellationToken)
        => ValidateNativePrimaryKeysAsync(connection, transaction, provider, update.Table, [update.Columns[0].Name], cancellationToken);

    internal static async Task ValidateNativePrimaryKeysAsync(DbConnection connection, DbTransaction transaction,
        DataScaleBulkProvider provider, string table, IReadOnlyList<string> expected, CancellationToken cancellationToken)
    {
        ValidateIdentifier(table);
        foreach (string column in expected)
        {
            ValidateIdentifier(column);
        }
        await using DbCommand command = connection.CreateCommand();
        command.Transaction = transaction;
        command.CommandTimeout = 30;
        command.CommandText = provider switch
        {
            DataScaleBulkProvider.PostgreSql => "SELECT a.attname FROM pg_index i JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey) WHERE i.indrelid=to_regclass(@table) AND i.indisprimary ORDER BY a.attnum",
            DataScaleBulkProvider.MySql => "SELECT COLUMN_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=@table AND CONSTRAINT_NAME='PRIMARY' ORDER BY ORDINAL_POSITION",
            DataScaleBulkProvider.Sqlite => "SELECT name FROM pragma_table_info(@table) WHERE pk != 0 ORDER BY pk",
            _ => throw new ArgumentOutOfRangeException(nameof(provider))
        };
        DbParameter parameter = command.CreateParameter();
        parameter.ParameterName = "@table";
        parameter.DbType = DbType.String;
        parameter.Value = provider == DataScaleBulkProvider.PostgreSql ? Quote(provider, table) : table;
        command.Parameters.Add(parameter);
        var columns = new List<string>();
        await using DbDataReader reader = await command.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            columns.Add(reader.GetString(0));
        }
        if (columns.Count != expected.Count || !columns.ToHashSet(StringComparer.Ordinal).SetEquals(expected))
        {
            throw new InvalidOperationException("bulk_deferred_update_native_primary_key_mismatch");
        }
    }

    private static void ValidateUpdates(IReadOnlyList<DataScaleBulkTableRows> inserts, IReadOnlyList<DataScaleBulkTableRows> updates)
    {
        foreach (DataScaleBulkTableRows update in updates)
        {
            DataScaleBulkTableRows? insert = inserts.SingleOrDefault(table => table.Table == update.Table);
            if (insert is null || update.Columns.Count < 2 || update.Columns[0].Type is not (DbType.Int32 or DbType.Int64))
            {
                throw new ArgumentException("bulk_deferred_update_shape_invalid", nameof(updates));
            }
            int key = insert.Columns.ToList().IndexOf(update.Columns[0]);
            if (key < 0 || update.Columns.Any(column => !insert.Columns.Contains(column)))
            {
                throw new ArgumentException("bulk_deferred_update_columns_invalid", nameof(updates));
            }
            HashSet<long> owned = insert.Rows.Select(row => Convert.ToInt64(row[key], System.Globalization.CultureInfo.InvariantCulture)).ToHashSet();
            long[] keys = update.Rows.Select(row => Convert.ToInt64(row[0], System.Globalization.CultureInfo.InvariantCulture)).ToArray();
            if (keys.Any(id => id <= 0 || !owned.Contains(id)) || keys.Distinct().Count() != keys.Length)
            {
                throw new ArgumentException("bulk_deferred_update_nonowned_or_duplicate_key", nameof(updates));
            }
        }
    }

    private static string BuildUpdate(DbCommand command, DataScaleBulkProvider provider, DataScaleBulkTableRows table, int offset, int count)
    {
        var sql = new StringBuilder("UPDATE ");
        string key = Quote(provider, table.Columns[0].Name);
        sql.Append(Quote(provider, table.Table)).Append(" SET ");
        for (int column = 1; column < table.Columns.Count; column++)
        {
            if (column != 1)
            {
                sql.Append(", ");
            }
            sql.Append(Quote(provider, table.Columns[column].Name)).Append(" = CASE ").Append(key);
            for (int row = 0; row < count; row++)
            {
                sql.Append(" WHEN @p").Append(row).Append("_0 THEN @p").Append(row).Append('_').Append(column);
            }
            sql.Append(" ELSE ").Append(Quote(provider, table.Columns[column].Name)).Append(" END");
        }
        sql.Append(" WHERE ").Append(key).Append(" IN (");
        sql.AppendJoin(',', Enumerable.Range(0, count).Select(row => $"@p{row}_0"));
        sql.Append(')');
        for (int row = 0; row < count; row++)
        {
            for (int column = 0; column < table.Columns.Count; column++)
            {
                DbParameter parameter = command.CreateParameter();
                parameter.ParameterName = $"@p{row}_{column}";
                parameter.DbType = table.Columns[column].Type;
                parameter.Value = table.Rows[offset + row][column] ?? DBNull.Value;
                command.Parameters.Add(parameter);
            }
        }
        return sql.ToString();
    }

    private static string BuildInsert(
        DbCommand command,
        DataScaleBulkProvider provider,
        DataScaleBulkTableRows table,
        int offset,
        int count)
    {
        var sql = new StringBuilder();
        sql.Append("INSERT INTO ").Append(Quote(provider, table.Table)).Append(" (");
        sql.AppendJoin(", ", table.Columns.Select(column => Quote(provider, column.Name)));
        sql.Append(") VALUES ");
        for (int row = 0; row < count; row++)
        {
            if (row != 0)
            {
                sql.Append(", ");
            }
            sql.Append('(');
            for (int column = 0; column < table.Columns.Count; column++)
            {
                if (column != 0)
                {
                    sql.Append(", ");
                }
                string name = $"@p{row}_{column}";
                sql.Append(name);
                DbParameter parameter = command.CreateParameter();
                parameter.ParameterName = name;
                parameter.DbType = table.Columns[column].Type;
                parameter.Value = table.Rows[offset + row][column] ?? DBNull.Value;
                command.Parameters.Add(parameter);
            }
            sql.Append(')');
        }
        return sql.ToString();
    }

    private static string Quote(DataScaleBulkProvider provider, string identifier)
        => provider == DataScaleBulkProvider.MySql ? $"`{identifier}`" : $"\"{identifier}\"";

    private static void Validate(
        DbConnection connection,
        DataScaleBulkProvider provider,
        IReadOnlyList<DataScaleBulkTableRows> tables,
        string digest)
    {
        ValidateConnection(connection, provider);
        if (digest is null || digest.Length != 71 || !digest.StartsWith("sha256:", StringComparison.Ordinal)
            || digest.AsSpan(7).ContainsAnyExcept("0123456789abcdef"))
        {
            throw new ArgumentException("bulk_expected_digest_invalid", nameof(digest));
        }
        ValidateRows(connection, provider, tables);
    }

    private static void ValidateRows(DbConnection connection, DataScaleBulkProvider provider,
        IReadOnlyList<DataScaleBulkTableRows> tables)
    {
        ValidateConnection(connection, provider);
        if (tables.Count > MaximumTables || tables.Select(table => table.Table).Distinct(StringComparer.Ordinal).Count() != tables.Count)
        {
            throw new ArgumentException("bulk_table_count_or_duplicate_invalid", nameof(tables));
        }
        ValidateRowValues(tables);
    }

    private static void ValidateConnection(DbConnection connection, DataScaleBulkProvider provider)
    {
        string expectedConnection = provider switch
        {
            DataScaleBulkProvider.PostgreSql => "Npgsql.NpgsqlConnection",
            DataScaleBulkProvider.MySql => "MySqlConnector.MySqlConnection",
            DataScaleBulkProvider.Sqlite => "Microsoft.Data.Sqlite.SqliteConnection",
            _ => throw new ArgumentOutOfRangeException(nameof(provider))
        };
        if (connection.GetType().FullName != expectedConnection || connection.State != ConnectionState.Open)
        {
            throw new InvalidOperationException("bulk_provider_connection_mismatch");
        }
    }

    private static void ValidateRowValues(IReadOnlyList<DataScaleBulkTableRows> tables)
    {
        long rows = 0;
        long bytes = 0;
        foreach (DataScaleBulkTableRows table in tables)
        {
            ValidateIdentifier(table.Table);
            if (table.Columns.Count == 0 || table.Columns.Count > MaximumColumns
                || table.Columns.Select(column => column.Name).Distinct(StringComparer.Ordinal).Count() != table.Columns.Count)
            {
                throw new ArgumentException("bulk_columns_invalid", nameof(tables));
            }
            foreach (DataScaleBulkColumn column in table.Columns)
            {
                ValidateIdentifier(column.Name);
                if (!Enum.IsDefined(column.Type))
                {
                    throw new ArgumentException("bulk_column_type_invalid", nameof(tables));
                }
            }
            rows += table.Rows.Count;
            if (rows > MaximumRows)
            {
                throw new ArgumentException("bulk_row_bound_exceeded", nameof(tables));
            }
            foreach (IReadOnlyList<object?> values in table.Rows)
            {
                if (values.Count != table.Columns.Count)
                {
                    throw new ArgumentException("bulk_row_width_mismatch", nameof(tables));
                }
                foreach (object? value in values)
                {
                    bytes += value switch
                    {
                        string text => Encoding.UTF8.GetByteCount(text),
                        byte[] binary => binary.Length,
                        _ => 16
                    };
                    if (bytes > MaximumTextBytes)
                    {
                        throw new ArgumentException("bulk_value_bound_exceeded", nameof(tables));
                    }
                }
            }
        }
    }

    internal static void ValidateIdentifier(string identifier)
    {
        if (string.IsNullOrEmpty(identifier) || identifier.Length > 64
            || !char.IsAsciiLetter(identifier[0])
            || identifier.Any(character => !char.IsAsciiLetterOrDigit(character) && character != '_'))
        {
            throw new ArgumentException("bulk_identifier_invalid", nameof(identifier));
        }
    }
}
