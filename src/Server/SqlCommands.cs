using Npgsql;

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
}
