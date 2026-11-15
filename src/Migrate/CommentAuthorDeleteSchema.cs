using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeCommentAuthorDeleteAsync(NpgsqlConnection connection, CancellationToken ct)
    {
        await using var tx = await BeginStoppedSchemaChangeAsync(connection, ct);
        await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, requireArticleMedia: true);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(connection, tx, ct);
        if (!await CurrentSchema.HasCommentAuthorDeleteSchemaAsync(connection, tx, ct))
        {
            // Existing public and imported rows have no enrollment in the author-deletion authority.
            await ApplySchemaAddition(connection, tx, "zz-comment-author-delete.sql", ct);
            await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, requireArticleMedia: true);
        }
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified the signed-in comment author deletion schema.");
    }
}
