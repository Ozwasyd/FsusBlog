using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Authoring;
using FsusBlog.V2.Server.Content;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Administration;

internal sealed class AdminArticleTrashPublicationStore(AdminSessionGate gate, AdminStepUpService stepUp)
{
    private sealed record FormerPublication(AdminArticleTrashPublicationPreview Preview, Guid Owner, string Body,
        long? Responsibility, int DeleteEvent);

    internal Task CheckTrashPublicationAvailability(string? session, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, _) =>
        {
            await RequireTrashPublicationSchema(db, tx, ct);
            return true;
        }, ct);

    internal Task<AdminArticleTrashPublicationPreview> PreviewTrashPublication(string? session, int article, long revision, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, _) =>
            (await ReadFormerPublication(db, tx, article, revision, locking: false, ct)).Preview, ct);

    internal Task<byte[]> BeginTrashPublicationStepUp(string? session, AdminArticleTrashPublicationIntent intent, CancellationToken ct) =>
        stepUp.BeginStepUp(session, TrashPublicationFingerprint(intent), async (db, tx, _) =>
        {
            var source = await ReadFormerPublication(db, tx, intent.ArticleId, intent.ExpectedRevision, locking: false, ct);
            RequireFormerPublication(intent, source.Preview);
        }, ct, AdminStepUpAction.RestoreDeletedPublication);

    internal Task<byte[]> CompleteTrashPublicationStepUp(string? session, PasskeyLoginRequest request, CancellationToken ct) =>
        stepUp.CompleteStepUp(session, request, AdminStepUpAction.RestoreDeletedPublication, ct, RequireTrashPublicationSchema);

    internal Task<AdminArticleTrashPublicationReceipt> RestoreTrashPublication(string? session, string? proof,
        AdminArticleTrashPublicationIntent intent, PublishedMediaStore? media, Action invalidatePublic, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, admin) =>
        {
            await RequireTrashPublicationSchema(db, tx, ct);
            const AdminStepUpAction action = AdminStepUpAction.RestoreDeletedPublication;
            var fingerprint = TrashPublicationFingerprint(intent);
            await Store.LockCommand(db, tx, admin.Id, intent.IdempotencyKey, ct);
            var previous = await AdminArticleRollbackStore.ReadRetainedRollback(db, tx, admin.Id, intent.IdempotencyKey, fingerprint,
                action, Wire.AdminArticleRestoreStatus, fromArchive: false, ct);
            if (previous is not null)
                return new AdminArticleTrashPublicationReceipt(previous.ArticleId, previous.Revision, previous.SourceRevision,
                    previous.PreviousPublicationId, previous.PublicationId);
            await AdminArticleRollbackStore.RequireRollbackProof(stepUp, db, tx, admin, proof, fingerprint, action, ct);
            var source = await ReadFormerPublication(db, tx, intent.ArticleId, intent.ExpectedRevision, locking: true, ct);
            RequireFormerPublication(intent, source.Preview);
            var next = checked(intent.ExpectedRevision + 1);
            var assets = await PublishedMediaStore.RestoreSelection(db, tx, media, source.Owner, intent.ArticleId,
                intent.SourceRevision, intent.SourcePublicationId, ct);
            await AdminArticleRollbackStore.CopyRollbackRevision(db, tx, intent.ArticleId, next, intent.ExpectedRevision,
                source.Preview.Title, source.Body, intent.SourceRevision, Wire.AdminArticleRestoreStatus, ct, wasDeleted: true);
            await ArticleMediaStore.Copy(db, tx, source.Owner, intent.ArticleId, intent.SourceRevision, next, null, ct);
            var release = await PublicationHistoryStore.RollbackByAdministrator(db, tx, intent.ArticleId, intent.SourcePublicationId,
                intent.SourceRevision, next, intent.ExpectedRevision, intent.SourcePublicationId, source.Responsibility, admin.Id,
                intent.IdempotencyKey, fingerprint, intent.Reason, Wire.AdminArticleRestoreStatus,
                new(source.DeleteEvent, intent.SourceRevision, intent.SourcePublicationId, FromTrash: true), ct, assets);
            invalidatePublic();
            return new AdminArticleTrashPublicationReceipt(intent.ArticleId, next, intent.SourceRevision, intent.SourcePublicationId, release.Id);
        }, ct);

    private static async Task<FormerPublication> ReadFormerPublication(NpgsqlConnection db, NpgsqlTransaction tx, int article,
        long revision, bool locking, CancellationToken ct)
    {
        await RequireTrashPublicationSchema(db, tx, ct);
        if (revision == long.MaxValue) throw AdminArticleTrashRestoreStore.TrashRestoreConflict();
        if (locking)
        {
            if (await SqlCommands.Scalar(db, tx, ct,
                "select id from public.article where id=$1 and deleted for update", article) is null)
                throw AdminArticleTrashRestoreStore.TrashRestoreConflict();
        }
        await using var query = Store.Sql(db, tx, $"""
            select a.owner_id,source.revision,prior.publication_id,source.title,case when $3 then source.body else '' end,
                linked.snapshot_id,deleted.event_no
            from public.article a join public.article_publication_history deleted on deleted.article_id=a.id and deleted.revision=a.revision
            join public.article_command deletion on (deletion.actor_id,deletion.command_id)=(deleted.actor_id,deleted.command_id)
                and deletion.article_id=a.id and deletion.revision=a.revision and not deletion.published
            join public.article_publication_history prior on prior.article_id=a.id and prior.event_no=deleted.event_no-1
                and prior.publication_id=deleted.supersedes_id and prior.publication_no=deleted.publication_no
            join public.article_revision source on source.article_id=a.id and source.revision=prior.revision
            join public.article_publication_rights rights on (rights.article_id,rights.revision,rights.publication_id)=(a.id,source.revision,prior.publication_id)
            join public.article_revision_rights policy on (policy.article_id,policy.revision)=(a.id,source.revision)
            left join public.article_publication_responsibility linked on (linked.article_id,linked.revision,linked.publication_id)=(a.id,source.revision,prior.publication_id)
            where {AdminArticleTrashRestoreStore.TrashArticlePredicate} and a.revision=$2 and prior.revision<a.revision and deleted.kind='delete'
                and deleted.reason='author-deleted' and deleted.actor_id=a.owner_id and deleted.publication_id is null
                and deleted.publication_no=a.publication_count and deleted.happened_at is not null
                and deleted.event_no=(select max(event_no) from public.article_publication_history where article_id=a.id)
                and prior.kind in ('retained-active','publish','replace') and prior.happened_at is not null
                and not exists(select from public.article_schedule where article_id=a.id)
            """, article, revision, locking);
        await using var row = await query.ExecuteReaderAsync(ct);
        await row.ReadRequired(ct, () => new BusinessException(Rejection.Conflict, "No verified previous publication is available for this trash item."));
        return new(new(article, revision, row.GetInt64(1), row.GetInt64(2), row.GetString(3)), row.GetGuid(0),
            row.GetString(4), row.IsDBNull(5) ? null : row.GetInt64(5), row.GetInt32(6));
    }

    private static void RequireFormerPublication(AdminArticleTrashPublicationIntent intent, AdminArticleTrashPublicationPreview source)
    {
        if (intent.SourceRevision != source.SourceRevision || intent.SourcePublicationId != source.SourcePublicationId)
            throw AdminArticleTrashRestoreStore.TrashRestoreConflict();
    }

    private static async Task RequireTrashPublicationSchema(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        if (!await CurrentSchema.HasAdminArticleTrashPublicationSchemaAsync(db, tx, ct))
            throw new BusinessException(Rejection.NotFound, "Former publication restoration is unavailable.");
    }

    private static byte[] TrashPublicationFingerprint(AdminArticleTrashPublicationIntent intent) =>
        SHA256.HashData(Wire.EncodeAdminArticleTrashPublicationIntent(intent));
}
