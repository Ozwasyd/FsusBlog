using FsusBlog.V2.Core;
using Npgsql;
using NpgsqlTypes;

namespace FsusBlog.V2.Server.Authoring;

internal static class PublicationHistoryStore
{
    private sealed record ActivePublication(long Id, long Revision, int Number, DateTime PublishedAt);

    // Store.Execute owns the article row lock and has already written the new private revision and command.
    internal static async Task Apply(NpgsqlConnection db, NpgsqlTransaction tx, Guid actor, Guid command,
        ArticleAction action, ArticleState prior, ArticleState next, CancellationToken ct)
    {
        int publicationCount;
        int eventNo;
        ActivePublication? active;
        await using (var read = Store.Sql(db, tx, """
            select a.publication_count,p.publication_id,p.revision,p.publication_no,p.published_at,
                   h.event_no,h.publication_no,h.publication_id
            from public.article a
            left join public.article_publication p on p.article_id=a.id
            left join lateral (
                select event_no,publication_no,publication_id from public.article_publication_history
                where article_id=a.id order by event_no desc limit 1
            ) h on true
            where a.id=$1
            """, prior.Id))
        await using (var row = await read.ExecuteReaderAsync(ct))
        {
            if (!await row.ReadAsync(ct)) throw new InvalidOperationException("Article disappeared inside a locked write.");
            publicationCount = row.GetInt32(0);
            active = row.IsDBNull(1) ? null : new(row.GetInt64(1), row.GetInt64(2), row.GetInt32(3), row.GetDateTime(4));
            eventNo = row.IsDBNull(5) ? 0 : row.GetInt32(5);
            long? tailId = row.IsDBNull(7) ? null : row.GetInt64(7);
            if (prior.PublishedRevision != active?.Revision || (active is not null && active.Number != publicationCount) ||
                (eventNo != 0 && (row.GetInt32(6) != publicationCount || tailId != active?.Id)))
                throw new InvalidOperationException("Active and historical publication coordinates disagree.");
        }
        // Offline upgrade captures every existing lineage. Direct imports can supply the same retained boundary on first write.
        if (eventNo == 0 && publicationCount > 0)
        {
            await Append(active?.Revision ?? prior.Revision, ++eventNo, publicationCount, active?.Id, null,
                active is null ? "retained-hidden" : "retained-active", "pre-history", active?.PublishedAt, null, null);
        }

        if (action == ArticleAction.Publish)
        {
            var published = await Publish(db, tx, next, ct);
            await Append(next.Revision, checked(eventNo + 1), published.Number, published.Id, active?.Id,
                active is null ? "publish" : "replace", active is null ? "author-published" : "author-replaced",
                published.PublishedAt, actor, command);
        }
        else
        {
            await using var remove = Store.Sql(db, tx, "delete from public.article_publication where article_id=$1", next.Id);
            await remove.ExecuteNonQueryAsync(ct);
            await using var clock = Store.Sql(db, tx, "select clock_timestamp()");
            var now = (DateTime)(await clock.ExecuteScalarAsync(ct))!;
            var delete = action == ArticleAction.Delete;
            await Append(next.Revision, checked(eventNo + 1), publicationCount, null, active?.Id,
                delete ? "delete" : "retract", delete ? "author-deleted" : "author-withdrew", now, actor, command);
        }

        async Task Append(long revision, int number, int publications, long? publication, long? supersedes,
            string kind, string reason, DateTime? at, Guid? author, Guid? commandId)
        {
            await using var insert = Store.Sql(db, tx, """
                insert into public.article_publication_history
                    (article_id,event_no,revision,publication_no,publication_id,supersedes_id,kind,reason,happened_at,actor_id,command_id)
                values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                """, next.Id, number, revision, publications, Optional(NpgsqlDbType.Bigint, publication),
                Optional(NpgsqlDbType.Bigint, supersedes), kind, reason, Optional(NpgsqlDbType.TimestampTz, at),
                Optional(NpgsqlDbType.Uuid, author), Optional(NpgsqlDbType.Uuid, commandId));
            await insert.ExecuteNonQueryAsync(ct);
        }
    }

    private static async Task<ActivePublication> Publish(NpgsqlConnection db, NpgsqlTransaction tx, ArticleState state, CancellationToken ct)
    {
        await using var publish = Store.Sql(db, tx, """
            with next_publication as (
                update public.article set publication_count=publication_count+1 where id=$1 returning publication_count
            )
            insert into public.article_publication(article_id,revision,publication_no,published_at)
                select $1,$2,publication_count,clock_timestamp() from next_publication
            on conflict(article_id) do update set revision=excluded.revision,publication_no=excluded.publication_no,
                published_at=excluded.published_at,publication_id=excluded.publication_id
            returning publication_id,publication_no,published_at
            """, state.Id, state.Revision);
        await using var row = await publish.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct)) throw new InvalidOperationException("Could not record the new publication.");
        return new(row.GetInt64(0), state.Revision, row.GetInt32(1), row.GetDateTime(2));
    }

    private static NpgsqlParameter Optional(NpgsqlDbType type, object? value) =>
        new() { NpgsqlDbType = type, Value = value ?? DBNull.Value };
}
