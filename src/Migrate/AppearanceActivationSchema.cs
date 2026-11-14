using System.Data;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeAppearanceActivationAsync(NpgsqlConnection db, CancellationToken ct)
    {
        await using var tx = await db.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(db, tx, ct);
        var exists = await CurrentSchema.HasAppearanceActivationAsync(db, tx, ct);
        await CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireAppearanceActivation: exists);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(db, tx, ct);
        if (!exists)
        {
            await ApplySchemaAddition(db, tx, "appearance-activation.sql", ct);
            await CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireAppearanceActivation: true);
        }
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified the optional signed appearance activation schema.");
    }
}
