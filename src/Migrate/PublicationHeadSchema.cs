using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializePublicationHeadAsync(NpgsqlConnection db, CancellationToken ct)
    {
        await using var tx = await db.BeginTransactionAsync(ct);
        await PrepareSchemaAddition(db, tx, ct);
        var exists = await CurrentSchema.HasPublicationHeadAsync(db, tx, ct);
        await CurrentSchema.VerifyCatalogAsync(db, tx, ct, requirePublicationTransparency: true, requirePublicationHead: exists);
        if (!exists)
        {
            await ApplySchemaAddition(db, tx, "zzzzz-publication-head.sql", ct);
            await CurrentSchema.VerifyCatalogAsync(db, tx, ct, requirePublicationTransparency: true, requirePublicationHead: true);
        }
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified native public head storage. No historical head was signed.");
    }
}
