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
        var hasAdminIdentity = await HasRelation(connection, tx, "public.admin_identity_schema", ct);
        if (!await HasRelation(connection, tx, CurrentSchema.PublicationHistoryRelation, ct))
        {
            await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, hasRecoveryScope, hasRevisionHistory, hasAdminIdentity,
                requirePublicationHistory: false);
            await ApplySchemaAddition(connection, tx, "publication-history.sql", ct);
        }
        await CurrentSchema.VerifyCatalogAsync(connection, tx, ct, hasRecoveryScope, hasRevisionHistory, hasAdminIdentity);
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
        await VerifyPublicationHistoryAsync(connection, tx, ct);
        await tx.CommitAsync(ct);
        Console.WriteLine("Verified durable publication history and retained boundaries.");
    }

    private static async Task VerifyPublicationHistoryAsync(NpgsqlConnection connection, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand("""
            with links as (
                select h.*,
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
                    or h.publication_no<=0 or h.happened_at is null or h.reason<>'pre-history'
                 when h.kind='retained-hidden' then
                    h.event_no<>1 or h.actor_id is not null or h.publication_id is not null
                    or h.publication_no<=0 or h.happened_at is not null or h.reason<>'pre-history'
                 else
                    h.actor_id is distinct from a.owner_id or c.article_id is distinct from h.article_id
                    or c.revision is distinct from h.revision or h.happened_at is null
                    or h.reason<>case h.kind when 'publish' then 'author-published' when 'replace' then 'author-replaced'
                         when 'retract' then 'author-withdrew' when 'delete' then 'author-deleted' end
                    or (h.kind='delete' and (h.next_event is not null or not a.deleted))
                    or (h.kind='publish' and h.previous_active is not null)
                    or (h.kind='replace' and h.previous_active is null)
                    or (h.kind in ('publish','replace') and
                         (h.publication_id is null or not c.published or h.publication_no<>h.previous_count+1))
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
            limit 1
            """, connection, tx);
        if (await command.ExecuteScalarAsync(ct) is int id)
            throw new InvalidOperationException($"Article {id} has inconsistent publication history.");
    }
}
