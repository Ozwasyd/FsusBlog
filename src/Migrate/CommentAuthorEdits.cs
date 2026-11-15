using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializeCommentAuthorEditAsync(NpgsqlConnection db, CancellationToken ct)
    {
        await using var tx = await BeginStoppedSchemaChangeAsync(db, ct);
        if (!await CurrentSchema.HasCommentAuthorDeleteSchemaAsync(db, tx, ct))
            throw new InvalidOperationException("Install comment author-delete-schema before comment author-edit-schema.");

        var installed = await CurrentSchema.HasCommentAuthorEditSchemaAsync(db, tx, ct);
        await CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireCommentAuthorEdit: installed);
        await CurrentSchema.VerifyAdminIdentityMarkerAsync(db, tx, ct);
        if (!installed)
        {
            await ApplySchemaAddition(db, tx, "zzzz-comment-author-edit.sql", ct);
            await CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireCommentAuthorEdit: true);
        }
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified signed-in comment author edit schema.");
    }
}
