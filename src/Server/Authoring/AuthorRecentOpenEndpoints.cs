using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Sessions;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Authoring;

internal static class AuthorRecentOpenEndpoints
{
    private const int RetainedEntries = 1000;
    private const int RetainedReceipts = 1000;

    internal static void Map(WebApplication app, string cookie, Func<HttpContext, int, CancellationToken, Task<byte[]>> read,
        Func<HttpContext, string, int, string?> query)
    {
        app.MapGet(WireRoutes.AuthorRecentOpens, (HttpContext ctx, Store store, CancellationToken ct) =>
            Run(ctx, store, async (db, tx, site, owner, session) =>
            {
                var raw = query(ctx, "cursor", WireLimits.AuthorRecentOpenCursorChars);
                var cursor = raw is null ? null : AuthorRecentOpenCursor.Decode(site, owner, session, raw);
                if (raw is not null && !cursor.HasValue)
                    throw new BusinessException(Rejection.Invalid, "Invalid recent opens cursor.");
                return Wire.EncodeAuthorRecentOpenPage(await Read(db, tx, site, owner, session, cursor, ct));
            }, ct)).RequireRateLimiting("command");

        app.MapPost(WireRoutes.AuthorRecentOpens, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var input = Wire.DecodeAuthorRecentOpenCommand(await read(ctx, WireLimits.MaxAuthorRecentOpenCommandFrameBytes, ct));
            return await Run(ctx, store, async (db, tx, site, owner, _) =>
                Wire.EncodeAuthorRecentOpenReceipt(await Record(db, tx, site, owner, input, ct)), ct);
        }).RequireRateLimiting("command");

