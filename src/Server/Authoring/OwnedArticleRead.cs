namespace FsusBlog.V2.Server.Authoring;

// A read result, not a transferable authorization token: the caller retains this transaction's lock.
internal readonly record struct OwnedArticleHead(long Revision, long? PublishedRevision);

internal static class OwnedArticleRead
{
    internal static async Task<OwnedArticleHead?> TryLock(NpgsqlConnection db, NpgsqlTransaction tx,
        Guid owner, int article, CancellationToken ct)
    {
        OwnedArticleHead head;
        await using (var read = SqlCommands.Create(db, tx, """
            select revision,published_revision from public.article where id=$1 and owner_id=$2 and not deleted for share
            """, article, owner))
        await using (var row = await read.ExecuteReaderAsync(ct))
        {
            if (!await row.ReadAsync(ct)) return null;
            head = new(row.GetInt64(0), row.IsDBNull(1) ? null : row.GetInt64(1));
        }
        // This must remain a separate statement after the lock wait and reader disposal.
        return await ArchivedArticleAuthority.IsLockedArchived(db, tx, article, ct) ? null : head;
    }
}
