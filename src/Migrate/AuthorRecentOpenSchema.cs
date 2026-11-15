using System.Data;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeAuthorRecentOpensAsync(NpgsqlConnection db, CancellationToken ct)
    {
        await using var tx = await db.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(db, tx, ct);
        var exists = await CurrentSchema.HasAuthorRecentOpensAsync(db, tx, ct);
        await CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireArticleMedia: true, requireAuthorRecentOpens: exists);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(db, tx, ct);
        await CurrentSchema.ReadRecoverySiteIdAsync(db, tx, ct);
        if (!exists) await ApplySchemaAddition(db, tx, "author-recent-opens.sql", ct);
        await CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireArticleMedia: true, requireAuthorRecentOpens: true);
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified the author recent opens schema.");
    }
}