        Task<IResult> Run(HttpContext ctx, Store store, Func<NpgsqlConnection, NpgsqlTransaction, Guid, Guid, byte[], Task<byte[]>> process,
            CancellationToken ct)
        {
            var token = ctx.Request.Cookies[cookie];
            return SiteSessions.WithCurrentAuthor<IResult>(store, token, SiteSessions.Requested(ctx), async (db, tx, actor, session) =>
            {
                if (!await CurrentSchema.HasAuthorRecentOpensAsync(db, tx, ct))
                    throw new BusinessException(Rejection.NotFound, "Recent opens are unavailable.");
                var site = await CurrentSchema.ReadRecoverySiteIdAsync(db, tx, ct);
                return Results.Bytes(await process(db, tx, site, actor.Id, session), Aeds.ContentType);
            }, ct);
        }
    }

    private static async Task<AuthorRecentOpenPage> Read(NpgsqlConnection db, NpgsqlTransaction tx, Guid site, Guid owner,
        byte[] session, (long Revision, long Before)? cursor, CancellationToken ct)
    {
        // Read the collection witness and the authorized projection in one statement snapshot.
        await using var query = Store.Sql(db, tx, $"""
            select head.revision, p.article_id, p.article_revision, p.sequence, p.opened_at, p.title
            from (select coalesce((select revision from public.author_recent_open_collection
                where site_id=$1 and owner_id=$2),0) revision) head
            left join lateral (
                select r.article_id, r.article_revision, r.sequence, r.opened_at, a.title
                from public.author_recent_open r join public.article a on a.id=r.article_id
                where r.site_id=$1 and r.owner_id=$2 and a.owner_id=$2 and not a.deleted
                    and {ArchivedArticleAuthority.Available}
                    and ($3=0 or r.sequence<$3) and ($4=0 or head.revision=$4)
                order by r.sequence desc limit $5
            ) p on true
            order by p.sequence desc
            """, site, owner, cursor?.Before ?? 0L, cursor?.Revision ?? 0L, WireLimits.AuthorRecentOpenPageSize + 1);
        var entries = new List<AuthorRecentOpenRow>(WireLimits.AuthorRecentOpenPageSize);
        var revision = 0L;
        var more = false;
        await using var rows = await query.ExecuteReaderAsync(ct);
        while (await rows.ReadAsync(ct))
        {
            revision = rows.GetInt64(0);
            if (cursor.HasValue && revision != cursor.Value.Revision) throw Conflict();
            if (rows.IsDBNull(1)) break;
            if (entries.Count == WireLimits.AuthorRecentOpenPageSize)
            {
                more = true;
                break;
            }
            entries.Add(new(rows.GetInt32(1), rows.GetInt64(2), rows.GetInt64(3),
                rows.GetFieldValue<DateTimeOffset>(4).ToUnixTimeMilliseconds(), rows.GetString(5)));
        }
        return new(revision, more ? AuthorRecentOpenCursor.Encode(site, owner, session, revision, entries[^1].Sequence) : "", entries);
    }

    private static async Task<AuthorRecentOpenReceipt> Record(NpgsqlConnection db, NpgsqlTransaction tx, Guid site, Guid owner,
        AuthorRecentOpenCommand input, CancellationToken ct)
    {
        // Only this feature locks the collection head. The article read lock then serializes with Save and Trash.
        bool created;
        created = await SqlCommands.Execute(db, tx, ct, """
            insert into public.author_recent_open_collection(site_id,owner_id,revision) values($1,$2,1)
            on conflict (site_id,owner_id) do nothing
            """, site, owner) == 1;

        var revision = (long)(await SqlCommands.Scalar(db, tx, ct, """
            select revision from public.author_recent_open_collection where site_id=$1 and owner_id=$2 for update
            """, site, owner))!;

        var articleRevision = (await OwnedArticleRead.TryLock(db, tx, owner, input.ArticleId, ct))?.Revision
            ?? throw new BusinessException(Rejection.NotFound, "Article not found.");

        await using (var prior = Store.Sql(db, tx, """
            select article_id,article_revision,sequence,opened_at from public.author_recent_open_receipt
            where site_id=$1 and owner_id=$2 and request_id=$3
            """, site, owner, input.RequestId))
        await using (var row = await prior.ExecuteReaderAsync(ct))
        {
            if (await row.ReadAsync(ct))
            {
                if (row.GetInt32(0) != input.ArticleId || row.GetInt64(1) != input.ArticleRevision ||
                    row.GetInt64(2) != input.ExpectedRevision + 1) throw Conflict();
                return new(1, row.GetInt64(2), input.RequestId, input.ArticleId, input.ArticleRevision,
                    row.GetFieldValue<DateTimeOffset>(3).ToUnixTimeMilliseconds());
            }
        }

        if ((created ? 0 : revision) != input.ExpectedRevision || articleRevision != input.ArticleRevision) throw Conflict();
        var next = input.ExpectedRevision + 1;
        var timestamp = (DateTime)(await SqlCommands.Scalar(db, tx, ct, """
            with advanced as (
                update public.author_recent_open_collection set revision=$3 where site_id=$1 and owner_id=$2 returning revision
            ), receipt as (
                insert into public.author_recent_open_receipt(site_id,owner_id,request_id,article_id,article_revision,sequence,opened_at)
                select $1,$2,$4,$5,$6,revision,clock_timestamp() from advanced returning sequence,opened_at
            )
            insert into public.author_recent_open(site_id,owner_id,article_id,article_revision,sequence,opened_at)
            select $1,$2,$5,$6,sequence,opened_at from receipt
            on conflict (site_id,owner_id,article_id) do update set
                article_revision=excluded.article_revision,sequence=excluded.sequence,opened_at=excluded.opened_at
            returning opened_at
            """, site, owner, next, input.RequestId, input.ArticleId, input.ArticleRevision))!;
        if (next > RetainedEntries)
        {
            await SqlCommands.Execute(db, tx, ct, """
                delete from public.author_recent_open where site_id=$1 and owner_id=$2 and sequence < (
                    select sequence from public.author_recent_open where site_id=$1 and owner_id=$2
                    order by sequence desc offset $3 limit 1
                )
                """, site, owner, RetainedEntries - 1);
        }
        if (next > RetainedReceipts)
        {
            await SqlCommands.Execute(db, tx, ct, """
                delete from public.author_recent_open_receipt where site_id=$1 and owner_id=$2 and sequence <= $3
                """, site, owner, next - RetainedReceipts);
        }
        return new(1, next, input.RequestId, input.ArticleId, input.ArticleRevision, new DateTimeOffset(timestamp).ToUnixTimeMilliseconds());
    }

    private static BusinessException Conflict() => new(Rejection.Conflict, "The recent opens history or article revision changed.");
}
