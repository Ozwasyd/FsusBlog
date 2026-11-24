namespace FsusBlog.V2.Server;

internal static class SqlCommands
{
    internal static NpgsqlCommand Create(NpgsqlConnection db, NpgsqlTransaction? transaction, string sql, params object[] parameters)
    {
        var command = new NpgsqlCommand(sql, db, transaction);
        foreach (var parameter in parameters)
            command.Parameters.Add(parameter is NpgsqlParameter typed ? typed : new NpgsqlParameter { Value = parameter });
        return command;
    }

    internal static long GetUnixMilliseconds(this NpgsqlDataReader reader, int column) =>
        reader.GetFieldValue<DateTimeOffset>(column).ToUnixTimeMilliseconds();

    internal static NpgsqlParameter Optional(NpgsqlDbType type, object? value) =>
        new() { NpgsqlDbType = type, Value = value ?? DBNull.Value };

    internal static bool TrimPage<T>(List<T> items, int limit)
    {
        if (items.Count <= limit) return false;
        items.RemoveAt(limit);
        return true;
    }

    internal static async Task<int> Execute(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct, string sql, params object[] parameters)
    {
        await using var command = Create(db, tx, sql, parameters);
        return await command.ExecuteNonQueryAsync(ct);
    }

    internal static async Task<object?> Scalar(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct, string sql, params object[] parameters)
    {
        await using var command = Create(db, tx, sql, parameters);
        return await command.ExecuteScalarAsync(ct);
    }

    internal static async Task<T?> QueryOne<T>(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct, string sql,
        Func<NpgsqlDataReader, T> read, params object[] parameters) where T : class
    {
        await using var command = Create(db, tx, sql, parameters);
        await using var row = await command.ExecuteReaderAsync(ct);
        return await row.ReadAsync(ct) ? read(row) : null;
    }

    internal static async Task<T?> QueryOneValue<T>(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct, string sql,
        Func<NpgsqlDataReader, T> read, params object[] parameters) where T : struct
    {
        await using var command = Create(db, tx, sql, parameters);
        await using var row = await command.ExecuteReaderAsync(ct);
        return await row.ReadAsync(ct) ? read(row) : null;
    }

    internal static async Task<T> QueryRequired<T>(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct, string sql,
        Func<NpgsqlDataReader, T> read, Func<Exception>? missing, params object[] parameters)
    {
        await using var command = Create(db, tx, sql, parameters);
        await using var row = await command.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct)) throw missing?.Invoke() ?? new InvalidOperationException("Query returned no row.");
        return read(row);
    }

    internal static async Task<List<T>> QueryList<T>(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct, string sql,
        Func<NpgsqlDataReader, T> read, params object[] parameters)
    {
        List<T> items = [];
        await ReadAll(db, tx, ct, sql, r => items.Add(read(r)), parameters);
        return items;
    }

    internal static async Task ReadAll(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct, string sql,
        Action<NpgsqlDataReader> read, params object[] parameters)
    {
        await using var command = Create(db, tx, sql, parameters);
        await using var rows = await command.ExecuteReaderAsync(ct);
        while (await rows.ReadAsync(ct)) read(rows);
    }

    internal static Task LockCommand(NpgsqlConnection db, NpgsqlTransaction tx, Guid actor, Guid commandKey, CancellationToken ct)
    {
        var scope = new byte[32];
        actor.TryWriteBytes(scope);
        commandKey.TryWriteBytes(scope.AsSpan(16));
        return Execute(db, tx, ct, "select pg_advisory_xact_lock($1)", BinaryPrimitives.ReadInt64LittleEndian(SHA256.HashData(scope)));
    }
}
