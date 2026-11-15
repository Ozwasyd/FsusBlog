using System.Data;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeCommentReportAsync(NpgsqlConnection db, CancellationToken ct)
    {
        await using var tx = await db.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(db, tx, ct);
        var installed = await CurrentSchema.HasCommentReportSchemaAsync(db, tx, ct);
        await CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireCommentReport: installed);
        if (!installed)
        {
            await ApplySchemaAddition(db, tx, "zzzz-comment-report.sql", ct);
            await CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireCommentReport: true);
        }
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified signed-in comment report schema.");
    }
}
