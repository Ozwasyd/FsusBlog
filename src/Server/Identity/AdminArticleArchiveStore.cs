using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Authoring;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Administration;

internal sealed class AdminArticleArchiveStore(AdminSessionGate gate, AdminStepUpService stepUp)
{
    // Check the exact current article, historical tail, and retained private release together.
    private const string CurrentArchive = $"""
        from public.admin_article_rollback archived
        join public.article a on a.id=archived.article_id and a.revision=archived.revision
        join public.article_revision r on r.article_id=a.id and r.revision=a.revision
        join public.article_publication_history h on h.article_id=a.id and h.revision=a.revision
            and h.admin_actor_id=archived.principal_id and h.admin_command_id=archived.command_id
            and h.publication_no=archived.publication_no and h.happened_at=archived.published_at
            and h.kind='retract' and h.reason='{ArchivedArticleAuthority.Reason}'
        where archived.destination=3 and not archived.from_archive and not a.deleted
            and a.published_revision is null and a.publication_count=archived.publication_no
            and not exists(select from public.article_publication where article_id=a.id)
            and not ({ArchivedArticleAuthority.Available})
        """;

    internal Task CheckArticleArchiveAvailability(string? session, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, _) =>
        {
            await RequireArticleArchiveSchema(db, tx, ct);
            return true;
        }, ct);

    internal Task<AdminArticleArchivePage> ListArchivedArticles(string? session, int before, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, _) =>
        {
            await RequireArticleArchiveSchema(db, tx, ct);
            var limit = WireLimits.AdminArticleArchivePageSize;
            await using var query = Store.Sql(db, tx, $"""
                select a.id,a.revision,archived.publication_id,archived.publication_no,h.happened_at,a.title
                {CurrentArchive}
                and archived.article_id<$1
                order by archived.article_id desc limit $2
                """, before > 0 ? before : (long)int.MaxValue + 1, limit + 1);
            await using var rows = await query.ExecuteReaderAsync(ct);
            var items = new List<AdminArticleArchiveRow>(limit);
            while (await rows.ReadAsync(ct))
            {
                if (items.Count == limit) return new AdminArticleArchivePage(items[^1].ArticleId, items);
                items.Add(new(rows.GetInt32(0), rows.GetInt64(1), rows.GetInt64(2), rows.GetInt32(3),
                    new DateTimeOffset(rows.GetDateTime(4)).ToUnixTimeMilliseconds(), rows.GetString(5)));
            }
            return new AdminArticleArchivePage(0, items);
        }, ct);

    internal Task<byte[]> PreviewArchivedArticle(string? session, int article, long revision,
        long privateRelease, CancellationToken ct) => gate.WithLiveAdmin(session, async (db, tx, _) =>
    {
        await RequireArticleArchiveSchema(db, tx, ct);
        await using (var take = Store.Sql(db, tx, """
            select id from public.article where id=$1 and revision=$2 and not deleted
                and published_revision is null for share
            """, article, revision))
            if (await take.ExecuteScalarAsync(ct) is null)
                throw new BusinessException(Rejection.Conflict, "The article no longer has a matching archived release.");

        // Recheck archive history and release authority in a fresh statement after any lock wait.
        var archive = await ReadArchivedTarget(db, tx, article, revision, privateRelease, locking: false, includeBody: true, ct);
        return Wire.EncodeAdminArticleArchivePreview(new(article, revision, privateRelease, archive.Title, archive.Body));
    }, ct);

    internal Task<byte[]> BeginArticleArchiveStepUp(string? session, AdminArticleArchiveIntent intent, CancellationToken ct) =>
        stepUp.BeginStepUp(session, ArticleArchiveIntentDigest(intent), async (db, tx, _) =>
        {
            await RequireArticleArchiveSchema(db, tx, ct);
            if (intent.TargetStatus == Wire.AdminArticleArchiveStatus)
            {
                var state = await AdminArticleRollbackStore.ReadRollbackTarget(db, tx, intent.ArticleId, intent.SourceRevision, locking: false, ct);
                AdminArticleRollbackStore.RequireRollbackTarget(state, ArchiveCoordinates(intent));
            }
            else
            {
                await ReadArchivedTarget(db, tx, intent.ArticleId, intent.ExpectedRevision, intent.ExpectedReleaseId,
                    locking: false, includeBody: false, ct);
            }
        }, ct, AdminStepUpAction.ArticleArchive);

    internal Task<byte[]> CompleteArticleArchiveStepUp(string? session, PasskeyLoginRequest assertion, CancellationToken ct) =>
        stepUp.CompleteStepUp(session, assertion, AdminStepUpAction.ArticleArchive, ct, RequireArticleArchiveSchema);

    internal async Task<AdminArticleArchiveReceipt> ExecuteArticleArchive(string? session, string? proof,
        AdminArticleArchiveIntent intent, Action invalidatePublic, CancellationToken ct)
    {
        var fingerprint = ArticleArchiveIntentDigest(intent);
        var receipt = intent.TargetStatus == Wire.AdminArticleArchiveStatus
            ? await AdminArticleRollbackStore.ExecuteRollbackAsync(gate, stepUp, session, proof, ArchiveCoordinates(intent),
                fingerprint, AdminStepUpAction.ArticleArchive, intent.TargetStatus, invalidatePublic, ct)
            : await RestoreArchivedArticle(session, proof, intent, fingerprint, invalidatePublic, ct);
        return new(receipt.ArticleId, receipt.Revision, receipt.SourceRevision, receipt.PreviousPublicationId,
            receipt.PublicationId, receipt.PublicationNo, receipt.PublishedUnixMs, receipt.RightsSnapshotId,
            receipt.ResponsibilitySnapshotId, intent.TargetStatus);
    }

    private Task<AdminArticleRollbackReceipt> RestoreArchivedArticle(string? session, string? proof,
        AdminArticleArchiveIntent intent, byte[] fingerprint, Action invalidatePublic, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, admin) =>
        {
            await RequireArticleArchiveSchema(db, tx, ct);
            await Store.LockCommand(db, tx, admin.Id, intent.IdempotencyKey, ct);
            var replay = await AdminArticleRollbackStore.ReadRetainedRollback(db, tx, admin.Id, intent.IdempotencyKey, fingerprint,
                AdminStepUpAction.ArticleArchive, intent.TargetStatus, fromArchive: true, ct);
            if (replay is not null) return replay;
            await AdminArticleRollbackStore.RequireRollbackProof(stepUp, db, tx, admin, proof, fingerprint, AdminStepUpAction.ArticleArchive, ct);

            var archive = await ReadArchivedTarget(db, tx, intent.ArticleId, intent.ExpectedRevision, intent.ExpectedReleaseId,
                locking: true, includeBody: true, ct);
            var revision = checked(intent.ExpectedRevision + 1);
            await AdminArticleRollbackStore.CopyRollbackRevision(db, tx, intent.ArticleId, revision, intent.ExpectedRevision, archive.Title,
                archive.Body, intent.SourceRevision, intent.TargetStatus, ct);
            var release = await PublicationHistoryStore.RollbackByAdministrator(db, tx, intent.ArticleId,
                intent.ExpectedReleaseId, intent.SourceRevision, revision, intent.ExpectedRevision, intent.ExpectedReleaseId,
                archive.Responsibility, admin.Id, intent.IdempotencyKey, fingerprint, intent.Reason, intent.TargetStatus,
                archive.Lineage, ct);
            invalidatePublic();
            return AdminArticleRollbackStore.RollbackReceipt(intent.ArticleId, revision, intent.SourceRevision, intent.ExpectedReleaseId, release);
        }, ct);

    internal static byte[] ArticleArchiveIntentDigest(AdminArticleArchiveIntent intent) =>
        SHA256.HashData(Wire.EncodeAdminArticleArchiveIntent(intent));

    private static AdminArticleRollbackIntent ArchiveCoordinates(AdminArticleArchiveIntent intent) =>
        new(intent.ArticleId, intent.ExpectedRevision, intent.ExpectedReleaseId, intent.SourceRevision, intent.IdempotencyKey, intent.Reason);

    internal static async Task RequireArticleArchiveSchema(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        if (!await CurrentSchema.HasAdminArticleArchiveSchemaAsync(db, tx, ct))
            throw new BusinessException(Rejection.NotFound, "Article archive transitions are unavailable.");
    }

    private sealed record ArchivedTarget(string Title, string Body, long Responsibility, PublicationHistoryStore.AdminPublicationRestoreSource Lineage);

    private static async Task<ArchivedTarget> ReadArchivedTarget(NpgsqlConnection db, NpgsqlTransaction tx,
        int article, long revision, long privateRelease, bool locking, bool includeBody, CancellationToken ct)
    {
        if (locking)
        {
            await using var take = Store.Sql(db, tx, "select id from public.article where id=$1 and not deleted for update", article);
            if (await take.ExecuteScalarAsync(ct) is null)
                throw new BusinessException(Rejection.NotFound, "The archived article is unavailable.");
        }

        await using var query = Store.Sql(db, tx, $"""
            select a.revision,archived.publication_id,r.title,
                case when $2 and ($3 or octet_length(r.body)<=$4) then r.body end,
                archived.responsibility_snapshot_id,h.event_no,archived.source_revision,archived.source_publication_id,
                exists(select from public.article_schedule where article_id=a.id),
                exists(select from public.article_revision_media where article_id=a.id and revision=a.revision),
                exists(select from public.article_publication_rights rights
                    join public.article_revision_rights policy on policy.article_id=rights.article_id and policy.revision=rights.revision
                    where rights.id=archived.rights_snapshot_id and rights.publication_id=archived.publication_id
                        and rights.article_id=a.id and rights.revision=a.revision),
                exists(select from public.article_publication_responsibility linked
                    where linked.publication_id=archived.publication_id and linked.article_id=a.id
                        and linked.revision=a.revision and linked.snapshot_id=archived.responsibility_snapshot_id)
            {CurrentArchive}
            and archived.article_id=$1
            """, article, includeBody, locking, WireLimits.BodyBytes);
        await using var row = await query.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct))
            throw new BusinessException(Rejection.Conflict, "The article no longer has a matching archived release.");
        if (row.GetInt64(0) != revision || row.GetInt64(1) != privateRelease)
            throw new BusinessException(Rejection.Conflict, "The archived revision or private release changed.");
        if (revision == long.MaxValue || row.GetBoolean(8) || row.GetBoolean(9) ||
            !row.GetBoolean(10) || !row.GetBoolean(11))
            throw new BusinessException(Rejection.Conflict, "The archived release package is incomplete or a publication is pending.");
        if (includeBody && row.IsDBNull(3))
            throw new BusinessException(Rejection.Conflict, "The archived source exceeds the preview size limit.");
        return new(row.GetString(2), includeBody ? row.GetString(3) : "", row.GetInt64(4),
            new(row.GetInt32(5), row.GetInt64(6), row.GetInt64(7)));
    }
}
