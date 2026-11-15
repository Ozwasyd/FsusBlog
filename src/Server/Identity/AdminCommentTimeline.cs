using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlogV2.Storage;

namespace FsusBlog.V2.Server.Administration;

internal sealed partial class AdminPasskeyStore
{
    private const int CommentTimelineEvents = 128;

    internal Task<byte[]> CommentTimeline(string? token, long id, IQueryCollection query, CancellationToken ct) =>
        WithSession(token, CurrentSchema.CommentModeratePermission, async (db, tx, _) =>
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
                order by e.happened_at,e.version nulls last,e.event_type,e.source,e.event_id limit {{CommentTimelineEvents + 1}}
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
                    if (previous != next || operation == "delete") ++version;
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

    private static int? TimelineArticle(IQueryCollection query)
    {
        if (query.Count == 0) return null;
        if (query.Count == 1 && query["articleId"] is { Count: 1 } values &&
            int.TryParse(values[0], NumberStyles.None, CultureInfo.InvariantCulture, out var value) && value > 0)
            return value;
        throw new BusinessException(Rejection.Invalid, "Invalid comment moderation history coordinates.");
    }
}
