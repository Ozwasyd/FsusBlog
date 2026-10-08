using System.Data;
using System.Data.Common;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

/// <summary>
/// Prepared native identity owner, not an auxiliary copy of a product AUTO_INCREMENT counter.
/// The target PK must actually reference this owner and must not generate independent IDs.
/// Its schema adoption belongs to the prepared-schema owner; reservation never creates DDL.
/// </summary>
internal sealed record DataScaleAutoIncrementIdentityOwner(string Table);

/// <summary>Provisional until the caller's allocation transaction has acknowledged commit.</summary>
internal sealed record DataScaleAutoIncrementIdentityReservationResult(
    string TargetTable, string OwnerTable, string AuthorityDigest,
    IReadOnlyDictionary<string, long> RoleIds, int InsertCommands);

/// <summary>
/// MySQL/SQLite native owner port. IDs come only from actual AUTO_INCREMENT inserts, are
/// reread by role key, and persist with exact authority/alias bindings for concurrent replay.
/// Ordinary product identity tables without this ownership port are explicitly unsupported.
/// MySQL rollback can leave native counter gaps; SQLite can reuse uncommitted IDs. Neither
/// provisional results nor database allocation records are complete seed acceptance receipts.
/// </summary>
internal static class DataScaleAutoIncrementIdentityReservation
{
    internal static string OwnerSchemaSql(DataScaleBulkProvider provider,
        DataScaleAutoIncrementIdentityOwner owner, DbType keyType)
    {
        DataScaleProviderBulkTransport.ValidateIdentifier(owner.Table);
        if (keyType is not (DbType.Int32 or DbType.Int64))
        {
            throw new InvalidOperationException("allocation_owner_key_type_invalid");
        }
        return provider switch
        {
            DataScaleBulkProvider.MySql => $"CREATE TABLE `{owner.Table}` (`id` {(keyType == DbType.Int32 ? "INT" : "BIGINT")} NOT NULL AUTO_INCREMENT PRIMARY KEY,"
                + "`role_key` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL UNIQUE,"
                + "`authority_digest` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,"
                + "`group_digest` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL) ENGINE=InnoDB",
            DataScaleBulkProvider.Sqlite => $"CREATE TABLE \"{owner.Table}\" (\"id\" INTEGER PRIMARY KEY AUTOINCREMENT,"
                + "\"role_key\" TEXT NOT NULL UNIQUE,\"authority_digest\" TEXT NOT NULL,\"group_digest\" TEXT NOT NULL)",
            _ => throw new InvalidOperationException("allocation_owner_provider_unsupported")
        };
    }

