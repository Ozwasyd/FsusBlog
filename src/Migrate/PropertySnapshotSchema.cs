using System.Data;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializePropertySnapshotsAsync(NpgsqlConnection db, CancellationToken ct)
    {
        await using var tx = await db.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(db, tx, ct);
        await CurrentSchema.VerifyCatalogAsync(db, tx, ct);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(db, tx, ct);
        await CurrentSchema.ReadRecoverySiteIdAsync(db, tx, ct);
        if (!await CurrentSchema.HasPropertySnapshotsAsync(db, tx, ct))
            await ApplySchemaAddition(db, tx, "property-snapshots.sql", ct);
        await CurrentSchema.VerifyCatalogAsync(db, tx, ct);
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified the private article property snapshot schema.");
    }
}
