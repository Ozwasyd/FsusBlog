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
            await ApplySchemaAddition(db, tx, "zzzz-comment-author-edit.sql", ct);
        else if (!await CurrentSchema.SupportsPendingCommentAuthorEditAsync(db, tx, ct))
        {
            await using var upgrade = new NpgsqlCommand("""
                alter table public.comment_author_edited
                    drop constraint comment_author_edited_previous_status_check,
                    add constraint comment_author_edited_previous_status_check check (previous_status >= 0 AND previous_status <= 1)
                """, db, tx);
            await upgrade.ExecuteNonQueryAsync(ct);
        }
        if (!await CurrentSchema.SupportsPendingCommentAuthorEditAsync(db, tx, ct))
            throw new InvalidOperationException("The pending comment author edit schema is unavailable.");
        await CurrentSchema.VerifyCatalogAsync(db, tx, ct, requireCommentAuthorEdit: true);
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified signed-in comment author edit schema.");
    }
}
