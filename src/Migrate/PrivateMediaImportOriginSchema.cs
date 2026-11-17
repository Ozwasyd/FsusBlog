using System.Data;
using System.Reflection;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializePrivateMediaImportOriginAsync(NpgsqlConnection db, CancellationToken ct)
    {
        await using var tx = await db.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(db, tx, ct);
        await CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireArticleMedia: true);
        if (!await CurrentSchema.HasPrivateMediaImportOriginAsync(db, tx, ct))
        {
            using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("FsusBlogV2.OptionalSchema.private-media-import-origin.sql")
                ?? throw new InvalidOperationException("The private-media imported-origin schema is unavailable.");
            using var sql = new StreamReader(stream);
            await ExecuteAsync(db, tx, await sql.ReadToEndAsync(ct), ct);
            await CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireArticleMedia: true);
        }
        if (!await CurrentSchema.HasPrivateMediaImportOriginAsync(db, tx, ct))
            throw new InvalidOperationException("The exact private-media imported-origin schema is unavailable.");
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified private-media imported-origin schema.");
    }
}
