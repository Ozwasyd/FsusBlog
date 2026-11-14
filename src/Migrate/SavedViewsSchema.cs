using System.Data;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeSavedViewsAsync(NpgsqlConnection connection, CancellationToken ct)
    {
        await using var tx = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(connection, tx, ct);
        var exists = await CurrentSchema.HasSavedViewsAsync(connection, tx, ct);
        await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, requireArticleMedia: true, requireSavedViews: exists);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(connection, tx, ct);
        await CurrentSchema.ReadRecoverySiteIdAsync(connection, tx, ct);
        if (!exists)
        {
            await ApplySchemaAddition(connection, tx, "author-saved-views.sql", ct);
            await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, requireArticleMedia: true, requireSavedViews: true);
        }
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified the author saved views schema.");
    }
}
