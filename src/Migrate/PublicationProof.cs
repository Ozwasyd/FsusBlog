using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializePublicationProofAsync(NpgsqlConnection connection, CancellationToken ct)
    {
        await using var tx = await connection.BeginTransactionAsync(ct);
        await PrepareSchemaAddition(connection, tx, ct);
        var exists = await CurrentSchema.HasPublicationProofAsync(connection, tx, ct);
        await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, requirePublicationCanonical: true, requirePublicationProof: exists);
        if (!exists)
        {
            await ApplySchemaAddition(connection, tx, "zzz-publication-proof.sql", ct);
            await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, requirePublicationCanonical: true, requirePublicationProof: true);
        }
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified native v2 publication proof storage.");
    }
}
