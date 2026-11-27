internal static partial class Cli
{
    private static readonly UTF8Encoding StrictUtf8 = new(false, true);

    internal static Task<int> ExecuteAsync(NpgsqlConnection db, NpgsqlTransaction? tx, string sql, CancellationToken ct, params object[] args) =>
        DatabaseSql.ExecuteAsync(db, tx, ct, sql, args);

    internal static Task<object?> ScalarAsync(NpgsqlConnection db, NpgsqlTransaction? tx, string sql, CancellationToken ct, params object[] args) =>
        DatabaseSql.ScalarAsync(db, tx, ct, sql, args);

    private static async Task<List<T>> QueryListAsync<T>(NpgsqlConnection db, NpgsqlTransaction? tx, string sql,
        Func<NpgsqlDataReader, T> read, CancellationToken ct, params object[] args)
    {
        var rows = new List<T>();
        await using var command = DatabaseSql.Create(db, tx, sql, args);
        await using var reader = await command.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct)) rows.Add(read(reader));
        return rows;
    }

    private static async Task<T> QueryRequiredAsync<T>(NpgsqlConnection db, NpgsqlTransaction? tx, string sql,
        Func<NpgsqlDataReader, T> read, Func<Exception> missing, CancellationToken ct, params object[] args)
    {
        await using var command = DatabaseSql.Create(db, tx, sql, args);
        await using var reader = await command.ExecuteReaderAsync(ct);
        if (!await reader.ReadAsync(ct)) throw missing();
        return read(reader);
    }

    private static async Task ReadAllAsync(NpgsqlConnection db, NpgsqlTransaction? tx, string sql,
        Action<NpgsqlDataReader> read, CancellationToken ct, params object[] args)
    {
        await using var command = DatabaseSql.Create(db, tx, sql, args);
        await using var reader = await command.ExecuteReaderAsync(ct);
        while (await reader.ReadAsync(ct)) read(reader);
    }

    private static async Task<byte[]> ReadBoundedArtifactAsync(Stream input, int limit, CancellationToken ct,
        Func<Exception> invalidSize, Func<Exception> changed)
    {
        var length = input.Length;
        if (length < 1 || length > limit) throw invalidSize();
        var bytes = new byte[(int)length];
        await input.ReadExactlyAsync(bytes, ct);
        if (input.ReadByte() != -1) throw changed();
        return bytes;
    }
}
