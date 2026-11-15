using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeSavedViewsAsync(NpgsqlConnection connection, CancellationToken ct)
    {
        await using var tx = await BeginStoppedSchemaChangeAsync(connection, ct);
        var exists = await CurrentSchema.HasSavedViewsAsync(connection, tx, ct);
        await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, requireArticleMedia: true, requireSavedViews: exists);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(connection, tx, ct);
        await CurrentSchema.ReadRecoverySiteIdAsync(connection, tx, ct);
        if (!exists)
            await ApplySchemaAddition(connection, tx, "author-saved-views.sql", ct);
        if (!await CurrentSchema.HasSavedViewPlacementAsync(connection, tx, ct))
            await ApplySchemaAddition(connection, tx, "saved-view-placement.sql", ct);
        await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, requireArticleMedia: true, requireSavedViews: true, requireSavedViewPlacement: true);
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified the author saved views schema.");
    }
}
