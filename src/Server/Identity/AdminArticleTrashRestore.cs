using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Authoring;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminArticleTrashRestore
{
    internal static void Map(WebApplication app, Uri origin, AdminPasskeyStore store, string session, string limit,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        var routes = new AdminActionRoutes(app, origin.GetLeftPart(UriPartial.Authority), session, readFrame);
        routes.Availability(WireRoutes.AdminArticleTrashRestoreAvailability, store.CheckTrashRestoreAvailability);
        routes.Complete(WireRoutes.AdminArticleTrashRestoreComplete, limit, store.CompleteTrashRestoreStepUp);
        app.MapPost(WireRoutes.AdminArticleTrashRestoreBegin, async (HttpContext ctx, CancellationToken ct) =>
            AdminActionRoutes.Frame(await store.BeginTrashRestoreStepUp(ctx.Request.Cookies[session], await Intent(ctx, ct), ct)))
            .RequireRateLimiting(limit);
        app.MapPost(WireRoutes.AdminArticleTrashRestoreExecute, async (HttpContext ctx, CancellationToken ct) =>
        {
            var result = await store.RestoreFromTrash(ctx.Request.Cookies[session], AdminActionRoutes.Proof(ctx), await Intent(ctx, ct), ct);
            return AdminActionRoutes.Frame(Wire.EncodeAdminArticleTrashRestoreReceipt(result));
        }).RequireRateLimiting("command");

        async Task<AdminArticleTrashRestoreIntent> Intent(HttpContext ctx, CancellationToken ct)
        {
            var intent = Wire.DecodeAdminArticleTrashRestoreIntent(await routes.Read(ctx, WireLimits.AdminArticleTrashRestoreIntentFrameBytes, ct));
            ClientMutationHeader.Require(ctx, intent.IdempotencyKey, required: true);
            return intent;
        }
    }
}

internal sealed partial class AdminPasskeyStore
{
    private const string TrashArticle = $"""
        from public.article a where a.id=$1 and a.deleted and a.published_revision is null
            and not exists(select from public.article_publication p where p.article_id=a.id)
            and {ArchivedArticleAuthority.Available}
        """;

    internal Task CheckTrashRestoreAvailability(string? session, CancellationToken ct) =>
        WithLiveAdmin(session, CurrentSchema.ArticleWritePermission, async (db, tx, _) =>
        {
            await RequireTrashRestoreSchema(db, tx, ct);
            return true;
        }, ct);

    internal Task<byte[]> BeginTrashRestoreStepUp(string? session, AdminArticleTrashRestoreIntent intent, CancellationToken ct) =>
        BeginStepUp(session, TrashRestoreFingerprint(intent), async (db, tx, _) =>
        {
            await RequireTrashRestoreSchema(db, tx, ct);
            await using var query = Store.Sql(db, tx, $"select a.revision {TrashArticle}", intent.ArticleId);
            if (await query.ExecuteScalarAsync(ct) is not long revision || revision != intent.ExpectedRevision)
                throw TrashRestoreConflict();
        }, ct, StepUpAction.RestoreArticleTrash);

    internal Task<byte[]> CompleteTrashRestoreStepUp(string? session, PasskeyLoginRequest request, CancellationToken ct) =>
        CompleteStepUp(session, request, StepUpAction.RestoreArticleTrash, ct);

    internal Task<AdminArticleTrashRestoreReceipt> RestoreFromTrash(string? session, string? proof, AdminArticleTrashRestoreIntent intent,
        CancellationToken ct) => WithLiveAdmin(session, CurrentSchema.ArticleWritePermission, async (db, tx, admin) =>
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
        if (proof is not { Length: 43 } || !proof.All(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_') ||
            !await ConsumeStepUpProof(db, tx, admin, ChallengeDigest(proof, null), fingerprint, ct, StepUpAction.RestoreArticleTrash))
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
        await Execute(db, tx, ct, """
            insert into public.admin_article_trash_restore(principal_id,command_id,fingerprint,article_id,previous_revision,revision)
            values($1,$2,$3,$4,$5,$6)
            """, admin.Id, intent.IdempotencyKey, fingerprint, draft.Id, intent.ExpectedRevision, draft.Revision);
        return new AdminArticleTrashRestoreReceipt(draft.Id, draft.Revision);
    }, ct);

    private static async Task RequireTrashRestoreSchema(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        if (!await CurrentSchema.HasAdminArticleTrashRestoreAsync(db, tx, ct))
            throw new BusinessException(Rejection.NotFound, "Administrator trash restoration is unavailable.");
    }

    private static byte[] TrashRestoreFingerprint(AdminArticleTrashRestoreIntent intent) => SHA256.HashData(Wire.EncodeAdminArticleTrashRestoreIntent(intent));
    private static BusinessException TrashRestoreConflict() => new(Rejection.Conflict, "The deleted article revision changed. Reload the trash.");
}
