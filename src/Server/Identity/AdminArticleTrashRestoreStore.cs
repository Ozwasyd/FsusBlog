using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Authoring;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Administration;

internal sealed class AdminArticleTrashRestoreStore(AdminSessionGate gate, AdminStepUpService stepUp)
{
    internal const string TrashArticlePredicate = $"""
        a.id=$1 and a.deleted and a.published_revision is null
            and not exists(select from public.article_publication p where p.article_id=a.id)
            and {ArchivedArticleAuthority.Available}
        """;

    private const string TrashArticle = $"from public.article a where {TrashArticlePredicate}";

    internal Task CheckTrashRestoreAvailability(string? session, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, _) =>
        {
            await RequireTrashRestoreSchema(db, tx, ct);
            return true;
        }, ct);

    internal Task<byte[]> BeginTrashRestoreStepUp(string? session, AdminArticleTrashRestoreIntent intent, CancellationToken ct) =>
        stepUp.BeginStepUp(session, TrashRestoreFingerprint(intent), async (db, tx, _) =>
        {
            await RequireTrashRestoreSchema(db, tx, ct);
            await using var query = Store.Sql(db, tx, $"select a.revision {TrashArticle}", intent.ArticleId);
            if (await query.ExecuteScalarAsync(ct) is not long revision || revision != intent.ExpectedRevision)
                throw TrashRestoreConflict();
        }, ct, AdminStepUpAction.RestoreArticleTrash);

    internal Task<byte[]> CompleteTrashRestoreStepUp(string? session, PasskeyLoginRequest request, CancellationToken ct) =>
        stepUp.CompleteStepUp(session, request, AdminStepUpAction.RestoreArticleTrash, ct, RequireTrashRestoreSchema);

    internal Task<AdminArticleTrashRestoreReceipt> RestoreFromTrash(string? session, string? proof, AdminArticleTrashRestoreIntent intent,
        CancellationToken ct) => gate.WithLiveAdmin(session, async (db, tx, admin) =>
    {
        await RequireTrashRestoreSchema(db, tx, ct);
        var fingerprint = TrashRestoreFingerprint(intent);
        await Store.LockCommand(db, tx, admin.Id, intent.IdempotencyKey, ct);
        await using (var read = Store.Sql(db, tx, """
            select fingerprint,article_id,revision from public.admin_article_trash_restore
            where principal_id=$1 and command_id=$2
            """, admin.Id, intent.IdempotencyKey))
        await using (var previous = await read.ExecuteReaderAsync(ct))
        {
            if (await previous.ReadAsync(ct))
            {
                if (!CryptographicOperations.FixedTimeEquals(fingerprint, previous.GetFieldValue<byte[]>(0)))
                    throw new BusinessException(Rejection.Conflict, "This administrator command key is already in use.");
                return new AdminArticleTrashRestoreReceipt(previous.GetInt32(1), previous.GetInt64(2));
            }
        }
        if (!await stepUp.ConsumeProofAsync(db, tx, admin, proof, fingerprint, ct, AdminStepUpAction.RestoreArticleTrash))
            throw new BusinessException(Rejection.Forbidden, "A current Passkey proof for this exact trash restoration is required.");

        await using (var take = Store.Sql(db, tx, "select id from public.article where id=$1 for update", intent.ArticleId))
            if (await take.ExecuteScalarAsync(ct) is null) throw TrashRestoreConflict();
        ArticleState current;
        await using (var query = Store.Sql(db, tx, $"select a.owner_id,a.revision,a.title,a.body {TrashArticle}", intent.ArticleId))
        await using (var row = await query.ExecuteReaderAsync(ct))
        {
            if (!await row.ReadAsync(ct)) throw TrashRestoreConflict();
            current = new(intent.ArticleId, row.GetGuid(0), row.GetInt64(1), row.GetString(2), row.GetString(3), null, true);
        }
        var draft = Publishing.Restore(current, intent.ExpectedRevision);
        await Store.WriteRecoveredDraft(db, tx, draft, intent.ExpectedRevision, ct);
        await AdminSql.Execute(db, tx, ct, """
            insert into public.admin_article_trash_restore(principal_id,command_id,fingerprint,article_id,previous_revision,revision)
            values($1,$2,$3,$4,$5,$6)
            """, admin.Id, intent.IdempotencyKey, fingerprint, draft.Id, intent.ExpectedRevision, draft.Revision);
        return new AdminArticleTrashRestoreReceipt(draft.Id, draft.Revision);
    }, ct);

    internal Task<byte[]> DeleteArticle(string? session, int articleId, Action invalidate, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, admin) =>
        {
            long revision;
            string title;
            string body;
            bool deleted;
            await using (var query = Store.Sql(db, tx, $"""
                select a.revision,a.title,a.body,a.deleted
                from public.article a
                where a.id=$1 and {ArchivedArticleAuthority.Available}
                for update of a
                """, articleId))
            await using (var row = await query.ExecuteReaderAsync(ct))
            {
                if (!await row.ReadAsync(ct))
                    throw new BusinessException(Rejection.NotFound, "Article not found.");
                revision = row.GetInt64(0);
                title = row.GetString(1);
                body = row.GetString(2);
                deleted = row.GetBoolean(3);
            }
            if (deleted)
                throw new BusinessException(Rejection.NotFound, "Article not found.");
            var actor = new Identity(admin.Id, admin.Snapshot.Handle, admin.Snapshot.Generation, true, DateTimeOffset.MaxValue);
            await Store.Execute(db, tx, actor, ArticleAction.Delete, new Edit(articleId, revision, Guid.NewGuid(), title, body), ct);
            invalidate();
            return Wire.EncodeEmptySuccess();
        }, ct);

    private static async Task RequireTrashRestoreSchema(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        if (!await CurrentSchema.HasAdminArticleTrashRestoreAsync(db, tx, ct))
            throw new BusinessException(Rejection.NotFound, "Administrator trash restoration is unavailable.");
    }

    private static byte[] TrashRestoreFingerprint(AdminArticleTrashRestoreIntent intent) =>
        SHA256.HashData(Wire.EncodeAdminArticleTrashRestoreIntent(intent));

    internal static BusinessException TrashRestoreConflict() =>
        new(Rejection.Conflict, "The deleted article revision changed. Reload the trash.");
}
