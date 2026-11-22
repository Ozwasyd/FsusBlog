using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using Npgsql;
using NpgsqlTypes;

namespace FsusBlog.V2.Server.Authoring;

internal static class PublicationHistoryStore
{
    private sealed record ActivePublication(long Id, long Revision, int Number, DateTime PublishedAt);

    // Store.Execute owns the article row lock and has already written the new private revision and command.
    internal static Task Apply(NpgsqlConnection db, NpgsqlTransaction tx, Guid actor, Guid command,
        ArticleAction action, ArticleState prior, ArticleState next, CancellationToken ct,
        IReadOnlyList<Content.PublishedMediaReference>? selected = null) =>
        Apply(db, tx, actor, command, action, next.Id, prior.Revision, prior.PublishedRevision, next.Revision, ct, selected: selected);

    internal static async Task Apply(NpgsqlConnection db, NpgsqlTransaction tx, Guid actor, Guid command,
        ArticleAction action, int articleId, long previousRevision, long? publishedRevision, long nextRevision,
        CancellationToken ct, bool scheduled = false, IReadOnlyList<Content.PublishedMediaReference>? selected = null)
    {
        int publicationCount;
        int eventNo;
        ActivePublication? active;
        await using (var read = SqlCommands.Create(db, tx, """
            select a.publication_count,p.publication_id,p.revision,p.publication_no,p.published_at,
                   h.event_no,h.publication_no,h.publication_id
            from public.article a
            left join public.article_publication p on p.article_id=a.id
            left join lateral (
                select event_no,publication_no,publication_id from public.article_publication_history
                where article_id=a.id order by event_no desc limit 1
            ) h on true
            where a.id=$1
            """, articleId))
        await using (var row = await read.ExecuteReaderAsync(ct))
        {
            if (!await row.ReadAsync(ct)) throw new InvalidOperationException("Article disappeared inside a locked write.");
            publicationCount = row.GetInt32(0);
            active = row.IsDBNull(1) ? null : new(row.GetInt64(1), row.GetInt64(2), row.GetInt32(3), row.GetDateTime(4));
            eventNo = row.IsDBNull(5) ? 0 : row.GetInt32(5);
            long? tailId = row.IsDBNull(7) ? null : row.GetInt64(7);
            if (publishedRevision != active?.Revision || (active is not null && active.Number != publicationCount) ||
                (eventNo != 0 && (row.GetInt32(6) != publicationCount || tailId != active?.Id)))
                throw new InvalidOperationException("Active and historical publication coordinates disagree.");
        }
        // Offline upgrade captures every existing lineage. Direct imports can supply the same retained boundary on first write.
        if (eventNo == 0 && publicationCount > 0)
        {
            await Append(active?.Revision ?? previousRevision, ++eventNo, publicationCount, active?.Id, null,
                active is null ? "retained-hidden" : "retained-active", "pre-history", active?.PublishedAt, null, null);
        }

        if (action == ArticleAction.Publish)
        {
            await PublicationRightsStore.Require(db, tx, articleId, nextRevision, ct);
            var published = await Publish(db, tx, articleId, nextRevision, ct);
            var reason = scheduled ? (active is null ? "scheduled-published" : "scheduled-replaced") :
                active is null ? "author-published" : "author-replaced";
            await Append(nextRevision, checked(eventNo + 1), published.Number, published.Id, active?.Id,
                active is null ? "publish" : "replace", reason,
                published.PublishedAt, actor, command);
            await PublicationRightsStore.Attach(db, tx, articleId, nextRevision, published.Id, ct);
            if (selected is not null)
                await Content.PublishedMediaStore.Attach(db, tx, articleId, published.Id, nextRevision, selected, ct);
        }
        else
        {
            await SqlCommands.Execute(db, tx, ct, "delete from public.article_publication where article_id=$1", articleId);
            var now = (DateTime)(await SqlCommands.Scalar(db, tx, ct, "select clock_timestamp()"))!;
            var delete = action == ArticleAction.Delete;
            await Append(nextRevision, checked(eventNo + 1), publicationCount, null, active?.Id,
                delete ? "delete" : "retract", delete ? "author-deleted" : "author-withdrew", now, actor, command);
        }

        async Task Append(long revision, int number, int publications, long? publication, long? supersedes,
            string kind, string reason, DateTime? at, Guid? author, Guid? commandId)
        {
            await SqlCommands.Execute(db, tx, ct, """
                insert into public.article_publication_history
                    (article_id,event_no,revision,publication_no,publication_id,supersedes_id,kind,reason,happened_at,actor_id,command_id)
                values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                """, articleId, number, revision, publications, SqlCommands.Optional(NpgsqlDbType.Bigint, publication),
                SqlCommands.Optional(NpgsqlDbType.Bigint, supersedes), kind, reason, SqlCommands.Optional(NpgsqlDbType.TimestampTz, at),
                SqlCommands.Optional(NpgsqlDbType.Uuid, author), SqlCommands.Optional(NpgsqlDbType.Uuid, commandId));
        }
    }

