using System.Data;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeArticleReadSchemaAsync(NpgsqlConnection db, CancellationToken ct)
    {
        await using var tx = await db.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(db, tx, ct);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(db, tx, ct);
        var installed = await CurrentSchema.HasArticleReadSchemaAsync(db, tx, ct);
        await CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireArticleRead: installed);
        if (!installed)
        {
            await ApplySchemaAddition(db, tx, "article-read.sql", ct);
            await CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireArticleRead: true);
        }
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified the article read aggregate schema.");
    }
}
