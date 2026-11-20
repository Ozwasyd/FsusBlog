using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlogV2.Storage;

namespace FsusBlog.V2.Server.Administration;

internal sealed class AdminCommentHistoryStore(AdminSessionGate gate)
{
    private const int CommentTimelineEvents = 128;

    internal Task<byte[]> CommentTimeline(string? token, long id, IQueryCollection query, CancellationToken ct) =>
        gate.WithSession(token, async (db, tx, _) =>
        {
            var article = TimelineArticle(query);
            var hasOwnership = await CurrentSchema.HasCommentAuthorDeleteSchemaAsync(db, tx, ct);
            if (id <= 0 || (!article.HasValue && !hasOwnership))
                throw new BusinessException(Rejection.NotFound, "Comment moderation history is unavailable.");
            var target = article.HasValue ? "c.article_id=$2 and c.id=$1" : """
                (c.article_id,c.id)=(select o.article_id,o.comment_id from public.comment_account_owner o where o.comment_id=$1)
                """;
            var edits = await CurrentSchema.HasCommentAuthorEditSchemaAsync(db, tx, ct) ? """
                union all
                select e.comment_version,'edit',e.previous_status,e.moderation_status,'account','author_edited',e.happened_at,
                    'comment_author_edited',e.comment_version,null,null,null
                from target t join public.comment_author_edited e on (e.article_id,e.comment_id)=(t.article_id,t.id)
                """ : "";
            var deletions = hasOwnership ? """
                union all
                select d.comment_version,'delete',d.moderation_status,d.moderation_status,'account','author_deleted',d.happened_at,
                    'comment_author_deleted',d.comment_version,null,null,null
                from target t join public.comment_author_deleted d on (d.article_id,d.comment_id)=(t.article_id,t.id)
                """ : "";
            var appeals = await CurrentSchema.HasCommentAppealSchemaAsync(db, tx, ct) ? """
                union all
                select a.id,case e.kind when 1 then 'appeal' else 'appeal_decision' end,
                    e.previous_status,e.next_status,case e.kind when 1 then 'account' else 'admin' end,
                    case e.kind when 1 then a.reason else d.reason end,e.occurred_at,'comment_appeal_event',
                    a.comment_version+(case when e.kind=2 and e.previous_status<>e.next_status then 1 else 0 end),
                    case when e.kind=2 then d.principal_id end,null,a.id
                from target t join public.comment_appeal a on (a.article_id,a.comment_id)=(t.article_id,t.id)
                join public.comment_appeal_event e on e.appeal_id=a.id
                left join public.comment_appeal_decision d on d.appeal_id=a.id
                """ : "";
            await using var select = Store.Sql(db, tx, $$"""
                with target as (
                    select c.article_id,c.id,c.moderation_status,c.moderation_version,c.deleted,c.created_at
                    from public.comment c where {{target}}
                ), events(event_id,event_type,previous,next,actor,reason,happened_at,source,version,principal,role,appeal) as (
                    select t.id,'create',null::smallint,0::smallint,'system',null::text,t.created_at,'comment_submit_command',
                        1::bigint,null::uuid,null::text,null::bigint
                    from target t join public.comment_submit_command s on (s.article_id,s.comment_id)=(t.article_id,t.id)
                    union all
                    select m.id,case m.next_status when 1 then 'approve' else 'reject' end,m.previous_status,m.next_status,
                        'admin',m.reason,m.happened_at,'admin_comment_moderation',m.comment_version+1,m.principal_id,null,null
                    from target t join public.admin_comment_moderation m on (m.article_id,m.comment_id)=(t.article_id,t.id)
                    union all
                    select m.id,case m.next_status when 1 then 'approve' when 2 then 'reject' else 'hide' end,
                        m.previous_status,m.next_status,'database',m.reason,m.occurred_at,'comment_moderation_log',null,null,m.moderator_db_role,null
                    from target t join public.comment_moderation_log m on (m.article_id,m.comment_id)=(t.article_id,t.id)
                    {{edits}} {{deletions}} {{appeals}}
                )
                select t.article_id,t.moderation_status,t.moderation_version,t.deleted,
                    e.event_id,e.previous,e.next,e.event_type,e.actor,e.reason,e.happened_at,e.source,e.version,e.principal,e.role,e.appeal
                from target t left join events e on true
                order by e.happened_at,e.version nulls last,
                    case e.event_type when 'appeal' then 1 when 'appeal_decision' then 2 else 0 end,
                    e.source,e.event_id limit {{CommentTimelineEvents + 1}}
                """, article is int coordinates ? [id, coordinates] : [id]);
            await using var rows = await select.ExecuteReaderAsync(ct);
            if (!await rows.ReadAsync(ct))
                throw new BusinessException(Rejection.NotFound, "Comment moderation history is unavailable.");
            var targetArticle = rows.GetInt32(0);
            var current = rows.GetInt16(1);
            var currentVersion = rows.GetInt64(2);
            var deleted = rows.GetBoolean(3);
            var events = new List<AdminCommentTimelineEvent>();
            var projected = current;
            var version = 0L;
            var consistent = !rows.IsDBNull(4);
            var projectedDelete = false;
            do
            {
                if (rows.IsDBNull(4)) break;
                if (events.Count == CommentTimelineEvents) throw new PublicUnavailableException();
                var operation = rows.GetString(7);
                var previous = rows.IsDBNull(5) ? (short?)null : rows.GetInt16(5);
                var next = rows.GetInt16(6);
                var eventVersion = rows.IsDBNull(12) ? (long?)null : rows.GetInt64(12);
                if (operation == "create")
                {
                    consistent &= events.Count == 0 && previous is null && next == 0;
                    version = 1;
                }
                else
                {
                    consistent &= !projectedDelete && previous == projected && previous.HasValue && version > 0;
                    if (previous != next || operation is "edit" or "delete") ++version;
                }
                consistent &= eventVersion == version && (!rows.IsDBNull(13) || rows.GetString(8) != "admin");
                projected = next;
                projectedDelete |= operation == "delete";
                events.Add(new(rows.GetInt64(4), id, operation, previous, next, rows.GetString(8),
                    rows.IsDBNull(9) ? null : rows.GetString(9), rows.GetDateTime(10), rows.GetString(11), eventVersion,
                    rows.IsDBNull(13) ? null : rows.GetGuid(13), rows.IsDBNull(14) ? null : rows.GetString(14),
                    rows.IsDBNull(15) ? null : rows.GetInt64(15)));
            } while (await rows.ReadAsync(ct));
            return Wire.EncodeAdminCommentTimeline(new(id, targetArticle, projected, current,
                consistent && projected == current && version == currentVersion && projectedDelete == deleted, deleted, events));
        }, ct);

    internal Task<(byte[] Frame, long? Next, int Article)> CommentRevisions<TPosition>(string? token, long id, TPosition state,
        Func<TPosition, (long Before, int Article)> readPosition,
        CancellationToken ct) =>
        gate.WithSession<(byte[], long?, int)>(token, async (db, tx, _) =>
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

    private static int? TimelineArticle(IQueryCollection query)
    {
        if (query.Count == 0) return null;
        if (query.Count == 1 && query["articleId"] is { Count: 1 } values &&
            int.TryParse(values[0], NumberStyles.None, CultureInfo.InvariantCulture, out var value) && value > 0)
            return value;
        throw new BusinessException(Rejection.Invalid, "Invalid comment moderation history coordinates.");
    }
}
