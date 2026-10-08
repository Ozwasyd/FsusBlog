using System.Data.Common;

using DbType = System.Data.DbType;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

// Alias groups and role rosters come from the canonical factory, not the provider.
internal sealed record DataScaleNativeIdentityRoleGroup(string AllocationRole, IReadOnlyList<string> SemanticRoles);
internal sealed record DataScaleNativeIdentityTableRequest(string Table, DataScaleBulkColumn PrimaryKey,
    IReadOnlyList<DataScaleNativeIdentityRoleGroup> Groups);
internal sealed record DataScaleNativeIdentityObservation(string Table, string Column, string OwnedSequence,
    IReadOnlyDictionary<string, long> RoleIds, int DatabaseCommands);

/// <summary>
/// Native PostgreSQL sequence transport, matching the existing production identity mechanism.
/// It writes no product rows or business values. Sequences are nontransactional: cancellation
/// may leave gaps, never a qualified graph; the host must durably bind returned roles before writes.
/// Snowflake comments and provider-specific non-sequence identities require their original owners.
/// </summary>
internal static class DataScalePostgresIdentityReservation
{
    internal static async Task<IReadOnlyList<DataScaleNativeIdentityObservation>> ReserveAsync(
        DbConnection connection, DbTransaction transaction,
        IReadOnlyList<DataScaleNativeIdentityTableRequest> requests, CancellationToken cancellationToken)
    {
        if (connection.GetType().FullName != "Npgsql.NpgsqlConnection"
            || connection.State != System.Data.ConnectionState.Open || transaction.Connection != connection)
        {
            throw new InvalidOperationException("native_reservation_postgres_connection_mismatch");
        }
        if (requests.Count is < 1 or > 32 || requests.Select(request => request.Table).Distinct(StringComparer.Ordinal).Count() != requests.Count
            || requests.Sum(request => (long)request.Groups.Count) > 50_000
            || requests.SelectMany(request => request.Groups).Sum(group => (long)group.SemanticRoles.Count) > 50_000)
        {
            throw new InvalidOperationException("native_reservation_roster_bound_invalid");
        }
        var roles = new HashSet<string>(StringComparer.Ordinal);
        foreach (DataScaleNativeIdentityTableRequest request in requests)
        {
            DataScaleProviderBulkTransport.ValidateIdentifier(request.Table);
            DataScaleProviderBulkTransport.ValidateIdentifier(request.PrimaryKey.Name);
            if (request.PrimaryKey.Type is not (DbType.Int32 or DbType.Int64)
                || request.Groups.Select(group => group.AllocationRole).Distinct(StringComparer.Ordinal).Count() != request.Groups.Count)
            {
                throw new InvalidOperationException("native_reservation_key_or_group_invalid");
            }
            foreach (DataScaleNativeIdentityRoleGroup group in request.Groups)
            {
                if (string.IsNullOrWhiteSpace(group.AllocationRole) || group.AllocationRole.Length > 1024
                    || group.SemanticRoles.Count is < 1 or > 256
                    || group.SemanticRoles.Any(role => string.IsNullOrWhiteSpace(role) || role.Length > 1024 || !roles.Add(role)))
                {
                    throw new InvalidOperationException("native_reservation_alias_roster_invalid");
                }
            }
        }
        // Preflight every actual PK/owned sequence before the first nextval. A missing
        // sequence (e.g. Snowflake comment PK), cycling sequence or drift is a refusal.
        var sequences = new List<string>();
        foreach (DataScaleNativeIdentityTableRequest request in requests)
        {
            await using DbCommand inspect = connection.CreateCommand();
            inspect.Transaction = transaction;
            inspect.CommandTimeout = 30;
            inspect.CommandText = """
                SELECT a.attname, a.atttypid::regtype::text,
                       s.seqrelid::regclass::text, s.seqincrement, s.seqcycle
                FROM pg_index i
                JOIN pg_attribute a ON a.attrelid=i.indrelid AND a.attnum=ANY(i.indkey)
                LEFT JOIN pg_sequence s ON s.seqrelid=to_regclass(pg_get_serial_sequence(@table,@column))
                WHERE i.indrelid=to_regclass(@table) AND i.indisprimary
                """;
            Add(inspect, "@table", "\"" + request.Table + "\"");
            Add(inspect, "@column", request.PrimaryKey.Name);
            await using DbDataReader reader = await inspect.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
            if (!await reader.ReadAsync(cancellationToken).ConfigureAwait(false)
                || reader.GetString(0) != request.PrimaryKey.Name
                || reader.GetString(1) != (request.PrimaryKey.Type == DbType.Int32 ? "integer" : "bigint")
                || reader.IsDBNull(2) || reader.GetInt64(3) <= 0 || reader.GetBoolean(4))
            {
                throw new InvalidOperationException("native_reservation_owned_sequence_or_primary_key_mismatch");
            }
            string sequence = reader.GetString(2);
            if (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
            {
                throw new InvalidOperationException("native_reservation_compound_primary_key_refused");
            }
            sequences.Add(sequence);
        }
        var result = new List<DataScaleNativeIdentityObservation>();
        for (int table = 0; table < requests.Count; table++)
        {
            DataScaleNativeIdentityTableRequest request = requests[table];
            var ids = new Dictionary<string, long>(StringComparer.Ordinal);
            var unique = new HashSet<long>();
            int commands = 1;
            for (int offset = 0; offset < request.Groups.Count; offset += 256)
            {
                int count = Math.Min(256, request.Groups.Count - offset);
                await using DbCommand reserve = connection.CreateCommand();
                reserve.Transaction = transaction;
                reserve.CommandTimeout = 30;
                Add(reserve, "@sequence", sequences[table]);
                for (int index = 0; index < count; index++)
                {
                    Add(reserve, "@r" + index, request.Groups[offset + index].AllocationRole);
                }
                reserve.CommandText = "SELECT requested.role,nextval(@sequence::regclass)::bigint FROM (VALUES "
                    + string.Join(',', Enumerable.Range(0, count).Select(index => "(@r" + index + ")")) + ") AS requested(role)";
                var groups = request.Groups.Skip(offset).Take(count).ToDictionary(group => group.AllocationRole, StringComparer.Ordinal);
                await using DbDataReader reader = await reserve.ExecuteReaderAsync(cancellationToken).ConfigureAwait(false);
                while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
                {
                    string role = reader.GetString(0);
                    long id = reader.GetInt64(1);
                    if (!groups.Remove(role, out DataScaleNativeIdentityRoleGroup? group) || id <= 0 || !unique.Add(id)
                        || request.PrimaryKey.Type == DbType.Int32 && id > int.MaxValue)
                    {
                        throw new InvalidOperationException("native_reservation_result_role_or_id_invalid");
                    }
                    foreach (string alias in group.SemanticRoles)
                    {
                        ids.Add(alias, id);
                    }
                }
                if (groups.Count != 0)
                {
                    throw new InvalidOperationException("native_reservation_result_incomplete");
                }
                commands++;
            }
            result.Add(new(request.Table, request.PrimaryKey.Name, sequences[table],
                new System.Collections.ObjectModel.ReadOnlyDictionary<string, long>(ids), commands));
        }
        return result.AsReadOnly();
    }

    private static void Add(DbCommand command, string name, string value)
    {
        DbParameter parameter = command.CreateParameter();
        parameter.ParameterName = name;
        parameter.DbType = DbType.String;
        parameter.Value = value;
        command.Parameters.Add(parameter);
    }
}
