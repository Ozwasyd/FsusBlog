using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlogV2.Storage;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminCommentRevisions
{
    internal static void Map(WebApplication app, AdminPasskeyStore store, string session)
    {
        app.MapGet(WireRoutes.AdminCommentRevisions, async (long id, HttpContext context, CancellationToken ct) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            var result = await store.CommentRevisions(context.Request.Cookies[session], id, context.Request.Query, ct);
            if (result.Next is long version)
                context.Response.Headers.Link = FormattableString.Invariant($"</api/binary/author/comments/{id}/revisions?before={version}>; rel=\"next\"");
            return Results.Bytes(result.Frame, Aeds.ContentType);
        }).RequireRateLimiting("command");
        app.MapGet(WireRoutes.AdminCommentTimeline, async (long id, HttpContext context, CancellationToken ct) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            return Results.Bytes(await store.CommentTimeline(context.Request.Cookies[session], id, context.Request.Query, ct),
                Aeds.ContentType);
        }).RequireRateLimiting("command");
    }

    internal static long Before(IQueryCollection query)
    {
        if (query.Count == 0) return long.MaxValue;
        if (query.Count == 1 && query["before"] is { Count: 1 } before &&
            long.TryParse(before[0], NumberStyles.None, CultureInfo.InvariantCulture, out var version) && version > 1)
            return version;
        throw new BusinessException(Rejection.Invalid, "Invalid comment revision position.");
    }
}

internal sealed partial class AdminPasskeyStore
{
    internal Task<(byte[] Frame, long? Next)> CommentRevisions(string? token, long id, IQueryCollection query,
        CancellationToken ct) =>
        WithSession<(byte[], long?)>(token, CurrentSchema.CommentModeratePermission, async (db, tx, _) =>
        {
            if (id <= 0 || !await CurrentSchema.HasCommentAuthorDeleteSchemaAsync(db, tx, ct) ||
                !await CurrentSchema.HasCommentAuthorEditSchemaAsync(db, tx, ct))
                throw new BusinessException(Rejection.NotFound, "Comment revisions are unavailable.");
            var before = AdminCommentRevisions.Before(query);
            await using var read = Store.Sql(db, tx, """
                with target as (
                    select c.article_id,c.id,c.body,c.created_at,c.edited_at,c.deleted,o.user_id
                    from public.comment_account_owner o
                    join public.comment c on (c.article_id,c.id)=(o.article_id,o.comment_id)
                    where o.comment_id=$1 and c.author_mode=3
                ), edits as (
                    select e.*,row_number() over (order by e.comment_version) as ordinal,
                        lag(e.body_digest) over (order by e.comment_version) as preceding_digest
                    from target t join public.comment_author_edited e
                        on (e.article_id,e.comment_id,e.user_id)=(t.article_id,t.id,t.user_id)
                ), latest as (
                    select body,happened_at,ordinal from edits order by ordinal desc limit 1
                ), revisions as (
                    select 1::bigint as version,coalesce(e.previous_body,t.body) as content,
                        e.previous_body_digest as digest,'created' as operation,t.created_at as happened_at,true as coherent
                    from target t left join edits e on e.ordinal=1
                    union all
                    select ordinal+1,body,body_digest,'edited',happened_at,
                        previous_body_digest=coalesce(preceding_digest,previous_body_digest)
                        and previous_body_digest=pg_catalog.sha256(convert_to(previous_body,'UTF8'))
                    from edits
                    union all
                    select coalesce(l.ordinal,0)+2,t.body,d.body_digest,'deleted',d.happened_at,t.deleted
                    from target t left join latest l on true
                    join public.comment_author_deleted d on (d.article_id,d.comment_id,d.user_id)=(t.article_id,t.id,t.user_id)
                )
                select r.version,r.content,encode(computed,'hex'),r.operation,r.happened_at,
                    r.coherent and (r.digest is null or r.digest=computed)
                    and t.edited_at is not distinct from l.happened_at and t.body=coalesce(l.body,t.body)
                    and t.deleted=exists(select from revisions where operation='deleted')
                from revisions r cross join target t left join latest l on true
                cross join lateral (select pg_catalog.sha256(convert_to(r.content,'UTF8')) as computed) digest_check
                where r.version<$2 order by r.version desc limit 65
                """, id, before);
            await using var rows = await read.ExecuteReaderAsync(ct);
            var revisions = new List<AdminCommentRevision>();
            while (await rows.ReadAsync(ct))
            {
                if (revisions.Count == 64) return (Wire.EncodeAdminCommentRevisions(revisions), revisions[^1].Version);
                if (!rows.GetBoolean(5)) throw new PublicUnavailableException();
                revisions.Add(new(rows.GetInt64(0), rows.GetString(1), rows.GetString(2), rows.GetString(3), rows.GetDateTime(4)));
            }
            if (revisions.Count == 0) throw new BusinessException(Rejection.NotFound, "Comment revisions are unavailable.");
            return (Wire.EncodeAdminCommentRevisions(revisions), null);
        }, ct);
}
