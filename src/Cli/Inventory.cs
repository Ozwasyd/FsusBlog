using System.Text.Json;
using Npgsql;

internal static partial class Cli
{
    private static async Task WriteInventoryAsync(NpgsqlConnection connection, bool countRows, CancellationToken token)
    {
        await using var transaction = await BeginReadOnlyAsync(connection, token);
        var target = await ReadTargetAsync(connection, transaction, token);
        var relations = await RelationsAsync(connection, transaction, token);
        var report = new List<RelationInventory>(relations.Count);
        foreach (var relation in relations)
        {
            var columns = await ReadColumnsAsync(connection, transaction, relation, token);
            var keys = await ReadKeysAsync(connection, transaction, relation, token);
            var count = countRows && relation.Kind is "r" or "p"
                ? await CountRowsAsync(connection, transaction, relation, token)
                : (long?)null;
            report.Add(new RelationInventory(relation.Schema, relation.Name, relation.Kind, count, columns, keys));
        }

        await transaction.CommitAsync(token);
        Console.WriteLine(JsonSerializer.Serialize(new { target, serverVersion = connection.ServerVersion, relations = report }, Json));
    }

    private static async Task<List<ColumnInventory>> ReadColumnsAsync(NpgsqlConnection connection,
        NpgsqlTransaction transaction, Relation relation, CancellationToken token)
    {
        await using var command = ForRelation(connection, transaction, relation, """
            SELECT a.attname, pg_catalog.format_type(a.atttypid, a.atttypmod), a.attnotnull,
                a.attidentity::text, a.attgenerated::text
            FROM pg_catalog.pg_namespace n
            JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid
            JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid
            WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
            ORDER BY a.attnum
            """);
        return await ReadInventoryRows(command, static reader => new ColumnInventory(reader.GetString(0), reader.GetString(1),
            reader.GetBoolean(2), reader.GetString(3), reader.GetString(4)), token);
    }

    private static async Task<List<KeyInventory>> ReadKeysAsync(NpgsqlConnection connection,
        NpgsqlTransaction transaction, Relation relation, CancellationToken token)
    {
        await using var command = ForRelation(connection, transaction, relation, """
            SELECT k.conname, k.contype::text, pg_catalog.pg_get_constraintdef(k.oid), k.convalidated
            FROM pg_catalog.pg_namespace n
            JOIN pg_catalog.pg_class c ON c.relnamespace = n.oid
            JOIN pg_catalog.pg_constraint k ON k.conrelid = c.oid
            WHERE n.nspname = $1 AND c.relname = $2 AND k.contype IN ('f','p','u','x')
            ORDER BY k.conname
            """);
        return await ReadInventoryRows(command, static reader => new KeyInventory(reader.GetString(0), reader.GetString(1),
            reader.GetString(2), reader.GetBoolean(3)), token);
    }

    private static async Task<List<T>> ReadInventoryRows<T>(NpgsqlCommand command, Func<NpgsqlDataReader, T> read,
        CancellationToken token)
    {
        var rows = new List<T>();
        await using var reader = await command.ExecuteReaderAsync(token);
        while (await reader.ReadAsync(token)) rows.Add(read(reader));
        return rows;
    }

    private static NpgsqlCommand ForRelation(NpgsqlConnection connection, NpgsqlTransaction transaction, Relation relation, string sql)
    {
        var command = new NpgsqlCommand(sql, connection, transaction);
        command.Parameters.Add(new NpgsqlParameter<string> { TypedValue = relation.Schema });
        command.Parameters.Add(new NpgsqlParameter<string> { TypedValue = relation.Name });
        return command;
    }

    private static async Task<long> CountRowsAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        Relation relation, CancellationToken token)
    {
        using var names = new NpgsqlCommandBuilder();
        var table = names.QuoteIdentifier(relation.Schema) + "." + names.QuoteIdentifier(relation.Name);
        // Count only this ordinary relation. Partition parents report the count for their full subtree.
        var target = relation.Kind == "r" ? "ONLY " + table : table;
        await using var command = new NpgsqlCommand("SELECT count(*) FROM " + target, connection, transaction);
        return (long)(await command.ExecuteScalarAsync(token) ??
            throw new InvalidOperationException("Could not count the source rows."));
    }

    private sealed record ColumnInventory(string Name, string Type, bool NotNull, string Identity, string Generated);
    private sealed record KeyInventory(string Name, string Kind, string Definition, bool Validated);
    private sealed record RelationInventory(string Schema, string Name, string Kind, long? Rows,
        List<ColumnInventory> Columns, List<KeyInventory> Keys);
}
