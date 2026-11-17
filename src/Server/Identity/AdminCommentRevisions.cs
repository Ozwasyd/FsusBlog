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
            var result = await store.CommentRevisions(context.Request.Cookies[session], id, context.Request.Query, Position, ct);
            if (result.Next is long version)
            {
                var scope = result.Article == 0 ? "" : FormattableString.Invariant($"&articleId={result.Article}");
                context.Response.Headers.Link = FormattableString.Invariant($"</api/binary/author/comments/{id}/revisions?before={version}{scope}>; rel=\"next\"");
            }
            return Results.Bytes(result.Frame, Aeds.ContentType);
        }).RequireRateLimiting("command");
        app.MapGet(WireRoutes.AdminCommentTimeline, async (long id, HttpContext context, CancellationToken ct) =>
        {
            context.Response.Headers.CacheControl = "no-store";
            return Results.Bytes(await store.CommentTimeline(context.Request.Cookies[session], id, context.Request.Query, ct),
                Aeds.ContentType);
        }).RequireRateLimiting("command");
    }

    internal static (long Before, int Article) Position(IQueryCollection query)
    {
        var hasBefore = query.TryGetValue("before", out var before);
        var hasArticle = query.TryGetValue("articleId", out var article);
        long version = long.MaxValue;
        int scope = 0;
        if (query.Count != (hasBefore ? 1 : 0) + (hasArticle ? 1 : 0) ||
            hasBefore && (before.Count != 1 || !long.TryParse(before[0], NumberStyles.None, CultureInfo.InvariantCulture, out version) || version <= 1) ||
            hasArticle && (article.Count != 1 || !int.TryParse(article[0], NumberStyles.None, CultureInfo.InvariantCulture, out scope) || scope <= 0))
            throw new BusinessException(Rejection.Invalid, "Invalid comment revision position.");
        return (version, scope);
    }
}

internal sealed partial class AdminPasskeyStore
{
    internal Task<(byte[] Frame, long? Next, int Article)> CommentRevisions<TPosition>(string? token, long id, TPosition state,
        Func<TPosition, (long Before, int Article)> readPosition,
        CancellationToken ct) =>
        WithSession<(byte[], long?, int)>(token, CurrentSchema.CommentModeratePermission, async (db, tx, _) =>
        {
            if (id <= 0 || !await CurrentSchema.HasCommentAuthorDeleteSchemaAsync(db, tx, ct) ||
                !await CurrentSchema.HasCommentAuthorEditSchemaAsync(db, tx, ct))
                throw new BusinessException(Rejection.NotFound, "Comment revisions are unavailable.");
            // Decode request position only after session authority and feature admission.
            var (before, article) = readPosition(state);
            await using var read = Store.Sql(db, tx, """
                with target as (
                    select c.article_id,c.id,c.body,c.created_at,c.edited_at,c.deleted,c.moderation_version,c.moderation_status,o.user_id
                    from public.comment_account_owner o
                    join public.comment c on (c.article_id,c.id)=(o.article_id,o.comment_id)
                    where o.comment_id=$1 and c.author_mode=3 and ($3=0 or c.article_id=$3)
                ), edits as (
                    select e.*,row_number() over (order by e.comment_version) as ordinal,
                        lag(e.body_digest) over (order by e.comment_version) as preceding_digest
                    from target t join public.comment_author_edited e
                        on (e.article_id,e.comment_id,e.user_id)=(t.article_id,t.id,t.user_id)
                ), latest as (
                    select body,happened_at,ordinal from edits order by ordinal desc limit 1
                ), deletion as (
                    select t.body,d.body_digest,d.happened_at,
                        t.deleted and d.comment_version=t.moderation_version and d.moderation_status=t.moderation_status
                        and d.happened_at>=coalesce(t.edited_at,t.created_at)
                        and d.body_digest=pg_catalog.sha256(convert_to(t.body,'UTF8'))
                        and exists(select from public.comment_author_delete_outbox o
                            where (o.article_id,o.comment_id)=(d.article_id,d.comment_id) and o.event_type='CommentDeleted') as coherent
                    from target t join public.comment_author_deleted d
                        on (d.article_id,d.comment_id,d.user_id)=(t.article_id,t.id,t.user_id)
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
                    select coalesce(l.ordinal,0)+2,d.body,d.body_digest,'deleted',d.happened_at,d.coherent
                    from deletion d left join latest l on true
                )
                select r.version,r.content,encode(computed,'hex'),r.operation,r.happened_at,
                    r.coherent and (r.digest is null or r.digest=computed)
                    and t.edited_at is not distinct from l.happened_at and t.body=coalesce(l.body,t.body)
                    and coalesce((select coherent from deletion),not t.deleted)
                from revisions r cross join target t left join latest l on true
                cross join lateral (select pg_catalog.sha256(convert_to(r.content,'UTF8')) as computed) digest_check
                where r.version<$2 order by r.version desc limit 65
                """, id, before, article);
            await using var rows = await read.ExecuteReaderAsync(ct);
            var revisions = new List<AdminCommentRevision>();
            while (await rows.ReadAsync(ct))
            {
                if (revisions.Count == 64) return (Wire.EncodeAdminCommentRevisions(revisions), revisions[^1].Version, article);
                if (!rows.GetBoolean(5)) throw new PublicUnavailableException();
                revisions.Add(new(rows.GetInt64(0), rows.GetString(1), rows.GetString(2), rows.GetString(3), rows.GetDateTime(4)));
            }
            if (revisions.Count == 0) throw new BusinessException(Rejection.NotFound, "Comment revisions are unavailable.");
            return (Wire.EncodeAdminCommentRevisions(revisions), null, article);
        }, ct);
}
