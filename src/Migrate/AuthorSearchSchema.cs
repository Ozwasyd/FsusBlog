using System.Data;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeAuthorSearchAsync(NpgsqlConnection connection, CancellationToken ct)
    {
        await using var tx = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(connection, tx, ct);
        var exists = await CurrentSchema.HasAuthorTextIndexAsync(connection, tx, ct);
        await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, requireArticleMedia: true, requireAuthorTextIndex: exists);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(connection, tx, ct);
        await CurrentSchema.ReadRecoverySiteIdAsync(connection, tx, ct);
        if (!exists)
        {
            await ApplySchemaAddition(connection, tx, "author-search.sql", ct);
            await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, requireArticleMedia: true, requireAuthorTextIndex: true);
        }
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified the author full-text index schema.");
    }
}
