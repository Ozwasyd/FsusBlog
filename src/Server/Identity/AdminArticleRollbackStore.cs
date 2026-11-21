using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Authoring;
using FsusBlog.V2.Server.Content;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Administration;

internal sealed class AdminArticleRollbackStore(AdminSessionGate gate, AdminStepUpService stepUp)
{
    internal Task CheckArticleRollbackAvailability(string? session, CancellationToken ct) =>
        gate.WithLiveAdmin(session, (_, _, _) => Task.FromResult(true), ct);

    internal Task CheckArticleDraftRollbackAvailability(string? session, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, _) =>
        {
            await RequireArticleDraftRollbackSchema(db, tx, ct);
            return true;
        }, ct);

    internal Task<AdminArticleRollbackPreview> PreviewArticleRollback(string? session, int article, long revision,
        CancellationToken ct) => gate.WithLiveAdmin(session, async (db, tx, _) =>
    {
        var state = await ReadRollbackTarget(db, tx, article, revision, locking: false, ct);
        return new AdminArticleRollbackPreview(article, state.CurrentRevision, state.CurrentPublication, revision,
            state.SourcePublication, state.SourceTitle, state.Blocker == AdminArticleRollbackBlock.Ready, (int)state.Blocker);
    }, ct);

    internal Task<byte[]> BeginArticleRollbackStepUp(string? session, AdminArticleRollbackIntent intent, CancellationToken ct) =>
        stepUp.BeginStepUp(session, ArticleRollbackIntentDigest(intent), async (db, tx, _) =>
        {
            var state = await ReadRollbackTarget(db, tx, intent.ArticleId, intent.SourceRevision, locking: false, ct);
            RequireRollbackTarget(state, intent);
        }, ct, AdminStepUpAction.PublishArticleRollback);

    internal Task<byte[]> CompleteArticleRollbackStepUp(string? session, PasskeyLoginRequest assertion, CancellationToken ct) =>
        stepUp.CompleteStepUp(session, assertion, AdminStepUpAction.PublishArticleRollback, ct);

    internal Task<byte[]> BeginArticleDraftRollbackStepUp(string? session, AdminArticleDraftRollbackIntent intent, CancellationToken ct) =>
        stepUp.BeginStepUp(session, ArticleDraftRollbackIntentDigest(intent), async (db, tx, _) =>
        {
            await RequireArticleDraftRollbackSchema(db, tx, ct);
            var state = await ReadRollbackTarget(db, tx, intent.ArticleId, intent.SourceRevision, locking: false, ct);
            RequireRollbackTarget(state, DraftCoordinates(intent));
        }, ct, AdminStepUpAction.DraftArticleRollback);

    internal Task<byte[]> CompleteArticleDraftRollbackStepUp(string? session, PasskeyLoginRequest assertion, CancellationToken ct) =>
        stepUp.CompleteStepUp(session, assertion, AdminStepUpAction.DraftArticleRollback, ct, RequireArticleDraftRollbackSchema);

    internal Task<AdminArticleRollbackReceipt> ExecuteArticleRollback(string? session, string? proof, AdminArticleRollbackIntent intent,
        Action invalidatePublic, CancellationToken ct) =>
        ExecuteRollbackAsync(gate, stepUp, session, proof, intent, ArticleRollbackIntentDigest(intent),
            AdminStepUpAction.PublishArticleRollback, Wire.AdminArticleRestoreStatus, invalidatePublic, ct);

    internal async Task<AdminArticleDraftRollbackReceipt> ExecuteArticleDraftRollback(string? session, string? proof,
        AdminArticleDraftRollbackIntent intent, Action invalidatePublic, CancellationToken ct)
    {
        var receipt = await ExecuteRollbackAsync(gate, stepUp, session, proof, DraftCoordinates(intent),
            ArticleDraftRollbackIntentDigest(intent), AdminStepUpAction.DraftArticleRollback,
            AdminArticleDraftRollbackStatus, invalidatePublic, ct);
        return new(receipt.ArticleId, receipt.Revision, receipt.SourceRevision, receipt.PreviousPublicationId, receipt.PublicationId,
            receipt.PublicationNo, receipt.PublishedUnixMs, receipt.RightsSnapshotId, receipt.ResponsibilitySnapshotId, intent.TargetStatus);
    }

    internal static Task<AdminArticleRollbackReceipt> ExecuteRollbackAsync(AdminSessionGate gate, AdminStepUpService stepUp,
        string? session, string? proof, AdminArticleRollbackIntent intent, byte[] fingerprint, AdminStepUpAction action,
        int destination, Action invalidatePublic, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, admin) =>
        {
            if (action == AdminStepUpAction.DraftArticleRollback) await RequireArticleDraftRollbackSchema(db, tx, ct);
            if (action == AdminStepUpAction.ArticleArchive) await AdminArticleArchiveStore.RequireArticleArchiveSchema(db, tx, ct);
            await Store.LockCommand(db, tx, admin.Id, intent.IdempotencyKey, ct);
            var retained = await ReadRetainedRollback(db, tx, admin.Id, intent.IdempotencyKey, fingerprint,
                action, destination, fromArchive: false, ct);
            if (retained is not null) return retained;
            await RequireRollbackProof(stepUp, db, tx, admin, proof, fingerprint, action, ct);

            var stage = await ReadRollbackTarget(db, tx, intent.ArticleId, intent.SourceRevision, locking: true, ct);
            RequireRollbackTarget(stage, intent);
            var article = intent.ArticleId;
            var revision = checked(stage.CurrentRevision + 1);
            await CopyRollbackRevision(db, tx, article, revision, stage.CurrentRevision, stage.SourceTitle, stage.SourceBody,
                intent.SourceRevision, destination, ct);

            var release = await PublicationHistoryStore.RollbackByAdministrator(db, tx, article, stage.CurrentPublication,
                intent.SourceRevision, revision, stage.CurrentRevision, stage.SourcePublication, stage.SourceResponsibility!.Value,
                admin.Id, intent.IdempotencyKey, fingerprint, intent.Reason, destination, restored: null, ct);
            invalidatePublic();
            return RollbackReceipt(article, revision, intent.SourceRevision, stage.CurrentPublication, release);
        }, ct);

    internal static async Task<AdminArticleRollbackReceipt?> ReadRetainedRollback(NpgsqlConnection db, NpgsqlTransaction tx,
        Guid administrator, Guid command, byte[] fingerprint, AdminStepUpAction action, int destination, bool fromArchive, CancellationToken ct)
    {
        var typedDestination = action != AdminStepUpAction.PublishArticleRollback;
        var archive = action == AdminStepUpAction.ArticleArchive;
        var trash = action == AdminStepUpAction.RestoreDeletedPublication;
        await using var previous = Store.Sql(db, tx, $"""
            select fingerprint,article_id,revision,{(fromArchive ? "previous_revision" : "source_revision")},
                previous_publication_id,publication_id,publication_no,published_at,rights_snapshot_id,responsibility_snapshot_id,
                {(typedDestination ? "destination" : "2")},{(archive ? "from_archive" : "false")}{(trash ? ",from_trash" : "")}
            from public.admin_article_rollback where principal_id=$1 and command_id=$2
            """, administrator, command);
        await using var receipt = await previous.ExecuteReaderAsync(ct);
        if (!await receipt.ReadAsync(ct)) return null;
        if (!CryptographicOperations.FixedTimeEquals(receipt.GetFieldValue<byte[]>(0), fingerprint) ||
            receipt.GetInt32(10) != destination || receipt.GetBoolean(11) != fromArchive || (trash && !receipt.GetBoolean(12)))
            throw new BusinessException(Rejection.Conflict, "This administrator rollback command key is already in use.");
        return new AdminArticleRollbackReceipt(receipt.GetInt32(1), receipt.GetInt64(2), receipt.GetInt64(3),
            receipt.GetInt64(4), receipt.GetInt64(5), receipt.GetInt32(6),
            new DateTimeOffset(receipt.GetDateTime(7)).ToUnixTimeMilliseconds(), receipt.GetInt64(8), receipt.GetInt64(9));
    }

    internal static async Task RequireRollbackProof(AdminStepUpService stepUp, NpgsqlConnection db, NpgsqlTransaction tx,
        AdminLiveSession admin, string? proof, byte[] fingerprint, AdminStepUpAction action, CancellationToken ct)
    {
        if (!await stepUp.ConsumeProofAsync(db, tx, admin, proof, fingerprint, ct, action))
            throw new BusinessException(Rejection.Forbidden, action switch
            {
                AdminStepUpAction.DraftArticleRollback => "A current Passkey proof for this exact draft rollback is required.",
                AdminStepUpAction.ArticleArchive => "A current Passkey proof for this exact archive transition is required.",
                AdminStepUpAction.RestoreDeletedPublication => "A current Passkey proof for this exact restoration of a former publication is required.",
                _ => "A current Passkey proof for this exact published rollback is required."
            });
    }

    internal static async Task CopyRollbackRevision(NpgsqlConnection db, NpgsqlTransaction tx, int article, long revision,
        long previousRevision, string title, string body, long sourceRevision, int destination, CancellationToken ct, bool wasDeleted = false)
    {
        await using (var update = Store.Sql(db, tx, """
            update public.article set revision=$2,title=$3,body=$4,deleted=false,
                published_revision=case when $6 then $2 else null end,updated_at=clock_timestamp()
            where id=$1 and revision=$5 and deleted=$7
            """, article, revision, title, body, previousRevision, destination == Wire.AdminArticleRestoreStatus, wasDeleted))
            if (await update.ExecuteNonQueryAsync(ct) != 1)
                throw new BusinessException(Rejection.Conflict, "The article has changed.");
        await using (var addRevision = Store.Sql(db, tx, """
            insert into public.article_revision(article_id,revision,title,body,happened_at,author_summary)
            select $1,$2,$3,$4,clock_timestamp(),author_summary from public.article_revision
            where article_id=$1 and revision=$5
            """, article, revision, title, body, sourceRevision))
            if (await addRevision.ExecuteNonQueryAsync(ct) != 1)
                throw new BusinessException(Rejection.Conflict, "The rollback source is unavailable.");
        await PropertyStore.CopySnapshot(db, tx, article, sourceRevision, revision, ct);
        await TaxonomyStore.CarryForward(db, tx, article, sourceRevision, revision, ct);
        await PublicationRightsStore.CarryForward(db, tx, article, sourceRevision, revision, ct);
    }

    internal static AdminArticleRollbackReceipt RollbackReceipt(int article, long revision, long sourceRevision, long previousRelease,
        PublicationHistoryStore.AdminArticleRelease release) => new(article, revision, sourceRevision, previousRelease, release.Id,
            release.Number, new DateTimeOffset(release.PublishedAt).ToUnixTimeMilliseconds(), release.RightsSnapshot,
            release.ResponsibilitySnapshot);

    internal static byte[] ArticleRollbackIntentDigest(AdminArticleRollbackIntent intent) =>
        SHA256.HashData(Wire.EncodeAdminArticleRollbackIntent(intent));

    internal static byte[] ArticleDraftRollbackIntentDigest(AdminArticleDraftRollbackIntent intent) =>
        SHA256.HashData(Wire.EncodeAdminArticleDraftRollbackIntent(intent));

    internal const int AdminArticleDraftRollbackStatus = 0;

    private static AdminArticleRollbackIntent DraftCoordinates(AdminArticleDraftRollbackIntent intent) =>
        new(intent.ArticleId, intent.ExpectedRevision, intent.ExpectedPublicationId, intent.SourceRevision, intent.IdempotencyKey, intent.Reason);

    internal static async Task RequireArticleDraftRollbackSchema(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        if (!await CurrentSchema.HasAdminArticleDraftRollbackSchemaAsync(db, tx, ct))
            throw new BusinessException(Rejection.NotFound, "Draft rollback is unavailable.");
    }

    internal sealed record ArticleRollbackTarget(long CurrentRevision, long CurrentPublication, long SourcePublication,
        string SourceTitle, string SourceBody, long? SourceResponsibility, AdminArticleRollbackBlock Blocker);

    internal static async Task<ArticleRollbackTarget> ReadRollbackTarget(NpgsqlConnection db, NpgsqlTransaction tx, int article,
        long sourceRevision, bool locking, CancellationToken ct)
    {
        if (locking)
        {
            await using var take = Store.Sql(db, tx, "select id from public.article where id=$1 and not deleted for update", article);
            if (await take.ExecuteScalarAsync(ct) is null)
                throw new BusinessException(Rejection.NotFound, "Article is unavailable for published rollback.");
        }
        await using var inspect = Store.Sql(db, tx, """
            select a.revision,p.publication_id,source.publication_id,r.title,case when $3 then r.body else '' end,linked.snapshot_id,
                   (rights.id is not null and policy.article_id is not null),
                   exists(select from public.article_revision_media where article_id=a.id and revision=r.revision),
                   exists(select from public.article_schedule where article_id=a.id),a.revision<>p.revision
            from public.article a join public.article_publication p on p.article_id=a.id and p.revision=a.published_revision
            join public.article_revision r on r.article_id=a.id and r.revision=$2 and r.revision<a.revision
            join public.article_publication_history source on source.article_id=a.id and source.revision=r.revision
                and source.publication_id is not null and source.publication_no<=p.publication_no
            left join public.article_publication_rights rights on rights.article_id=a.id and rights.revision=r.revision
                and rights.publication_id=source.publication_id
            left join public.article_revision_rights policy on policy.article_id=rights.article_id and policy.revision=rights.revision
            left join public.article_publication_responsibility linked on linked.article_id=a.id and linked.revision=r.revision
                and linked.publication_id=source.publication_id
            where a.id=$1 and not a.deleted
            """, article, sourceRevision, locking);
        await using var row = await inspect.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct))
            throw new BusinessException(Rejection.NotFound, "The requested historical publication is unavailable for this article.");
        long? responsibility = row.IsDBNull(5) ? null : row.GetInt64(5);
        var blocker = row.GetBoolean(8) ? AdminArticleRollbackBlock.PendingSchedule :
            row.GetBoolean(9) ? AdminArticleRollbackBlock.UnpublishedDraft :
            row.GetBoolean(7) ? AdminArticleRollbackBlock.PrivateAttachment :
            !row.GetBoolean(6) ? AdminArticleRollbackBlock.MissingRights :
            responsibility is null ? AdminArticleRollbackBlock.MissingResponsibility : AdminArticleRollbackBlock.Ready;
        return new(row.GetInt64(0), row.GetInt64(1), row.GetInt64(2), row.GetString(3), row.GetString(4), responsibility, blocker);
    }

    internal static void RequireRollbackTarget(ArticleRollbackTarget current, AdminArticleRollbackIntent intent)
    {
        if (current.CurrentRevision != intent.ExpectedRevision || current.CurrentPublication != intent.ExpectedPublicationId)
            throw new BusinessException(Rejection.Conflict, "The current revision or publication changed.");
        if (current.CurrentRevision == long.MaxValue)
            throw new BusinessException(Rejection.Conflict, "The article revision limit was reached.");
        if (current.Blocker != AdminArticleRollbackBlock.Ready)
            throw new BusinessException(Rejection.Conflict, current.Blocker switch
            {
                AdminArticleRollbackBlock.MissingRights => "The historical publication rights snapshot is missing.",
                AdminArticleRollbackBlock.MissingResponsibility => "The historical responsibility snapshot is missing.",
                AdminArticleRollbackBlock.PrivateAttachment => "The historical revision includes an unsupported private attachment.",
                AdminArticleRollbackBlock.PendingSchedule => "Resolve the pending publication before performing a published rollback.",
                _ => "Resolve the unpublished draft before performing a published rollback."
            });
    }
}
