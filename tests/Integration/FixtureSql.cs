using FsusBlog.V2.Server;
using Npgsql;

namespace FsusBlog.V2.Integration.Tests;

internal static class FixtureSql
{
    internal static async Task<int> ExecuteAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct,
        string sql, params object[] arguments)
    {
        await using var command = Store.Sql(db, tx, sql, arguments);
        return await command.ExecuteNonQueryAsync(ct);
    }

    internal static async Task<object?> ScalarAsync(NpgsqlConnection db, NpgsqlTransaction? tx, CancellationToken ct,
        string sql, params object[] arguments)
    {
        await using var command = Store.Sql(db, tx, sql, arguments);
        return await command.ExecuteScalarAsync(ct);
    }
}