    internal static async Task<AdminArticleRelease> RollbackByAdministrator(NpgsqlConnection db, NpgsqlTransaction tx,
        int article, long priorPublication, long sourceRevision, long revision, long previousRevision,
        long sourcePublication, long? sourceResponsibility, Guid administrator, Guid command, byte[] fingerprint, string reason,
        int destination, AdminPublicationRestoreSource? restored, CancellationToken ct,
        IReadOnlyList<Content.PublishedMediaReference>? selected = null)
    {
        var eventNo = restored?.EventNo ?? await RequireActiveBoundary(db, tx, article, priorPublication, ct);
        var hidden = destination != Wire.AdminArticleRestoreStatus;
        var fromTrash = restored?.FromTrash == true;

        await PublicationRightsStore.Require(db, tx, article, revision, ct);
        var release = hidden ? await WithdrawForRollback(db, tx, article, priorPublication, revision, ct)
            : await Publish(db, tx, article, revision, ct);
        await PublicationRightsStore.Attach(db, tx, article, revision, release.Id, ct);
        await using var rights = SqlCommands.Create(db, tx,
            "select id from public.article_publication_rights where publication_id=$1", release.Id);
        var rightsSnapshot = (long)(await rights.ExecuteScalarAsync(ct))!;

        // Copy the explicit historical evidence and record its exact immutable source.
        var administratorReference = $"admin:{administrator:D}";
        await using var responsibility = fromTrash && sourceResponsibility is null
            ? SqlCommands.Create(db, tx, """
                insert into public.article_revision_responsibility(article_id,revision,responsible_party,basis,reference,recorded_by)
                values($1,$2,$3,$4,$5,$3) returning id
                """, article, revision, administratorReference, reason, FormattableString.Invariant($"publication:{sourcePublication}"))
            : SqlCommands.Create(db, tx, """
            insert into public.article_revision_responsibility(article_id,revision,responsible_party,basis,reference,recorded_by,source_snapshot_id)
            select article_id,$2,responsible_party,basis,reference,recorded_by,id
            from public.article_revision_responsibility where article_id=$1 and revision=$3 and id=$4
            returning id
            """, article, revision, sourceRevision, SqlCommands.Optional(NpgsqlDbType.Bigint, sourceResponsibility));
        if (await responsibility.ExecuteScalarAsync(ct) is not long responsibilitySnapshot)
            throw new BusinessException(Rejection.Conflict, "The historical responsibility snapshot is unavailable.");
        await SqlCommands.Execute(db, tx, ct, """
            insert into public.article_publication_responsibility(publication_id,article_id,revision,snapshot_id)
            values($1,$2,$3,$4)
            """, release.Id, article, revision, responsibilitySnapshot);

        // A restore copies the exact archived predecessor. Its original public rollback source remains
        // retained separately from the predecessor revision and private release coordinates.
        var extraColumns = fromTrash ? ",destination,from_trash" : restored is not null ? ",destination,from_archive" :
            hidden ? ",destination" : "";
        var extraValues = restored is not null ? ",2,true" :
            destination == Wire.AdminArticleArchiveStatus ? ",3" : hidden ? ",0" : "";
        await SqlCommands.Execute(db, tx, ct, $"""
            insert into public.admin_article_rollback(principal_id,command_id,fingerprint,article_id,previous_revision,
                source_revision,revision,source_publication_id,previous_publication_id,publication_id,publication_no,
                published_at,rights_snapshot_id,responsibility_snapshot_id,reason{extraColumns})
            values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15{extraValues})
            """, administrator, command, fingerprint, article, previousRevision, restored?.HistoricalRevision ?? sourceRevision,
            revision, restored?.HistoricalPublicationId ?? sourcePublication, priorPublication, release.Id, release.Number,
            release.PublishedAt, rightsSnapshot, responsibilitySnapshot, reason);
        var (kind, eventReason) = (destination, restored is not null) switch
        {
            (Wire.AdminArticleArchiveStatus, false) => ("retract", ArchivedArticleAuthority.Reason),
            (Wire.AdminArticleRestoreStatus, true) => ("publish", fromTrash ? "administrator-trash-republished" : "administrator-archive-republished"),
            (Wire.AdminArticleRestoreStatus, false) => ("replace", "administrator-rollback-replaced"),
            _ => ("retract", "administrator-rollback-draft")
        };
        await SqlCommands.Execute(db, tx, ct, """
            insert into public.article_publication_history(article_id,event_no,revision,publication_no,publication_id,supersedes_id,
                kind,reason,happened_at,admin_actor_id,admin_command_id)
            values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            """, article, checked(eventNo + 1), revision, release.Number, SqlCommands.Optional(NpgsqlDbType.Bigint, hidden ? null : release.Id),
            SqlCommands.Optional(NpgsqlDbType.Bigint, restored is not null ? null : priorPublication), kind, eventReason,
            release.PublishedAt, administrator, command);

        if (hidden)
        {
            await SqlCommands.Execute(db, tx, ct, """
                insert into public.blog_outbox(article_id,revision,kind) values($1,$2,'retract')
                """, article, revision);
        }
        else
        {
            if (selected is not null)
                await Content.PublishedMediaStore.Attach(db, tx, article, release.Id, revision, selected, ct);
            await RecordPublishedOutbox(db, tx, article, revision, ct);
        }
        return new AdminArticleRelease(release.Id, release.Number, release.PublishedAt, rightsSnapshot, responsibilitySnapshot);
    }