    internal static async Task<IReadOnlyList<DataScaleAutoIncrementIdentityReservationResult>> ReserveAsync(
        DbConnection connection, DbTransaction transaction, DataScaleBulkProvider provider,
        IReadOnlyList<DataScaleNativeIdentityTableRequest> requests,
        IReadOnlyDictionary<string, DataScaleAutoIncrementIdentityOwner> owners,
        string authorityDigest, CancellationToken cancellationToken,
        IReadOnlyList<DataScaleAutoIncrementIdentityReservationResult>? originalCommittedAllocations = null)
    {
        string expectedConnection = provider switch
        {
            DataScaleBulkProvider.MySql => "MySqlConnector.MySqlConnection",
            DataScaleBulkProvider.Sqlite => "Microsoft.Data.Sqlite.SqliteConnection",
            _ => throw new InvalidOperationException("allocation_owner_provider_unsupported")
        };
        if (connection.GetType().FullName != expectedConnection || connection.State != ConnectionState.Open
            || transaction.Connection != connection
            || transaction.IsolationLevel != (provider == DataScaleBulkProvider.MySql ? IsolationLevel.ReadCommitted : IsolationLevel.Serializable))
        {
            throw new InvalidOperationException("allocation_owner_transaction_mismatch");
        }
        if (!IsDigest(authorityDigest) || requests.Count is < 1 or > 32
            || requests.Sum(request => (long)request.Groups.Count) > 50_000
            || requests.SelectMany(request => request.Groups).Sum(group => (long)group.SemanticRoles.Count) > 50_000
            || requests.Select(request => request.Table).Distinct(StringComparer.Ordinal).Count() != requests.Count
            || !requests.Select(request => request.Table).ToHashSet(StringComparer.Ordinal).SetEquals(owners.Keys))
        {
            throw new InvalidOperationException("allocation_owner_roster_or_authority_invalid");
        }
        requests = Array.AsReadOnly(requests.Select(request => request with
        {
            Groups = Array.AsReadOnly(request.Groups.Select(group => group with
            {
                SemanticRoles = Array.AsReadOnly(group.SemanticRoles.ToArray())
            }).OrderBy(group => group.AllocationRole, StringComparer.Ordinal).ToArray())
        }).OrderBy(request => request.Table, StringComparer.Ordinal).ToArray());
        owners = new System.Collections.ObjectModel.ReadOnlyDictionary<string, DataScaleAutoIncrementIdentityOwner>(
            new Dictionary<string, DataScaleAutoIncrementIdentityOwner>(owners, StringComparer.Ordinal));
        originalCommittedAllocations = originalCommittedAllocations?.Select(original => original with
        {
            RoleIds = new System.Collections.ObjectModel.ReadOnlyDictionary<string, long>(
                new Dictionary<string, long>(original.RoleIds, StringComparer.Ordinal))
        }).ToArray();
        if (originalCommittedAllocations is not null
            && (originalCommittedAllocations.Count != requests.Count
                || !originalCommittedAllocations.Select(original => original.TargetTable).ToHashSet(StringComparer.Ordinal).SetEquals(owners.Keys)
                || originalCommittedAllocations.Any(original => original.AuthorityDigest != authorityDigest
                    || original.OwnerTable != owners[original.TargetTable].Table
                    || !original.RoleIds.Keys.ToHashSet(StringComparer.Ordinal).SetEquals(requests.Single(request => request.Table == original.TargetTable)
                        .Groups.SelectMany(group => group.SemanticRoles)))))
        {
            throw new InvalidOperationException("allocation_owner_original_authority_mismatch");
        }
        var roles = new HashSet<string>(StringComparer.Ordinal);
        if (owners.Values.Select(owner => owner.Table).Distinct(StringComparer.Ordinal).Count() != owners.Count
            || owners.Values.Any(owner => requests.Any(request => request.Table == owner.Table)))
        {
            throw new InvalidOperationException("allocation_owner_table_domain_conflict");
        }
        foreach (DataScaleNativeIdentityTableRequest request in requests)
        {
            DataScaleProviderBulkTransport.ValidateIdentifier(request.Table);
            DataScaleProviderBulkTransport.ValidateIdentifier(request.PrimaryKey.Name);
            DataScaleProviderBulkTransport.ValidateIdentifier(owners[request.Table].Table);
            if (request.PrimaryKey.Type is not (DbType.Int32 or DbType.Int64) || request.Groups.Count == 0
                || request.Groups.Select(group => group.AllocationRole).Distinct(StringComparer.Ordinal).Count() != request.Groups.Count)
            {
                throw new InvalidOperationException("allocation_owner_key_or_group_invalid");
            }
            foreach (DataScaleNativeIdentityRoleGroup group in request.Groups)
            {
                if (string.IsNullOrWhiteSpace(group.AllocationRole) || group.AllocationRole.Length > 1024
                    || group.SemanticRoles.Count is < 1 or > 256 || !group.SemanticRoles.Contains(group.AllocationRole, StringComparer.Ordinal)
                    || group.SemanticRoles.Any(role => string.IsNullOrWhiteSpace(role) || role.Length > 1024 || !roles.Add(role)))
                {
                    throw new InvalidOperationException("allocation_owner_alias_roster_invalid");
                }
            }
        }
        if (requests.SelectMany(request => request.Groups).Sum(group => (long)Encoding.UTF8.GetByteCount(group.AllocationRole)
            + group.SemanticRoles.Sum(role => (long)Encoding.UTF8.GetByteCount(role))) > 64L * 1024 * 1024
            || requests.Sum(request => (long)request.Groups.Count) > 50_000 || roles.Count > 50_000)
        {
            throw new InvalidOperationException("allocation_owner_snapshot_bound_invalid");
        }
        // Validate all native owner/target metadata before any allocator row is written.
        foreach (DataScaleNativeIdentityTableRequest request in requests)
        {
            await ValidateOwnerAsync(connection, transaction, provider, request, owners[request.Table], cancellationToken).ConfigureAwait(false);
        }
        string savepoint = "native_allocation_" + Guid.NewGuid().ToString("N");
        await transaction.SaveAsync(savepoint, cancellationToken).ConfigureAwait(false);
        try
        {
            var results = new List<DataScaleAutoIncrementIdentityReservationResult>();
            foreach (DataScaleNativeIdentityTableRequest request in requests)
            {
                DataScaleAutoIncrementIdentityOwner owner = owners[request.Table];
                var requested = request.Groups.ToDictionary(group => Hash(new[] { request.Table, group.AllocationRole }),
                    group => (Group: group, Digest: Hash(new { group.AllocationRole, Aliases = group.SemanticRoles.Order(StringComparer.Ordinal).ToArray() })),
                    StringComparer.Ordinal);
                Dictionary<string, long> observed = await ReadAsync(connection, transaction, provider, owner, requested, authorityDigest,
                    request.PrimaryKey.Type, cancellationToken).ConfigureAwait(false);
                if (originalCommittedAllocations is not null)
                {
                    var original = originalCommittedAllocations.Single(allocation => allocation.TargetTable == request.Table);
                    if (observed.Count != requested.Count || requested.Any(pair => pair.Value.Group.SemanticRoles.Any(
                        alias => original.RoleIds[alias] != observed[pair.Key])))
                    {
                        throw new InvalidOperationException("allocation_owner_original_native_identity_changed");
                    }
                }
                var missing = requested.Where(pair => !observed.ContainsKey(pair.Key)).ToArray();
                int insertCommands = 0;
                for (int offset = 0; offset < missing.Length; offset += 256)
                {
                    var chunk = missing.Skip(offset).Take(256).ToArray();
                    await using DbCommand insert = Command(connection, transaction);
                    string Quote(string name) => provider == DataScaleBulkProvider.MySql ? "`" + name + "`" : "\"" + name + "\"";
                    insert.CommandText = $"INSERT INTO {Quote(owner.Table)} ({Quote("role_key")},{Quote("authority_digest")},{Quote("group_digest")}) VALUES "
                        + string.Join(',', Enumerable.Range(0, chunk.Length).Select(index => $"(@r{index},@a,@g{index})"))
                        + (provider == DataScaleBulkProvider.MySql ? " ON DUPLICATE KEY UPDATE `role_key`=`role_key`"
                            : " ON CONFLICT(\"role_key\") DO NOTHING");
                    Add(insert, "@a", authorityDigest);
                    for (int index = 0; index < chunk.Length; index++)
                    {
                        Add(insert, "@r" + index, chunk[index].Key);
                        Add(insert, "@g" + index, chunk[index].Value.Digest);
                    }
                    await insert.ExecuteNonQueryAsync(cancellationToken).ConfigureAwait(false);
                    insertCommands++;
                }
                if (missing.Length != 0)
                {
                    observed = await ReadAsync(connection, transaction, provider, owner, requested, authorityDigest,
                        request.PrimaryKey.Type, cancellationToken).ConfigureAwait(false);
                }
                if (observed.Count != requested.Count || observed.Values.Distinct().Count() != observed.Count)
                {
                    throw new InvalidOperationException("allocation_owner_result_incomplete_or_duplicate");
                }
                var ids = new Dictionary<string, long>(StringComparer.Ordinal);
                foreach (var pair in requested)
                {
                    foreach (string alias in pair.Value.Group.SemanticRoles)
                    {
                        ids.Add(alias, observed[pair.Key]);
                    }
                }
                results.Add(new(request.Table, owner.Table, authorityDigest,
                    new System.Collections.ObjectModel.ReadOnlyDictionary<string, long>(ids), insertCommands));
            }
            await transaction.ReleaseAsync(savepoint, cancellationToken).ConfigureAwait(false);
            return results.AsReadOnly();
        }
        catch (Exception failure)
        {
            // Only this allocation operation is rolled back. Never commit/retry an unknown
            // caller transaction. InnoDB deadlocks can abort the whole transaction instead.
            try
            {
                await transaction.RollbackAsync(savepoint, CancellationToken.None).ConfigureAwait(false);
                await transaction.ReleaseAsync(savepoint, CancellationToken.None).ConfigureAwait(false);
            }
            catch (Exception rollbackFailure)
            {
                throw new AggregateException("allocation_owner_failed_transaction_requires_disposal", failure, rollbackFailure);
            }
            throw;
        }
    }

