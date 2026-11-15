using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeRevisionHistoryAsync(NpgsqlConnection connection, CancellationToken ct)
    {
        await using var tx = await BeginStoppedSchemaChangeAsync(connection, ct);
        await InstallPreviewSchemaAsync(connection, tx, PreviewSchema.Revisions, "revision-rollback.sql", ct);
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified private article revision history schema.");
    }
}
