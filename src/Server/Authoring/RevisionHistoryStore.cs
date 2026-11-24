using FsusBlogV2.Storage;
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
        var head = await OwnedArticleRead.TryLock(db, tx, owner, id, ct)
            ?? throw new BusinessException(Rejection.NotFound, "Article not found.");
        if (expected is { } required) RequireRevision(head.Revision, required);
        return head.PublishedRevision ?? 0;
    }

    internal static Task<(string Title, string Body, DateTimeOffset HappenedAt)> ReadSource(NpgsqlConnection db, NpgsqlTransaction tx,
        int id, long revision, CancellationToken ct) =>
        SqlCommands.QueryRequired(db, tx, ct, "select title,body,happened_at from public.article_revision where article_id=$1 and revision=$2",
            r => (r.GetString(0), r.GetString(1), r.GetFieldValue<DateTimeOffset>(2)),
            () => new BusinessException(Rejection.NotFound, "Article revision not found."), id, revision);

    internal static Task<List<RevisionHistoryItem>> Read(NpgsqlConnection db, NpgsqlTransaction tx, int id,
        long expected, long before, CancellationToken ct) =>
        SqlCommands.QueryList(db, tx, ct, """
            select r.revision,r.title,r.happened_at,a.source_revision,a.reason
            from public.article_revision r
            left join public.article_rollback a using (article_id,revision)
            where r.article_id=$1 and r.revision<=$2 and ($3=0 or r.revision<$3)
            order by r.revision desc limit $4
            """, r => new RevisionHistoryItem(r.GetInt64(0), r.GetString(1), r.GetUnixMilliseconds(2),
                r.IsDBNull(3) ? 0 : r.GetInt64(3), r.IsDBNull(4) ? "" : r.GetString(4)),
            id, expected, before, WireLimits.RevisionHistoryPageSize + 1);

    internal static async Task<(SavedRevisionMetadata Current, SavedRevisionMetadata Source)> ReadMetadata(
        NpgsqlConnection db, NpgsqlTransaction tx, int id, long expected, long source, CancellationToken ct)
    {
        await using var query = SqlCommands.Create(db, tx, """
            select r.revision,coalesce(r.author_summary,''),c.id,c.name,t.ids,t.names
            from public.article_revision r
            left join public.article_revision_category rc using (article_id,revision)
            left join public.category c on c.id=rc.category_id
            left join lateral (
                select array_agg(tag.id order by tag.id) as ids,array_agg(tag.name order by tag.id) as names
                from public.article_revision_tag rt join public.tag tag on tag.id=rt.tag_id
                where (rt.article_id,rt.revision)=(r.article_id,r.revision)
            ) t on true
            where r.article_id=$1 and r.revision in ($2,$3) order by r.revision desc
            """, id, expected, source);
        await using var rows = await query.ExecuteReaderAsync(ct);
        return (await ReadOne(expected), await ReadOne(source));

        async Task<SavedRevisionMetadata> ReadOne(long revision)
        {
            if (!await rows.ReadAsync(ct) || rows.GetInt64(0) != revision)
                throw new BusinessException(Rejection.NotFound, "Article revision metadata is unavailable.");
            var category = rows.IsDBNull(2) ? null : new TaxonomyName(rows.GetInt32(2), rows.GetString(3));
            var tags = rows.IsDBNull(4) ? [] : rows.GetFieldValue<int[]>(4).Zip(rows.GetFieldValue<string[]>(5),
                (tagId, name) => new TaxonomyName(tagId, name)).ToArray();
            return new(rows.GetString(1), category, tags);
        }
    }

    internal static async Task RecordRollback(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor, long newRevision,
        DraftRollback input, CancellationToken ct)
    {
        await SqlCommands.Execute(db, tx, ct, """
            insert into public.article_rollback(article_id,revision,previous_revision,source_revision,actor_id,command_id,reason)
            values($1,$2,$3,$4,$5,$6,$7)
            """, input.Id, newRevision, input.ExpectedRevision, input.SourceRevision, actor.Id, input.IdempotencyKey, input.Reason);
    }
}
