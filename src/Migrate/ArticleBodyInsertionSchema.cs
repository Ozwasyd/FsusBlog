using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeArticleBodyInsertionAsync(NpgsqlConnection connection, CancellationToken ct)
    {
        await using var tx = await BeginStoppedSchemaChangeAsync(connection, ct);
        await CurrentSchema.VerifyCatalogAsync(connection, tx, ct);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(connection, tx, ct);
        await CurrentSchema.ReadRecoverySiteIdAsync(connection, tx, ct);
        if (!await CurrentSchema.HasArticleBodyInsertionAsync(connection, tx, ct))
            await ApplySchemaAddition(connection, tx, "article-body-insertion.sql", ct);
        if (!await CurrentSchema.HasArticleBodyInsertionOperationsAsync(connection, tx, ct))
            await ApplySchemaAddition(connection, tx, "article-body-insertions.sql", ct);
        if (!await CurrentSchema.HasArticleBodyEditsAsync(connection, tx, ct))
        {
            await ApplySchemaAddition(connection, tx, "article-body-splices.sql", ct);
            await CurrentSchema.VerifyCatalogAsync(connection, tx, ct);
        }
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified the saved article body insertion schema.");
    }
}
