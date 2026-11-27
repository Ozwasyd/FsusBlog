namespace FsusBlogV2.Storage;

internal static class DatabaseSql
{
    internal static NpgsqlCommand Create(NpgsqlConnection db, NpgsqlTransaction? tx, string sql, params object[] parameters)
    {
        var command = new NpgsqlCommand(sql, db, tx);
        foreach (var parameter in parameters)
            command.Parameters.Add(parameter is NpgsqlParameter typed ? typed : new NpgsqlParameter { Value = parameter });
        return command;
    }

    internal static async Task<int> ExecuteAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct,
        string sql, params object[] parameters)
    {
        await using var command = Create(db, tx, sql, parameters);
        return await command.ExecuteNonQueryAsync(ct);
    }

    internal static async Task<object?> ScalarAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct,
        string sql, params object[] parameters)
    {
        await using var command = Create(db, tx, sql, parameters);
        return await command.ExecuteScalarAsync(ct);
    }
}
