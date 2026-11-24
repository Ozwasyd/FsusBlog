internal static partial class Cli
{
    private static NpgsqlCommand ParameterizedCommand(NpgsqlConnection db, NpgsqlTransaction tx, string text, params object[] args)
    {
        var command = new NpgsqlCommand(text, db, tx);
        foreach (var arg in args)
            command.Parameters.AddWithValue(arg);
        return command;
    }
}
