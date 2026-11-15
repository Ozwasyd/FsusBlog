using System.Data;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeCommentAppealAsync(NpgsqlConnection db, CancellationToken ct)
    {
        await using var tx = await db.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(db, tx, ct);
        if (!await CurrentSchema.HasCommentAppealSchemaAsync(db, tx, ct))
        {
            if (!await CurrentSchema.HasCommentAuthorDeleteSchemaAsync(db, tx, ct))
                throw new InvalidOperationException("Install comment author-delete-schema before comment appeal-schema.");
            await CurrentSchema.VerifyCatalogAsync(db, tx, ct);
            await ApplySchemaAddition(db, tx, "zzz-comment-appeal.sql", ct);
        }
        await CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireCommentAppeal: true);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(db, tx, ct);
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified signed-in comment appeal schema.");
    }
}
