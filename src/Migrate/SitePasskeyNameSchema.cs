using System.Data;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeSitePasskeyNamesAsync(NpgsqlConnection db, CancellationToken ct)
    {
        await using var tx = await db.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(db, tx, ct);
        await CurrentSchema.VerifyCatalogAsync(db, tx, ct);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(db, tx, ct);
        await CurrentSchema.ReadRecoverySiteIdAsync(db, tx, ct);
        if (!await CurrentSchema.HasSitePasskeyNamesAsync(db, tx, ct))
            await ApplySchemaAddition(db, tx, "site-passkey-name.sql", ct);
        await CurrentSchema.VerifyCatalogAsync(db, tx, ct);
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified the private site Passkey name schema.");
    }
}
