using System.Data;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeSitePageEditorAsync(NpgsqlConnection connection, CancellationToken ct)
    {
        await using var tx = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(connection, tx, ct);
        var exists = await CurrentSchema.HasSitePageEditorSchemaAsync(connection, tx, ct);
        await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, requireArticleMedia: true, requireSitePageEditor: exists);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(connection, tx, ct);
        await CurrentSchema.ReadRecoverySiteIdAsync(connection, tx, ct);
        if (!exists)
        {
            await ApplySchemaAddition(connection, tx, "site-page-editor.sql", ct);
            await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, requireArticleMedia: true, requireSitePageEditor: true);
        }
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified the optional site page editor schema.");
    }
}
