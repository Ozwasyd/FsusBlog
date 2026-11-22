using System.Buffers.Binary;
using System.Security.Cryptography;
using Npgsql;
using NpgsqlTypes;

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

    internal static NpgsqlParameter Optional(NpgsqlDbType type, object? value) =>
        new() { NpgsqlDbType = type, Value = value ?? DBNull.Value };

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

    internal static async Task LockCommand(NpgsqlConnection db, NpgsqlTransaction tx, Guid actor, Guid commandKey, CancellationToken ct)
    {
        var scope = new byte[32];
        actor.TryWriteBytes(scope);
        commandKey.TryWriteBytes(scope.AsSpan(16));
        var dedupeLock = BinaryPrimitives.ReadInt64LittleEndian(SHA256.HashData(scope));
        await using var serialize = Create(db, tx, "select pg_advisory_xact_lock($1)", dedupeLock);
        await serialize.ExecuteNonQueryAsync(ct);
    }
}