    private static async Task<Dictionary<string, long>> ReadAsync(DbConnection db, DbTransaction transaction,
        DataScaleBulkProvider provider, DataScaleAutoIncrementIdentityOwner owner,
        IReadOnlyDictionary<string, (DataScaleNativeIdentityRoleGroup Group, string Digest)> requested,
        string authority, DbType keyType, CancellationToken token)
    {
        var result = new Dictionary<string, long>(StringComparer.Ordinal);
        foreach (string[] keys in requested.Keys.Chunk(256))
        {
            await using DbCommand read = Command(db, transaction);
            string Quote(string name) => provider == DataScaleBulkProvider.MySql ? "`" + name + "`" : "\"" + name + "\"";
            read.CommandText = $"SELECT {Quote("role_key")},{Quote("id")},{Quote("authority_digest")},{Quote("group_digest")} FROM {Quote(owner.Table)} WHERE {Quote("role_key")} IN ("
                + string.Join(',', Enumerable.Range(0, keys.Length).Select(index => "@r" + index)) + ")"
                + (provider == DataScaleBulkProvider.MySql ? " FOR UPDATE" : "");
            for (int index = 0; index < keys.Length; index++)
            {
                Add(read, "@r" + index, keys[index]);
            }
            await using DbDataReader reader = await read.ExecuteReaderAsync(token).ConfigureAwait(false);
            while (await reader.ReadAsync(token).ConfigureAwait(false))
            {
                string role = reader.GetString(0);
                long id = reader.GetInt64(1);
                if (!requested.TryGetValue(role, out var expected) || reader.GetString(2) != authority
                    || reader.GetString(3) != expected.Digest || id <= 0 || keyType == DbType.Int32 && id > int.MaxValue
                    || !result.TryAdd(role, id))
                {
                    throw new InvalidOperationException("allocation_owner_stored_binding_conflict");
                }
            }
        }
        return result;
    }

