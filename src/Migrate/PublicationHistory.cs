using System.Data;
using FsusBlogV2.Storage;
using Npgsql;

internal static partial class Migration
{
    private static async Task InitializePublicationHistoryAsync(NpgsqlConnection connection, CancellationToken ct)
    {
        await using var tx = await connection.BeginTransactionAsync(IsolationLevel.ReadCommitted, ct);
        await PrepareSchemaAddition(connection, tx, ct);
        var hasRecoveryScope = await HasRelation(connection, tx, "public.authoring_recovery_site", ct);
        var hasRevisionHistory = await HasRelation(connection, tx, "public.article_rollback", ct);
        var hasAdminIdentity = await HasRelation(connection, tx, CurrentSchema.AdminIdentityMarker, ct);
        var hasArticleSchedule = await HasRelation(connection, tx, CurrentSchema.ArticleScheduleRelation, ct);
        var hasMediaUpload = await HasRelation(connection, tx, CurrentSchema.MediaUploadRelation, ct);
        var hasPublicationRights = await HasRelation(connection, tx, CurrentSchema.PublicationRightsRelation, ct);
        if (!await HasRelation(connection, tx, CurrentSchema.PublicationHistoryRelation, ct))
        {
            await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, hasRecoveryScope, hasRevisionHistory, hasAdminIdentity,
                requirePublicationHistory: false, requireArticleSchedule: hasArticleSchedule, requireMediaUpload: hasMediaUpload, requirePublicationRights: hasPublicationRights);
            await ApplySchemaAddition(connection, tx, "publication-history.sql", ct);
        }
        await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, hasRecoveryScope, hasRevisionHistory, hasAdminIdentity,
            requireArticleSchedule: hasArticleSchedule, requireMediaUpload: hasMediaUpload, requirePublicationRights: hasPublicationRights);
        if (hasRecoveryScope) await CurrentSchema.ReadRecoverySiteIdAsync(connection, tx, ct);
        if (hasAdminIdentity) await CurrentSchema.VerifyAdminIdentityMarkerAsync(connection, tx, ct);
        await VerifyActivePublicationsAsync(connection, tx, ct);
        await ExecuteAsync(connection, tx, """
            insert into public.article_publication_history
                (article_id,event_no,revision,publication_no,publication_id,kind,reason,happened_at)
            select a.id,1,coalesce(p.revision,a.revision),a.publication_count,p.publication_id,
                   case when p.publication_id is null then 'retained-hidden' else 'retained-active' end,
                   'pre-history',p.published_at
            from public.article a left join public.article_publication p on p.article_id=a.id
            where a.publication_count>0 and not exists (
                select from public.article_publication_history h where h.article_id=a.id
            )
            """, ct);
        await VerifyPublicationHistoryAsync(connection, tx, ct, hasArticleSchedule);
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified durable publication history and retained boundaries.");
    }

    private static async Task VerifyPublicationHistoryAsync(NpgsqlConnection connection, NpgsqlTransaction tx, CancellationToken ct,
        bool hasArticleSchedule = true)
    {
        var scheduleJoin = hasArticleSchedule ? "public.article_schedule_receipt" :
            "(select null::uuid actor_id,null::uuid command_id,null::timestamptz due_at where false)";
        bool hasAdminRollback = await CurrentSchema.HasAdminArticleRollbackSchemaAsync(connection, tx, ct);
        bool hasAdminDraftRollback = hasAdminRollback &&
            await CurrentSchema.HasAdminArticleDraftRollbackSchemaAsync(connection, tx, ct);
        var adminDestination = hasAdminDraftRollback ? "b.destination" : "2";
        var adminFields = hasAdminRollback ? "" : ", null::uuid admin_actor_id, null::uuid admin_command_id";
        var adminJoin = hasAdminRollback ? """
            left join public.admin_article_rollback b on b.principal_id=h.admin_actor_id and b.command_id=h.admin_command_id
            left join public.article_publication_rights source_rights on source_rights.article_id=h.article_id
                and source_rights.revision=b.source_revision and source_rights.publication_id=b.source_publication_id
            left join public.article_publication_rights next_rights on next_rights.article_id=h.article_id
                and next_rights.revision=h.revision and next_rights.publication_id=b.publication_id
            left join public.article_revision_rights source_policy on source_policy.article_id=source_rights.article_id
                and source_policy.revision=source_rights.revision
            left join public.article_revision_rights next_policy on next_policy.article_id=next_rights.article_id
                and next_policy.revision=next_rights.revision
            left join public.article_revision source_content on source_content.article_id=b.article_id and source_content.revision=b.source_revision
            left join public.article_revision next_content on next_content.article_id=b.article_id and next_content.revision=b.revision
            left join public.article_publication_history source_release on source_release.article_id=h.article_id
                and source_release.publication_id=b.source_publication_id and source_release.revision=b.source_revision
            left join public.article_publication_responsibility source_evidence on source_evidence.article_id=h.article_id
                and source_evidence.revision=b.source_revision and source_evidence.publication_id=b.source_publication_id
            left join public.article_publication_responsibility next_evidence on next_evidence.article_id=h.article_id
                and next_evidence.revision=h.revision and next_evidence.publication_id=b.publication_id
            left join public.article_revision_responsibility derived on derived.id=next_evidence.snapshot_id
            left join public.article_revision_responsibility original on original.id=source_evidence.snapshot_id
            """ : "";
        var adminVerification = hasAdminRollback ? $"""
                 when h.admin_actor_id is not null then
                    h.actor_id is not null or h.command_id is not null or h.happened_at is null or h.previous_active is null
                    or h.publication_no<>h.previous_count+1
                    or b.article_id is distinct from h.article_id or b.revision is distinct from h.revision
                    or b.previous_publication_id is distinct from h.previous_active
                    or b.publication_no is distinct from h.publication_no
                    or b.published_at is distinct from h.happened_at or b.source_publication_id is null
                    or source_release.event_no is null or source_release.event_no>=h.event_no
                    or source_rights.id is null or next_rights.id is distinct from b.rights_snapshot_id
                    or (source_content.title,source_content.body) is distinct from (next_content.title,next_content.body)
                    or (to_jsonb(source_policy)-'revision') is distinct from (to_jsonb(next_policy)-'revision')
                    or (select category_id from public.article_revision_category where article_id=b.article_id and revision=b.source_revision)
                        is distinct from (select category_id from public.article_revision_category where article_id=b.article_id and revision=b.revision)
                    or array(select tag_id from public.article_revision_tag where article_id=b.article_id and revision=b.source_revision order by tag_id)
                        is distinct from array(select tag_id from public.article_revision_tag where article_id=b.article_id and revision=b.revision order by tag_id)
                    or next_evidence.snapshot_id is distinct from b.responsibility_snapshot_id
                    or source_evidence.snapshot_id is null or derived.source_snapshot_id is distinct from source_evidence.snapshot_id
                    or (derived.responsible_party,derived.basis,derived.reference,derived.recorded_by) is distinct from
                        (original.responsible_party,original.basis,original.reference,original.recorded_by)
                    or case {adminDestination}
                        when 0 then h.kind<>'retract' or h.reason<>'administrator-rollback-draft' or h.publication_id is not null
                            or b.publication_id is null
                            or exists (select from public.article_publication_history visible where visible.publication_id=b.publication_id)
                            or exists (select from public.article_publication visible where visible.publication_id=b.publication_id)
                            or (select count(*) from public.blog_outbox e
                                where e.article_id=h.article_id and e.revision=h.revision and e.kind='retract')<>1
                            or exists (select from public.blog_outbox e
                                where e.article_id=h.article_id and e.revision=h.revision and e.kind in ('publish','delete'))
                        when 2 then h.kind<>'replace' or h.reason<>'administrator-rollback-replaced' or h.publication_id is null
                            or b.publication_id is distinct from h.publication_id
                            or not exists (select from public.blog_outbox e where e.article_id=h.article_id and e.revision=h.revision
                                and e.kind='publish')
                        else true
                    end
            """ : "";
        var adminOrphans = hasAdminRollback ? """
            union all
            select b.article_id from public.admin_article_rollback b where not exists (
                select from public.article_publication_history h where h.admin_actor_id=b.principal_id and h.admin_command_id=b.command_id
            )
            """ : "";
        await using var command = new NpgsqlCommand($"""
            with links as (
                select h.*{adminFields},
                       coalesce(lag(event_no) over w,0) as previous_event,
                       coalesce(lag(publication_no) over w,0) as previous_count,
                       lag(publication_id) over w as previous_active,
                       lag(revision) over w as previous_revision,
                       lead(event_no) over w as next_event
                from public.article_publication_history h
                window w as (partition by article_id order by event_no)
            )
            select h.article_id from links h
            join public.article a on a.id=h.article_id
            left join public.article_publication p on p.article_id=h.article_id
            left join public.article_command c on c.actor_id=h.actor_id and c.command_id=h.command_id
            left join {scheduleJoin} s on s.actor_id=h.actor_id and s.command_id=h.command_id
            {adminJoin}
            where h.event_no<>h.previous_event+1 or h.revision<=h.previous_revision
               or h.revision>a.revision
                or h.supersedes_id is distinct from h.previous_active
               or (h.next_event is null and (
                    h.publication_no<>a.publication_count or h.publication_id is distinct from p.publication_id
                    or (h.kind<>'retained-hidden' and a.deleted<>(h.kind='delete'))
                    or p.revision is distinct from a.published_revision
                    or (p.publication_id is not null and (a.deleted or h.revision<>p.revision
                         or p.publication_no<>h.publication_no or h.happened_at is distinct from p.published_at))
               ))
               or case
                 when h.kind='retained-active' then
                    h.event_no<>1 or h.actor_id is not null or h.publication_id is null
                    or h.admin_actor_id is not null or h.publication_no<=0 or h.happened_at is null or h.reason<>'pre-history'
                 when h.kind='retained-hidden' then
                    h.event_no<>1 or h.actor_id is not null or h.publication_id is not null
                    or h.admin_actor_id is not null or h.publication_no<=0 or h.happened_at is not null or h.reason<>'pre-history'
                 {adminVerification}
                 else
                    h.actor_id is distinct from a.owner_id or c.article_id is distinct from h.article_id
                    or c.revision is distinct from h.revision or h.happened_at is null
                    or (s.command_id is not null and (s.due_at is null or h.kind not in ('publish','replace')))
                    or h.reason<>case h.kind when 'publish' then case when s.command_id is null then 'author-published' else 'scheduled-published' end
                         when 'replace' then case when s.command_id is null then 'author-replaced' else 'scheduled-replaced' end
                         when 'retract' then 'author-withdrew' when 'delete' then 'author-deleted' end
                    or (h.kind='delete' and (h.next_event is not null or not a.deleted))
                    or (h.kind='publish' and h.previous_active is not null)
                    or (h.kind='replace' and h.previous_active is null)
                    or (h.kind in ('publish','replace') and
                         (h.publication_id is null or (s.command_id is null and not c.published) or h.publication_no<>h.previous_count+1))
                    or (h.kind in ('retract','delete') and
                         (h.publication_id is not null or c.published or h.publication_no<>h.previous_count))
                    or not exists (select from public.blog_outbox e where e.article_id=h.article_id and e.revision=h.revision
                         and e.kind=case h.kind when 'replace' then 'publish' else h.kind end)
                 end
            union all
            select e.article_id from public.blog_outbox e
            join public.article_publication_history first on first.article_id=e.article_id and first.event_no=1
            where e.kind in ('publish','retract','delete')
              and (e.revision>first.revision or (
                   e.revision=first.revision and first.kind not in ('retained-active','retained-hidden')))
              and not exists (select from public.article_publication_history h
                   where h.article_id=e.article_id and h.revision=e.revision
                     and e.kind=case h.kind when 'replace' then 'publish' else h.kind end)
            {adminOrphans}
            limit 1
            """, connection, tx);
        if (await command.ExecuteScalarAsync(ct) is int id)
            throw new InvalidOperationException($"Article {id} has inconsistent publication history.");
    }
}
