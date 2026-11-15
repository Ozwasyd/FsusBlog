using Npgsql;

internal static partial class Migration
{
    private static async Task InitializePublicationRightsAsync(NpgsqlConnection connection, CancellationToken ct)
    {
        await using var tx = await BeginStoppedSchemaChangeAsync(connection, ct);
        await InstallPreviewSchemaAsync(connection, tx, PreviewSchema.Rights, "publication-rights.sql", ct);
        await ReportMissingPublicationRights(connection, tx, ct);
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified publication rights storage.");
    }

    private static async Task ReportMissingPublicationRights(NpgsqlConnection connection, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using var cmd = new NpgsqlCommand("""
            select count(*) from public.article_publication p where not exists (
                select from public.article_publication_rights s
                where s.article_id=p.article_id and s.publication_id=p.publication_id and s.revision=p.revision
            )
            """, connection, tx);
        if (await cmd.ExecuteScalarAsync(ct) is long count && count != 0)
            Console.WriteLine($"Publication rights: {count} active coordinates have no exact rights snapshot and are excluded from public reads.");
    }
}