    private static async Task ValidateOwnerAsync(DbConnection db, DbTransaction transaction, DataScaleBulkProvider provider,
        DataScaleNativeIdentityTableRequest target, DataScaleAutoIncrementIdentityOwner owner, CancellationToken token)
    {
        if (provider == DataScaleBulkProvider.MySql)
        {
            // Actual table reads hold transaction metadata locks across preflight and inserts;
            // concurrent DDL must not remove the verified identity/FK owner underneath us.
            await using DbCommand protectSchema = Command(db, transaction);
            protectSchema.CommandText = $"SELECT `{target.PrimaryKey.Name}` FROM `{target.Table}` LIMIT 0;SELECT `id` FROM `{owner.Table}` LIMIT 0";
            await protectSchema.ExecuteNonQueryAsync(token).ConfigureAwait(false);
        }
        else
        {
            await using DbCommand temporary = Command(db, transaction);
            temporary.CommandText = "SELECT COUNT(*) FROM temp.sqlite_schema WHERE name IN (@owner,@target)";
            Add(temporary, "@owner", owner.Table);
            Add(temporary, "@target", target.Table);
            if (Convert.ToInt64(await temporary.ExecuteScalarAsync(token).ConfigureAwait(false)) != 0)
            {
                throw new InvalidOperationException("allocation_owner_temporary_shadow_refused");
            }
        }
        await DataScaleProviderBulkTransport.ValidateNativePrimaryKeysAsync(db, transaction, provider, target.Table, [target.PrimaryKey.Name], token).ConfigureAwait(false);
        await DataScaleProviderBulkTransport.ValidateNativePrimaryKeysAsync(db, transaction, provider, owner.Table, ["id"], token).ConfigureAwait(false);
        if (provider == DataScaleBulkProvider.Sqlite)
        {
            await using DbCommand schema = Command(db, transaction);
            schema.CommandText = "SELECT sql FROM main.sqlite_schema WHERE type='table' AND name=@owner";
            Add(schema, "@owner", owner.Table);
            if ((string?)await schema.ExecuteScalarAsync(token).ConfigureAwait(false) != OwnerSchemaSql(provider, owner, target.PrimaryKey.Type))
            {
                throw new InvalidOperationException("allocation_owner_native_schema_mismatch");
            }
            schema.Parameters.Clear();
            schema.CommandText = "SELECT wr FROM pragma_table_list WHERE schema='main' AND type='table' AND name=@target";
            Add(schema, "@target", target.Table);
            if (Convert.ToInt64(await schema.ExecuteScalarAsync(token).ConfigureAwait(false)) != 1)
            {
                throw new InvalidOperationException("allocation_owner_target_independent_rowid_refused");
            }
            schema.CommandText = $"SELECT COUNT(*) FROM pragma_foreign_key_list('{target.Table}') WHERE \"from\"=@column AND \"table\"=@owner AND \"to\"='id' AND seq=0";
            schema.CommandText += $" AND id IN (SELECT id FROM pragma_foreign_key_list('{target.Table}') GROUP BY id HAVING COUNT(*)=1)";
            Add(schema, "@column", target.PrimaryKey.Name);
            Add(schema, "@owner", owner.Table);
            if (Convert.ToInt64(await schema.ExecuteScalarAsync(token).ConfigureAwait(false)) != 1)
            {
                throw new InvalidOperationException("allocation_owner_target_foreign_key_mismatch");
            }
            schema.Parameters.Clear();
            schema.CommandText = $"SELECT type,\"notnull\",dflt_value,hidden FROM pragma_table_xinfo('{target.Table}') WHERE name=@column";
            Add(schema, "@column", target.PrimaryKey.Name);
            await using (DbDataReader reader = await schema.ExecuteReaderAsync(token).ConfigureAwait(false))
            {
                if (!await reader.ReadAsync(token).ConfigureAwait(false) || reader.GetString(0) != "INTEGER"
                    || reader.GetInt64(1) != 1 || !reader.IsDBNull(2) || reader.GetInt64(3) != 0)
                {
                    throw new InvalidOperationException("allocation_owner_target_key_type_or_generation_mismatch");
                }
            }
            schema.Parameters.Clear();
            schema.CommandText = "SELECT COUNT(*) FROM main.sqlite_schema WHERE type='trigger' AND tbl_name=@owner";
            Add(schema, "@owner", owner.Table);
            if (Convert.ToInt64(await schema.ExecuteScalarAsync(token).ConfigureAwait(false)) != 0)
            {
                throw new InvalidOperationException("allocation_owner_trigger_refused");
            }
            schema.CommandText = "PRAGMA foreign_keys";
            if (Convert.ToInt64(await schema.ExecuteScalarAsync(token).ConfigureAwait(false)) != 1)
            {
                throw new InvalidOperationException("allocation_owner_foreign_key_enforcement_disabled");
            }
            return;
        }
        await using DbCommand inspect = Command(db, transaction);
        inspect.CommandText = "SELECT TABLE_NAME,ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN (@owner,@target)";
        Add(inspect, "@owner", owner.Table);
        Add(inspect, "@target", target.Table);
        int tables = 0;
        await using (DbDataReader reader = await inspect.ExecuteReaderAsync(token).ConfigureAwait(false))
        {
            while (await reader.ReadAsync(token).ConfigureAwait(false))
            {
                if (reader.GetString(1) != "InnoDB")
                {
                    throw new InvalidOperationException("allocation_owner_nontransactional_engine_refused");
                }
                tables++;
            }
        }
        if (tables != 2)
        {
            throw new InvalidOperationException("allocation_owner_table_missing");
        }
        inspect.CommandText = "SELECT COLUMN_NAME,COLUMN_TYPE,EXTRA,IS_NULLABLE,COLLATION_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=@owner";
        var columns = new HashSet<string>(StringComparer.Ordinal);
        await using (DbDataReader reader = await inspect.ExecuteReaderAsync(token).ConfigureAwait(false))
        {
            while (await reader.ReadAsync(token).ConfigureAwait(false))
            {
                string name = reader.GetString(0);
                bool valid = name == "id"
                    ? reader.GetString(1) == (target.PrimaryKey.Type == DbType.Int32 ? "int" : "bigint") && reader.GetString(2) == "auto_increment"
                    : name is "role_key" or "authority_digest" or "group_digest" && reader.GetString(1) == "char(64)"
                        && reader.GetString(2) == "" && !reader.IsDBNull(4) && reader.GetString(4) == "ascii_bin";
                if (!valid || reader.GetString(3) != "NO" || !columns.Add(name))
                {
                    throw new InvalidOperationException("allocation_owner_native_schema_mismatch");
                }
            }
        }
        if (columns.Count != 4)
        {
            throw new InvalidOperationException("allocation_owner_native_schema_mismatch");
        }
        inspect.CommandText = "SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=@owner AND COLUMN_NAME='role_key' AND NON_UNIQUE=0 AND SEQ_IN_INDEX=1 AND SUB_PART IS NULL"
            + " AND INDEX_NAME IN (SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=@owner GROUP BY INDEX_NAME HAVING COUNT(*)=1)";
        if (Convert.ToInt64(await inspect.ExecuteScalarAsync(token).ConfigureAwait(false)) != 1)
        {
            throw new InvalidOperationException("allocation_owner_role_uniqueness_missing");
        }
        inspect.CommandText = "SELECT COLUMN_TYPE,EXTRA,COLUMN_DEFAULT FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=@target AND COLUMN_NAME=@column";
        Add(inspect, "@column", target.PrimaryKey.Name);
        await using (DbDataReader reader = await inspect.ExecuteReaderAsync(token).ConfigureAwait(false))
        {
            if (!await reader.ReadAsync(token).ConfigureAwait(false)
                || reader.GetString(0) != (target.PrimaryKey.Type == DbType.Int32 ? "int" : "bigint")
                || reader.GetString(1) != "" || !reader.IsDBNull(2))
            {
                throw new InvalidOperationException("allocation_owner_target_independent_identity_refused");
            }
        }
        inspect.CommandText = "SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=@target AND COLUMN_NAME=@column AND REFERENCED_TABLE_SCHEMA=DATABASE() AND REFERENCED_TABLE_NAME=@owner AND REFERENCED_COLUMN_NAME='id'"
            + " AND CONSTRAINT_NAME IN (SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME=@target GROUP BY CONSTRAINT_NAME HAVING COUNT(*)=1)";
        if (Convert.ToInt64(await inspect.ExecuteScalarAsync(token).ConfigureAwait(false)) != 1)
        {
            throw new InvalidOperationException("allocation_owner_target_foreign_key_mismatch");
        }
        inspect.CommandText = "SELECT COUNT(*) FROM information_schema.TRIGGERS WHERE TRIGGER_SCHEMA=DATABASE() AND EVENT_OBJECT_TABLE=@owner";
        if (Convert.ToInt64(await inspect.ExecuteScalarAsync(token).ConfigureAwait(false)) != 0)
        {
            throw new InvalidOperationException("allocation_owner_trigger_refused");
        }
        inspect.CommandText = "SELECT @@foreign_key_checks";
        if (Convert.ToInt64(await inspect.ExecuteScalarAsync(token).ConfigureAwait(false)) != 1)
        {
            throw new InvalidOperationException("allocation_owner_foreign_key_enforcement_disabled");
        }
    }

    private static DbCommand Command(DbConnection db, DbTransaction transaction)
    {
        DbCommand command = db.CreateCommand();
        command.Transaction = transaction;
        command.CommandTimeout = 30;
        return command;
    }

    private static void Add(DbCommand command, string name, string value)
    {
        DbParameter parameter = command.CreateParameter();
        parameter.ParameterName = name;
        parameter.DbType = DbType.String;
        parameter.Value = value;
        command.Parameters.Add(parameter);
    }

    private static string Hash<T>(T value) => Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(value)));
    private static bool IsDigest(string value) => value.Length == 64 && !value.AsSpan().ContainsAnyExcept("0123456789abcdef");
}
