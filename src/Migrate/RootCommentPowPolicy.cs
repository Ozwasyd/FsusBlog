using System.Data;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeRootCommentPowPolicyAsync(NpgsqlConnection db, CancellationToken ct)
    {
        await using var tx = await db.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(db, tx, ct);
        var exists = await CurrentSchema.HasRootCommentPowPolicyAsync(db, tx, ct);
        await CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireRootCommentPowPolicy: exists);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(db, tx, ct);
        if (!exists)
        {
            await ApplySchemaAddition(db, tx, "root-comment-pow-policy.sql", ct);
            await CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireRootCommentPowPolicy: true);
        }
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified the root comment proof policy schema.");
    }
}
