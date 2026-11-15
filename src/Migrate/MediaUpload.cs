using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeMediaUploadAsync(NpgsqlConnection connection, CancellationToken ct)
    {
        await using var tx = await BeginStoppedSchemaChangeAsync(connection, ct);
        await InstallPreviewSchemaAsync(connection, tx, PreviewSchema.Uploads, "private-media-uploads.sql", ct);
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified private resumable media upload schema.");
    }
}
