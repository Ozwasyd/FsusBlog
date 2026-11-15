using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using Npgsql;

namespace FsusBlog.V2.Server.Authoring;

internal static class RevisionHistoryStore
{
    internal static void RequireRevision(long current, long expected)
    {
        if (current != expected)
            throw new BusinessException(Rejection.Conflict, "The article changed. Reload its current revision.");
    }

    internal static async Task<long> LockCurrent(NpgsqlConnection db, NpgsqlTransaction tx,
        Identity actor, int id, long expected, CancellationToken ct)
        => await LockOwned(db, tx, actor.Id, id, ct, expected);

    internal static async Task<long> LockOwned(NpgsqlConnection db, NpgsqlTransaction tx,
        Guid owner, int id, CancellationToken ct, long? expected = null)
    {
        await using var read = Store.Sql(db, tx, """
            select revision,published_revision from public.article where id=$1 and owner_id=$2 and not deleted for share
            """, id, owner);
        long revision;
        long published;
        await using (var row = await read.ExecuteReaderAsync(ct))
        {
            if (!await row.ReadAsync(ct))
                throw new BusinessException(Rejection.NotFound, "Article not found.");
            revision = row.GetInt64(0);
            published = row.IsDBNull(1) ? 0 : row.GetInt64(1);
        }
        await ArchivedArticleAuthority.RequireLockedAvailability(db, tx, id, ct);
        if (expected is { } required) RequireRevision(revision, required);
        return published;
    }

    internal static async Task<(string Title, string Body, DateTimeOffset HappenedAt)> ReadSource(NpgsqlConnection db, NpgsqlTransaction tx,
        int id, long revision, CancellationToken ct)
    {
        await using var read = Store.Sql(db, tx, """
            select title,body,happened_at from public.article_revision where article_id=$1 and revision=$2
            """, id, revision);
        await using var row = await read.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct))
            throw new BusinessException(Rejection.NotFound, "Article revision not found.");
        return (row.GetString(0), row.GetString(1), row.GetFieldValue<DateTimeOffset>(2));
    }

    internal static async Task<List<RevisionHistoryItem>> Read(NpgsqlConnection db, NpgsqlTransaction tx, int id,
        long expected, long before, CancellationToken ct)
    {
        await using var read = Store.Sql(db, tx, """
            select r.revision,r.title,r.happened_at,a.source_revision,a.reason
            from public.article_revision r
            left join public.article_rollback a using (article_id,revision)
            where r.article_id=$1 and r.revision<=$2 and ($3=0 or r.revision<$3)
            order by r.revision desc limit $4
            """, id, expected, before, WireLimits.RevisionHistoryPageSize + 1);
        var revisions = new List<RevisionHistoryItem>();
        await using var rows = await read.ExecuteReaderAsync(ct);
        while (await rows.ReadAsync(ct))
        {
            revisions.Add(new(rows.GetInt64(0), rows.GetString(1), rows.GetFieldValue<DateTimeOffset>(2).ToUnixTimeMilliseconds(),
                rows.IsDBNull(3) ? 0 : rows.GetInt64(3), rows.IsDBNull(4) ? "" : rows.GetString(4)));
        }
        return revisions;
    }

    internal static async Task RecordRollback(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor, long newRevision,
        DraftRollback input, CancellationToken ct)
    {
        await using var record = Store.Sql(db, tx, """
            insert into public.article_rollback(article_id,revision,previous_revision,source_revision,actor_id,command_id,reason)
            values($1,$2,$3,$4,$5,$6,$7)
            """, input.Id, newRevision, input.ExpectedRevision, input.SourceRevision, actor.Id, input.IdempotencyKey, input.Reason);
        await record.ExecuteNonQueryAsync(ct);
    }
}