    internal sealed record AdminArticleRelease(long Id, int Number, DateTime PublishedAt, long RightsSnapshot, long ResponsibilitySnapshot);

    internal sealed record AdminPublicationRestoreSource(int EventNo, long HistoricalRevision, long HistoricalPublicationId, bool FromTrash = false);

    private static async Task<int> RequireActiveBoundary(NpgsqlConnection db, NpgsqlTransaction tx, int article,
        long publication, CancellationToken ct)
    {
        return await SqlCommands.Scalar(db, tx, ct, """
            select h.event_no
            from public.article_publication_history h join public.article_publication p using(article_id)
            join public.article a on a.id=p.article_id
            where h.article_id=$1 and h.publication_id=$2 and p.publication_id=$2 and h.revision=p.revision
                and h.publication_no=p.publication_no and p.publication_no=a.publication_count
                and h.event_no=(select max(event_no) from public.article_publication_history where article_id=$1)
            """, article, publication) is int eventNo ? eventNo
            : throw new BusinessException(Rejection.Conflict, "The current publication requires a verified historical boundary.");
    }

    private static async Task<ActivePublication> WithdrawForRollback(NpgsqlConnection db, NpgsqlTransaction tx, int article,
        long priorPublication, long revision, CancellationToken ct)
    {
        // Reserve one release coordinate without creating a row in the public pointer table.
        await using var withdraw = SqlCommands.Create(db, tx, """
            with withdrawn as (
                delete from public.article_publication where article_id=$1 and publication_id=$2 returning article_id
            )
            update public.article a set publication_count=a.publication_count+1 from withdrawn w
            where a.id=w.article_id and a.revision=$3 and a.published_revision is null
            returning nextval('public.article_publication_publication_id_seq'),a.publication_count,clock_timestamp()
            """, article, priorPublication, revision);
        await using var row = await withdraw.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct))
            throw new BusinessException(Rejection.Conflict, "The publication changed before its withdrawal.");
        return new(row.GetInt64(0), revision, row.GetInt32(1), row.GetDateTime(2));
    }

    private static async Task<ActivePublication> Publish(NpgsqlConnection db, NpgsqlTransaction tx, int articleId, long revision, CancellationToken ct)
    {
        await using var publish = SqlCommands.Create(db, tx, """
            with next_publication as (
                update public.article set publication_count=publication_count+1 where id=$1 returning publication_count
            )
            insert into public.article_publication(article_id,revision,publication_no,published_at)
                select $1,$2,publication_count,clock_timestamp() from next_publication
            on conflict(article_id) do update set revision=excluded.revision,publication_no=excluded.publication_no,
                published_at=excluded.published_at,publication_id=excluded.publication_id
            returning publication_id,publication_no,published_at
            """, articleId, revision);
        await using var row = await publish.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct)) throw new InvalidOperationException("Could not record the new publication.");
        return new(row.GetInt64(0), revision, row.GetInt32(1), row.GetDateTime(2));
    }

    internal static async Task<long> RecordPublishedOutbox(NpgsqlConnection db, NpgsqlTransaction tx, int article, long revision,
        CancellationToken ct)
    {
        if (await SqlCommands.Scalar(db, tx, ct, """
            insert into public.blog_outbox(article_id,revision,kind) values($1,$2,'publish') returning id
            """, article, revision) is not long id)
            throw new InvalidOperationException("Could not record the new publication outbox event.");
        await PublicationCanonicalStore.Record(db, tx, article, revision, id, ct);
        return id;
    }
}
