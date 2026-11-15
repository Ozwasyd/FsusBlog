using System.Data;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeDocumentExportsAsync(NpgsqlConnection db, CancellationToken ct)
    {
        await using var tx = await db.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(db, tx, ct);
        var exists = await CurrentSchema.HasDocumentExportsAsync(db, tx, ct);
        await CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireDocumentExports: exists);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(db, tx, ct);
        await CurrentSchema.ReadRecoverySiteIdAsync(db, tx, ct);
        if (!exists)
        {
            await ApplySchemaAddition(db, tx, "document-exports.sql", ct);
            await CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireDocumentExports: true);
        }
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified the private author document exports schema.");
    }
}
