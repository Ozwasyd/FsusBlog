using System.Reflection;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeSiteTrafficAsync(NpgsqlConnection db, CancellationToken ct)
    {
        await using var tx = await BeginStoppedSchemaChangeAsync(db, ct);
        await CurrentSchema.VerifyCatalogAsync(db, tx, ct);
        if (!await CurrentSchema.HasSiteTrafficAsync(db, tx, ct))
        {
            using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("FsusBlogV2.OptionalSchema.site-traffic.sql")
                ?? throw new InvalidOperationException("Site traffic schema resource is missing.");
            using var reader = new StreamReader(stream);
            await ExecuteAsync(db, tx, await reader.ReadToEndAsync(ct), ct);
            await CurrentSchema.VerifyCatalogAsync(db, tx, ct);
        }
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified optional aggregate site traffic schema.");
    }
}
