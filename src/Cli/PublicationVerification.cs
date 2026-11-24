internal static partial class Cli
{
    private static async Task VerifyPublicationsAsync(NpgsqlConnection connection, CancellationToken token)
    {
        await using var transaction = await BeginReadOnlyAsync(connection, token);
        await VerifyActivePublicationsAsync(connection, transaction, token);
        if (await ScalarAsync(connection, transaction, """
            select count(*) from public.article_publication p where not exists (
                select from public.article_publication_rights s
                where s.article_id=p.article_id and s.publication_id=p.publication_id and s.revision=p.revision
            )
            """, token) is long missingRights && missingRights != 0)
            Console.WriteLine($"Publication rights: {missingRights} active coordinates have no exact rights snapshot and are excluded from public reads.");
        await VerifyPublicationHistoryAsync(connection, transaction, token);
        if (await ScalarAsync(connection, transaction, """
            select p.article_id from public.article_schedule p
            join public.article a on a.id=p.article_id
            join public.article_schedule_receipt r on r.actor_id=p.actor_id and r.command_id=p.command_id
            join public.article_command c on c.actor_id=p.actor_id and c.command_id=p.command_id
            where a.owner_id<>p.actor_id or a.deleted or p.revision<>a.revision
                or p.revision<>c.revision or p.article_id<>c.article_id or p.due_at is distinct from r.due_at
                or coalesce(a.published_revision,0)<>r.published_revision
            limit 1
            """, token) is int scheduleId)
            throw new InvalidOperationException($"Article {scheduleId} has inconsistent pending publication coordinates.");
        await VerifyPublicationMediaAsync(connection, transaction, token);
        if (await ScalarAsync(connection, transaction, """
            select count(*) from public.article a where a.publication_count>0 and not exists (
                select from public.article_publication_history h where h.article_id=a.id
            )
            """, token) is long count && count != 0)
            Console.WriteLine($"Publication history has {count} articles missing retained history entries.");
        await transaction.CommitAsync(token);
    }

    private static async Task VerifyActivePublicationsAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        CancellationToken token)
    {
        if (await ScalarAsync(connection, transaction, """
            SELECT a.id FROM public.article a LEFT JOIN public.article_publication p ON a.id = p.article_id
            WHERE a.published_revision IS DISTINCT FROM p.revision
               OR (p.publication_id IS NOT NULL AND p.publication_no <> a.publication_count)
               OR (a.deleted AND p.article_id IS NOT NULL)
            LIMIT 1
            """, token) is int id)
            throw new InvalidOperationException($"Article {id} has inconsistent publication coordinates.");
    }

    private static async Task VerifyPublicationMediaAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        if (!await CurrentSchema.HasPublicationMediaAsync(db, tx, ct)) return;
        if (await ScalarAsync(db, tx, """
            SELECT m.article_id FROM public.article_publication_media m
            JOIN public.article_publication_history h USING (article_id, publication_id, revision)
            JOIN public.article a ON a.id=m.article_id
            JOIN public.private_media p ON p.id=m.asset_id
            WHERE h.actor_id IS DISTINCT FROM a.owner_id OR h.kind NOT IN ('publish','replace')
               OR EXISTS (SELECT FROM public.article_schedule_receipt s WHERE s.actor_id=h.actor_id AND s.command_id=h.command_id)
               OR p.owner_id IS DISTINCT FROM a.owner_id OR p.phase<>1
               OR (p.content_hash,p.format,p.length,p.width,p.height) IS DISTINCT FROM (m.content_hash,m.format,m.length,m.width,m.height)
            UNION ALL
            SELECT article_id FROM public.article_publication_media GROUP BY article_id,publication_id
            HAVING max(ordinal)<>count(*) OR sum(length)>$1
            UNION ALL
            SELECT min(article_id) FROM public.article_publication_media GROUP BY content_hash
            HAVING min(format)<>max(format) OR min(length)<>max(length) OR min(width)<>max(width) OR min(height)<>max(height)
            LIMIT 1
            """, ct, CurrentSchema.PublicationMediaMaximumBytes) is int article)
            throw new InvalidOperationException($"Article {article} has inconsistent publication media metadata.");
    }

    private static async Task VerifyPublicationHistoryAsync(NpgsqlConnection connection, NpgsqlTransaction tx, CancellationToken ct)
    {
        bool hasAdminRollback = await CurrentSchema.HasAdminArticleRollbackSchemaAsync(connection, tx, ct);
        bool hasAdminDraftRollback = hasAdminRollback &&
            await CurrentSchema.HasAdminArticleDraftRollbackSchemaAsync(connection, tx, ct);
        bool hasArchive = hasAdminDraftRollback && await CurrentSchema.HasAdminArticleArchiveSchemaAsync(connection, tx, ct);
        bool hasTrashPublication = hasAdminRollback && await CurrentSchema.HasAdminArticleTrashPublicationSchemaAsync(connection, tx, ct);
        bool hasPrivateTrashRestore = await CurrentSchema.HasAdminArticleTrashRestoreAsync(connection, tx, ct);
        bool hasSummary = await CurrentSchema.HasArticleSummaryAsync(connection, tx, ct);
        var adminDestination = hasAdminDraftRollback ? "b.destination" : "2";
        var adminFromArchive = hasArchive ? "b.from_archive" : "false";
        var adminFromTrash = hasTrashPublication ? "b.from_trash" : "false";
        var copiedRevision = hasArchive ? "(case when b.from_archive then b.previous_revision else b.source_revision end)" : "b.source_revision";
        var copiedRelease = hasArchive ? "(case when b.from_archive then b.previous_publication_id else b.source_publication_id end)" :
            "b.source_publication_id";
        var adminFields = hasAdminRollback ? "" : ", null::uuid admin_actor_id, null::uuid admin_command_id";
        var archiveJoin = hasArchive ? """
            left join public.article_publication_history prior_archive on prior_archive.article_id=h.article_id
                and prior_archive.event_no=h.previous_event and prior_archive.kind='retract'
                and prior_archive.reason='administrator-rollback-archived'
            left join public.admin_article_rollback archived on archived.principal_id=prior_archive.admin_actor_id
                and archived.command_id=prior_archive.admin_command_id and archived.destination=3 and not archived.from_archive
            """ : "";
        var adminJoin = hasAdminRollback ? $"""
            left join public.admin_article_rollback b on b.principal_id=h.admin_actor_id and b.command_id=h.admin_command_id
            left join public.article_publication_rights source_rights on source_rights.article_id=h.article_id
                and source_rights.revision={copiedRevision} and source_rights.publication_id={copiedRelease}
            left join public.article_publication_rights next_rights on next_rights.article_id=h.article_id
                and next_rights.revision=h.revision and next_rights.publication_id=b.publication_id
            left join public.article_revision_rights source_policy on source_policy.article_id=source_rights.article_id
                and source_policy.revision=source_rights.revision
            left join public.article_revision_rights next_policy on next_policy.article_id=next_rights.article_id
                and next_policy.revision=next_rights.revision
            left join public.article_revision source_content on source_content.article_id=b.article_id and source_content.revision={copiedRevision}
            left join public.article_revision next_content on next_content.article_id=b.article_id and next_content.revision=b.revision
            left join public.article_publication_history source_release on source_release.article_id=h.article_id
                and source_release.publication_id=b.source_publication_id and source_release.revision=b.source_revision
            left join public.article_publication_responsibility source_evidence on source_evidence.article_id=h.article_id
                and source_evidence.revision={copiedRevision} and source_evidence.publication_id={copiedRelease}
            left join public.article_publication_responsibility next_evidence on next_evidence.article_id=h.article_id
                and next_evidence.revision=h.revision and next_evidence.publication_id=b.publication_id
            left join public.article_revision_responsibility derived on derived.id=next_evidence.snapshot_id
            left join public.article_revision_responsibility original on original.id=source_evidence.snapshot_id
            {archiveJoin}
            """ : "";
        var restoreVerification = hasArchive ? """
                    or (b.from_archive and (
                        h.previous_active is not null or b.destination<>2
                        or archived.article_id is distinct from h.article_id
                        or archived.revision is distinct from b.previous_revision
                        or archived.publication_id is distinct from b.previous_publication_id
                        or archived.source_revision is distinct from b.source_revision
                        or archived.source_publication_id is distinct from b.source_publication_id
                        or coalesce(o.publishes,0)<>1
                        or coalesce(o.retractions,0)>0 or coalesce(o.deletions,0)>0))
            """ : "";
        var publishedSummary = hasSummary ? "or source_content.author_summary is distinct from next_content.author_summary" : "";
        var restoredMedia = hasTrashPublication && await CurrentSchema.HasPublicationMediaAsync(connection, tx, ct) ? """
                        or array(select to_jsonb(m)-'publication_id'-'revision' from public.article_publication_media m
                            where m.article_id=h.article_id and m.publication_id=b.source_publication_id and m.revision=b.source_revision order by ordinal)
                           is distinct from array(select to_jsonb(m)-'publication_id'-'revision' from public.article_publication_media m
                            where m.article_id=h.article_id and m.publication_id=b.publication_id and m.revision=b.revision order by ordinal)
            """ : "";
        var restoredCover = hasTrashPublication && await CurrentSchema.HasPublicationCoverAsync(connection, tx, ct) ? """
                        or (select c.asset_id from public.article_publication_cover c
                            where c.article_id=h.article_id and c.publication_id=b.source_publication_id)
                           is distinct from (select c.asset_id from public.article_publication_cover c
                            where c.article_id=h.article_id and c.publication_id=b.publication_id)
            """ : "";
        var trashPublicationVerification = hasTrashPublication ? $"""
                    or (b.from_trash and (
                        {adminFromArchive} or {adminDestination}<>2 or h.previous_active is not null
                        or h.previous_kind is distinct from 'delete' or h.previous_reason is distinct from 'author-deleted'
                        or b.source_publication_id is distinct from h.previous_supersedes
                        or b.previous_publication_id is distinct from b.source_publication_id
                        or source_release.event_no is distinct from h.previous_event-1
                        or source_release.publication_no is distinct from h.previous_count
                        {restoredMedia}
                        {restoredCover}
                        or source_release.kind not in ('retained-active','publish','replace')
                        {publishedSummary}
                        or coalesce(o.publishes,0)<>1 or coalesce(o.retractions,0)<>0 or coalesce(o.deletions,0)<>0))
            """ : "";
        const string copiedResponsibility = """
            source_evidence.snapshot_id is null or derived.source_snapshot_id is distinct from source_evidence.snapshot_id
                or (derived.responsible_party,derived.basis,derived.reference,derived.recorded_by) is distinct from
                (original.responsible_party,original.basis,original.reference,original.recorded_by)
            """;
        var derivedResponsibility = hasTrashPublication ? $"""
                    case when b.from_trash and source_evidence.snapshot_id is null then
                        derived.id is null or derived.source_snapshot_id is not null or
                        (derived.responsible_party,derived.basis,derived.reference,derived.recorded_by) is distinct from
                        ('admin:'||b.principal_id::text,b.reason,'publication:'||b.source_publication_id::text,'admin:'||b.principal_id::text)
                    else {copiedResponsibility} end
            """ : copiedResponsibility;
        var privateAdminRestore = hasPrivateTrashRestore ? """
                        or exists (select from public.admin_article_trash_restore r
                            where r.article_id=h.article_id and r.previous_revision=h.revision and r.revision=restored.revision)
            """ : "";
        var privateSummary = hasSummary ? "and current_revision.author_summary is not distinct from deleted_revision.author_summary" : "";
        var privateRecovery = $"""
            exists (
                select from public.blog_outbox restored
                join public.article_revision current_revision
                    on (current_revision.article_id,current_revision.revision)=(restored.article_id,restored.revision)
                join public.article_revision deleted_revision
                    on (deleted_revision.article_id,deleted_revision.revision)=(h.article_id,h.revision)
                where restored.article_id=h.article_id and restored.revision=h.revision+1 and restored.kind='restore'
                    and (current_revision.title,current_revision.body) is not distinct from (deleted_revision.title,deleted_revision.body)
                    {privateSummary}
                    and (exists (select from public.article_command recovered
                        where recovered.actor_id=a.owner_id and recovered.article_id=h.article_id
                            and recovered.revision=restored.revision and not recovered.published
                            and recovered.fingerprint=sha256(convert_to('4','UTF8')||decode('00','hex')||
                                convert_to(h.article_id::text,'UTF8')||decode('00','hex')||
                                convert_to(h.revision::text,'UTF8')||decode('0000','hex')))
                        {privateAdminRestore})
            )
            """;
        var nextPublicRestore = hasTrashPublication ? """
            coalesce(h.next_revision=h.revision+1 and h.next_kind='publish'
                and h.next_reason='administrator-trash-republished', false)
            """ : "false";
        const string archivedSchedule = """
                    or exists(select from public.article_schedule pending where pending.article_id=h.article_id)
            """;
        var archiveVerification = hasArchive ? $"""
               or (h.previous_reason='administrator-rollback-archived' and
                    (h.admin_actor_id is null or h.reason<>'administrator-archive-republished'))
               or (h.kind='retract' and h.reason='administrator-rollback-archived' and h.next_event is null and (
                    a.revision<>h.revision {archivedSchedule}
               ))
            """ : "";
        var adminVerification = hasAdminRollback ? $"""
                 when h.admin_actor_id is not null then
                    h.actor_id is not null or h.command_id is not null or h.happened_at is null
                    or h.publication_no<>h.previous_count+1
                    or b.article_id is distinct from h.article_id or b.revision is distinct from h.revision
                    or b.previous_revision is distinct from h.previous_revision
                    or (not {adminFromArchive} and not {adminFromTrash} and
                        (h.previous_active is null or b.previous_publication_id is distinct from h.previous_active))
                    {restoreVerification}
                    {trashPublicationVerification}
                    or b.publication_no is distinct from h.publication_no
                    or b.published_at is distinct from h.happened_at or b.source_publication_id is null
                    or source_release.event_no is null or source_release.event_no>=h.event_no
                    or source_rights.id is null or next_rights.id is distinct from b.rights_snapshot_id
                    or (source_content.title,source_content.body) is distinct from (next_content.title,next_content.body)
                    or (to_jsonb(source_policy)-'revision') is distinct from (to_jsonb(next_policy)-'revision')
                    or (select category_id from public.article_revision_category where article_id=b.article_id and revision={copiedRevision})
                        is distinct from (select category_id from public.article_revision_category where article_id=b.article_id and revision=b.revision)
                    or array(select tag_id from public.article_revision_tag where article_id=b.article_id and revision={copiedRevision} order by tag_id)
                        is distinct from array(select tag_id from public.article_revision_tag where article_id=b.article_id and revision=b.revision order by tag_id)
                    or next_evidence.snapshot_id is distinct from b.responsibility_snapshot_id
                    or ({derivedResponsibility})
                    or case
                        when {adminDestination} in (0,3) then h.kind<>'retract'
                            or h.reason<>case when {adminDestination}=0 then 'administrator-rollback-draft' else 'administrator-rollback-archived' end
                            or h.publication_id is not null
                            or b.publication_id is null
                            or exists (select from public.article_publication_history visible where visible.publication_id=b.publication_id)
                            or exists (select from public.article_publication visible where visible.publication_id=b.publication_id)
                            or coalesce(o.retractions,0)<>1
                            or coalesce(o.publishes,0)>0 or coalesce(o.deletions,0)>0
                        when {adminDestination}=2 then
                            h.kind<>case when {adminFromArchive} or {adminFromTrash} then 'publish' else 'replace' end
                            or h.reason<>case when {adminFromTrash} then 'administrator-trash-republished'
                                when {adminFromArchive} then 'administrator-archive-republished' else 'administrator-rollback-replaced' end
                            or h.publication_id is null
                            or b.publication_id is distinct from h.publication_id
                            or coalesce(o.publishes,0)=0
                        else true
                    end
            """ : "";
        var adminOrphans = hasAdminRollback ? """
            union all
            select b.article_id from public.admin_article_rollback b where not exists (
                select from public.article_publication_history h where h.admin_actor_id=b.principal_id and h.admin_command_id=b.command_id
            )
            """ : "";
        // A healthy history must be scanned in full. Plan for that case and report a stable offending article.
        await using var command = new NpgsqlCommand($"""
            select min(article_id) from (
            with lifecycle_outbox as materialized (
                select article_id,revision,
                       count(*) filter (where kind='publish') as publishes,
                       count(*) filter (where kind='retract') as retractions,
                       count(*) filter (where kind='delete') as deletions
                from public.blog_outbox
                where kind in ('publish','retract','delete')
                group by article_id,revision
            ), links as (
                select h.*{adminFields},
                       coalesce(lag(event_no) over w,0) as previous_event,
                       coalesce(lag(publication_no) over w,0) as previous_count,
                       lag(publication_id) over w as previous_active,
                       lag(revision) over w as previous_revision,
                       lag(supersedes_id) over w as previous_supersedes,
                       lag(kind) over w as previous_kind,
                       lag(reason) over w as previous_reason,
                       lead(revision) over w as next_revision,
                       lead(kind) over w as next_kind,
                       lead(reason) over w as next_reason,
                       lead(event_no) over w as next_event
                from public.article_publication_history h
                window w as (partition by article_id order by event_no)
            )
            select h.article_id from links h
            join public.article a on a.id=h.article_id
            left join public.article_publication p on p.article_id=h.article_id
            left join public.article_command c on c.actor_id=h.actor_id and c.command_id=h.command_id
            left join public.article_schedule_receipt s on s.actor_id=h.actor_id and s.command_id=h.command_id
            left join lifecycle_outbox o on (o.article_id,o.revision)=(h.article_id,h.revision)
            {adminJoin}
            where h.event_no<>h.previous_event+1 or h.revision<=h.previous_revision
               or h.revision>a.revision
                or h.supersedes_id is distinct from h.previous_active
               {archiveVerification}
               or (h.next_event is null and (
                    h.publication_no<>a.publication_count or h.publication_id is distinct from p.publication_id
                    or (h.kind not in ('retained-hidden','delete') and a.deleted)
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
                    or (h.kind='delete' and (h.next_event is not null or not a.deleted)
                        and not ({nextPublicRestore} or ((h.next_revision is null or h.next_revision>h.revision+1) and {privateRecovery})))
                    or (h.kind='publish' and h.previous_active is not null)
                    or (h.kind='replace' and h.previous_active is null)
                    or (h.kind in ('publish','replace') and
                         (h.publication_id is null or (s.command_id is null and not c.published) or h.publication_no<>h.previous_count+1))
                    or (h.kind in ('retract','delete') and
                         (h.publication_id is not null or c.published or h.publication_no<>h.previous_count))
                    or coalesce(case
                        when h.kind in ('publish','replace') then o.publishes
                        when h.kind='retract' then o.retractions
                        when h.kind='delete' then o.deletions end,0)=0
                 end
            union all
            select o.article_id from lifecycle_outbox o
            join public.article_publication_history first on first.article_id=o.article_id and first.event_no=1
            cross join lateral (values ('publish',o.publishes),('retract',o.retractions),('delete',o.deletions)) e(kind,event_count)
            where e.event_count>0
              and (o.revision>first.revision or (
                   o.revision=first.revision and first.kind not in ('retained-active','retained-hidden')))
              and not exists (select from public.article_publication_history h
                   where h.article_id=o.article_id and h.revision=o.revision
                     and e.kind=case h.kind when 'replace' then 'publish' else h.kind end)
            {adminOrphans}
            ) invalid
            """, connection, tx);
        if (await command.ExecuteScalarAsync(ct) is int id)
            throw new InvalidOperationException($"Article {id} has inconsistent publication history.");
    }
}
