using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Authoring;
using FsusBlog.V2.Server.Content;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Administration;

internal sealed partial class AdminPasskeyStore
{
    private const string RollbackPermission = CurrentSchema.ArticleWritePermission;

    internal Task CheckArticleRollbackAvailability(string? session, CancellationToken ct) =>
        WithLiveAdmin(session, RollbackPermission, (_, _, _) => Task.FromResult(true), ct);

    internal Task<AdminArticleRollbackPreview> PreviewArticleRollback(string? session, int article, long revision,
        CancellationToken ct) => WithLiveAdmin(session, RollbackPermission, async (db, tx, _) =>
    {
        var state = await ReadRollbackTarget(db, tx, article, revision, locking: false, ct);
        return new AdminArticleRollbackPreview(article, state.CurrentRevision, state.CurrentPublication, revision,
            state.SourcePublication, state.SourceTitle, state.Blocker == AdminArticleRollbackBlock.Ready, (int)state.Blocker);
    }, ct);

    internal Task<byte[]> BeginArticleRollbackStepUp(string? session, AdminArticleRollbackIntent intent, CancellationToken ct) =>
        BeginStepUp(session, ArticleRollbackIntentDigest(intent), async (db, tx, _) =>
        {
            var state = await ReadRollbackTarget(db, tx, intent.ArticleId, intent.SourceRevision, locking: false, ct);
            RequireRollbackTarget(state, intent);
        }, ct, StepUpAction.PublishArticleRollback);

    internal Task<byte[]> CompleteArticleRollbackStepUp(string? session, PasskeyLoginRequest assertion, CancellationToken ct) =>
        CompleteStepUp(session, assertion, StepUpAction.PublishArticleRollback, ct);

    internal Task<AdminArticleRollbackReceipt> ExecuteArticleRollback(string? session, string? proof, AdminArticleRollbackIntent intent,
        Action invalidatePublic, CancellationToken ct) =>
        WithLiveAdmin(session, RollbackPermission, async (db, tx, admin) =>
        {
            var fingerprint = ArticleRollbackIntentDigest(intent);
            await Store.LockCommand(db, tx, admin.Id, intent.IdempotencyKey, ct);
            await using (var previous = Store.Sql(db, tx, """
                select fingerprint,article_id,revision,source_revision,previous_publication_id,publication_id,
                    publication_no,published_at,rights_snapshot_id,responsibility_snapshot_id
                from public.admin_article_rollback where principal_id=$1 and command_id=$2
                """, admin.Id, intent.IdempotencyKey))
            await using (var receipt = await previous.ExecuteReaderAsync(ct))
            {
                if (await receipt.ReadAsync(ct))
                {
                    if (!CryptographicOperations.FixedTimeEquals(receipt.GetFieldValue<byte[]>(0), fingerprint))
                        throw new BusinessException(Rejection.Conflict, "This administrator rollback command key is already in use.");
                    return new AdminArticleRollbackReceipt(receipt.GetInt32(1), receipt.GetInt64(2), receipt.GetInt64(3),
                        receipt.GetInt64(4), receipt.GetInt64(5), receipt.GetInt32(6),
                        new DateTimeOffset(receipt.GetDateTime(7)).ToUnixTimeMilliseconds(), receipt.GetInt64(8), receipt.GetInt64(9));
                }
            }

            if (proof is not { Length: 43 } || !proof.All(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_') ||
                !await ConsumeStepUpProof(db, tx, admin, ChallengeDigest(proof, null), fingerprint, ct, StepUpAction.PublishArticleRollback))
                throw new BusinessException(Rejection.Forbidden, "A current Passkey proof for this exact published rollback is required.");

            var stage = await ReadRollbackTarget(db, tx, intent.ArticleId, intent.SourceRevision, locking: true, ct);
            RequireRollbackTarget(stage, intent);
            var article = intent.ArticleId;
            var revision = checked(stage.CurrentRevision + 1);
            await using (var update = Store.Sql(db, tx, """
                update public.article set revision=$2,title=$3,body=$4,published_revision=$2,updated_at=clock_timestamp()
                where id=$1 and revision=$5 and not deleted
                """, article, revision, stage.SourceTitle, stage.SourceBody, stage.CurrentRevision))
                if (await update.ExecuteNonQueryAsync(ct) != 1)
                    throw new BusinessException(Rejection.Conflict, "The public article has changed.");
            await using (var addRevision = Store.Sql(db, tx, """
                insert into public.article_revision(article_id,revision,title,body,happened_at)
                values($1,$2,$3,$4,clock_timestamp())
                """, article, revision, stage.SourceTitle, stage.SourceBody))
                await addRevision.ExecuteNonQueryAsync(ct);
            await TaxonomyStore.CarryForward(db, tx, article, intent.SourceRevision, revision, ct);
            await PublicationRightsStore.CarryForward(db, tx, article, intent.SourceRevision, revision, ct);

            var release = await PublicationHistoryStore.ReplaceByAdministrator(db, tx, article, stage.CurrentPublication,
                intent.SourceRevision, revision, stage.CurrentRevision, stage.SourcePublication, stage.SourceResponsibility!.Value,
                admin.Id, intent.IdempotencyKey, fingerprint, intent.Reason, ct);
            await Execute(db, tx, ct, """
                insert into public.blog_outbox(article_id,revision,kind) values($1,$2,'publish')
                """, article, revision);
            invalidatePublic();
            return new AdminArticleRollbackReceipt(article, revision, intent.SourceRevision, stage.CurrentPublication, release.Id,
                release.Number, new DateTimeOffset(release.PublishedAt).ToUnixTimeMilliseconds(), release.RightsSnapshot,
                release.ResponsibilitySnapshot);
        }, ct);

    internal static byte[] ArticleRollbackIntentDigest(AdminArticleRollbackIntent intent) =>
        SHA256.HashData(Wire.EncodeAdminArticleRollbackIntent(intent));

    private sealed record ArticleRollbackTarget(long CurrentRevision, long CurrentPublication, long SourcePublication,
        string SourceTitle, string SourceBody, long? SourceResponsibility, AdminArticleRollbackBlock Blocker);

    private static async Task<ArticleRollbackTarget> ReadRollbackTarget(NpgsqlConnection db, NpgsqlTransaction tx, int article,
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

    private static void RequireRollbackTarget(ArticleRollbackTarget current, AdminArticleRollbackIntent intent)
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
