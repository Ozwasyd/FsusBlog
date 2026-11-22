using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Administration;

internal enum AdminStepUpAction
{
    ModerateComment = 1,
    PublishSitePage = 2,
    PublishArticleRollback = 3,
    ActivateAppearance = 4,
    ReviewCommentAppeal = 5,
    ModerateCommentBatch = 6,
    DraftArticleRollback = 7,
    ArticleArchive = 8,
    ActivateRootCommentPow = 9,
    RestoreArticleTrash = 10,
    RestoreDeletedPublication = 11,
    ChangeReaderStatus = 12,
    UpdateSiteConfig = 13
}

// Manages administrator Step-Up challenges and single-use proof consumption inside the live session transaction.
internal sealed class AdminStepUpService(AdminSessionGate gate, AdminPasskeyStore? passkeys = null)
{
    private const short StepUpChallenge = 1;
    private const short StepUpProof = 2;

    internal Task<byte[]> BeginModerationStepUp(string? session, AdminModerationIntent intent, CancellationToken ct) =>
        BeginStepUp(session, IntentDigest(intent), (db, tx, _) => CheckPendingComment(db, tx, intent, locked: false, ct), ct);

    internal Task<byte[]> BeginStepUp(string? session, byte[] bodyDigest,
        Func<NpgsqlConnection, NpgsqlTransaction, AdminLiveSession, Task> verifyTarget, CancellationToken ct,
        AdminStepUpAction action = AdminStepUpAction.ModerateComment)
    {
        var verifier = RequirePasskeys();
        return gate.WithLiveAdmin(session, async (db, tx, admin) =>
        {
            await verifyTarget(db, tx, admin);
            await using var query = Store.Sql(db, tx, """
                select credential_id from public.admin_passkey_credential where principal_id=$1
                """, admin.Id);
            var credential = (await query.ExecuteScalarAsync(ct) as byte[]) ?? throw AdminSessionGate.Denied();
            var token = AdminSql.Token();
            var (frame, optionsJson) = verifier.CreateStepUpChallenge(token, credential);
            await SaveStepUp(db, tx, admin, token, action, StepUpChallenge, bodyDigest, optionsJson, 120, ct);
            return frame;
        }, ct);
    }

    internal Task<byte[]> CompleteModerationStepUp(string? session, PasskeyLoginRequest request, CancellationToken ct) =>
        CompleteStepUp(session, request, AdminStepUpAction.ModerateComment, ct);

    internal async Task<byte[]> CompleteStepUp(string? session, PasskeyLoginRequest request, AdminStepUpAction action, CancellationToken ct,
        Func<NpgsqlConnection, NpgsqlTransaction, CancellationToken, Task>? requireSchema = null)
    {
        var verifier = RequirePasskeys();
        var articleTransition = action is AdminStepUpAction.PublishArticleRollback or AdminStepUpAction.DraftArticleRollback or
            AdminStepUpAction.ArticleArchive or AdminStepUpAction.RestoreArticleTrash or AdminStepUpAction.RestoreDeletedPublication;
        var transition = action switch
        {
            AdminStepUpAction.DraftArticleRollback => "draft rollback",
            AdminStepUpAction.ArticleArchive => "archive transition",
            AdminStepUpAction.RestoreArticleTrash => "trash restore",
            AdminStepUpAction.RestoreDeletedPublication => "former publication restore",
            _ => "published rollback"
        };
        var challenge = await gate.WithLiveAdmin(session, async (db, tx, admin) =>
        {
            if (requireSchema is not null) await requireSchema(db, tx, ct);
            await using var consume = Store.Sql(db, tx, $"""
                delete from {StepUpTable(action)}
                where digest=$1 and principal_id=$2 and session_digest=$3 and generation=$4 and kind=$5 and action=$6
                  and expires_at>clock_timestamp()
                returning options,body_digest
                """, AdminSql.ChallengeDigest(request.Token, null), admin.Id, admin.Digest, admin.Snapshot.Generation, StepUpChallenge, (int)action);
            await using var row = await consume.ExecuteReaderAsync(ct);
            if (!await row.ReadAsync(ct))
            {
                if (articleTransition)
                    throw new BusinessException(Rejection.Forbidden, $"The {transition} challenge expired or does not match this session.");
                throw AdminSessionGate.Denied();
            }
            return (Options: row.GetString(0), Digest: row.GetFieldValue<byte[]>(1));
        }, ct);
        try
        {
            AdminSql.RequireCredentialId(request.CredentialId, request.RawId);
            if (request.RememberMe) throw AdminSessionGate.Denied();
        }
        catch (BusinessException ex) when (articleTransition && ex.Rejection == Rejection.Unauthorized)
        {
            throw new BusinessException(Rejection.Forbidden, $"The {transition} requires a verified administrator Passkey.");
        }

        return await gate.WithLiveAdmin(session, async (db, tx, admin) =>
        {
            await using var user = Store.Sql(db, tx, "select user_handle from public.admin_principal where id=$1", admin.Id);
            var handle = (await user.ExecuteScalarAsync(ct) as byte[]) ?? throw AdminSessionGate.Denied();
            try
            {
                await verifier.VerifyStepUpAssertion(db, tx, admin.Id, handle, request, challenge.Options, ct);
            }
            catch (BusinessException ex) when (articleTransition && ex.Rejection == Rejection.Unauthorized)
            {
                throw new BusinessException(Rejection.Forbidden, $"The {transition} requires a verified administrator Passkey.");
            }
            var proof = AdminSql.Token();
            await SaveStepUp(db, tx, admin, proof, action, StepUpProof, challenge.Digest, null, 45, ct);
            return MfaWire.EncodeChallenge(true, "admin-sensitive", proof);
        }, ct);
    }

    // The original intent proof remains separate from the claim-bound HTTP decision.
    internal Task<T> WithModerationProof<T>(string? session, string? proof, AdminModerationIntent intent,
        Func<NpgsqlConnection, NpgsqlTransaction, Guid, Task<T>> apply, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, admin) =>
        {
            if (!await ConsumeProofAsync(db, tx, admin, proof, IntentDigest(intent), ct)) throw AdminSessionGate.Denied();
            await CheckPendingComment(db, tx, intent, locked: true, ct);
            return await apply(db, tx, admin.Id);
        }, ct);

    internal static byte[] IntentDigest(AdminModerationIntent intent) => SHA256.HashData(Wire.EncodeAdminModerationIntent(intent));

    internal async Task<bool> ConsumeProofAsync(NpgsqlConnection db, NpgsqlTransaction tx, AdminLiveSession admin,
        string? proof, byte[] bodyDigest, CancellationToken ct, AdminStepUpAction action = AdminStepUpAction.ModerateComment)
    {
        if (!AdminSql.TryChallengeDigest(proof, out var proofDigest)) return false;
        await using var consume = Store.Sql(db, tx, $"""
            delete from {StepUpTable(action)}
            where digest=$1 and principal_id=$2 and session_digest=$3 and generation=$4 and kind=$5 and action=$6
              and body_digest=$7 and expires_at>clock_timestamp()
            """, proofDigest, admin.Id, admin.Digest, admin.Snapshot.Generation, StepUpProof, (int)action, bodyDigest);
        return await consume.ExecuteNonQueryAsync(ct) == 1;
    }

    private AdminPasskeyStore RequirePasskeys() =>
        passkeys ?? throw new InvalidOperationException("Administrator Passkey verification is not configured.");

    private static async Task CheckPendingComment(NpgsqlConnection db, NpgsqlTransaction tx, AdminModerationIntent intent,
        bool locked, CancellationToken ct)
    {
        await using var query = Store.Sql(db, tx, """
            select 1 from public.comment c join public.article a on a.id=c.article_id
            join public.comment_submit_command s on s.article_id=c.article_id and s.comment_id=c.id
            where c.article_id=$1 and c.id=$2 and c.moderation_status=0 and not c.deleted and not a.deleted
            """ + (locked ? " for update of c for share of a,s" : ""), intent.ArticleId, intent.CommentId);
        if (await query.ExecuteScalarAsync(ct) is null)
            throw new BusinessException(Rejection.NotFound, "The pending comment is no longer available.");
    }

    private static Task SaveStepUp(NpgsqlConnection db, NpgsqlTransaction tx, AdminLiveSession admin, string token,
        AdminStepUpAction action, short kind, byte[] bodyDigest, string? options, int seconds, CancellationToken ct) =>
        AdminSql.Execute(db, tx, ct, $"""
            insert into {StepUpTable(action)}(digest,principal_id,session_digest,generation,action,body_digest,options,expires_at,kind)
            values($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+$8 * interval '1 second',$9)
            on conflict (session_digest,kind) do update
                set digest=excluded.digest,action=excluded.action,body_digest=excluded.body_digest,
                    options=excluded.options,expires_at=excluded.expires_at
            """, AdminSql.ChallengeDigest(token, null), admin.Id, admin.Digest, admin.Snapshot.Generation, (int)action, bodyDigest,
            AdminSql.Optional(NpgsqlTypes.NpgsqlDbType.Text, options), seconds, kind);

    private static string StepUpTable(AdminStepUpAction action) => action switch
    {
        AdminStepUpAction.ModerateComment => "public.admin_step_up",
        AdminStepUpAction.PublishSitePage => "public.admin_site_page_step_up",
        AdminStepUpAction.PublishArticleRollback or AdminStepUpAction.DraftArticleRollback or AdminStepUpAction.ArticleArchive or AdminStepUpAction.RestoreDeletedPublication =>
            "public.admin_article_rollback_step_up",
        AdminStepUpAction.ActivateAppearance => "public.admin_appearance_step_up",
        AdminStepUpAction.ReviewCommentAppeal => "public.comment_appeal_admin_step_up",
        AdminStepUpAction.ModerateCommentBatch => "public.admin_comment_batch_step_up",
        AdminStepUpAction.ActivateRootCommentPow => "public.admin_root_comment_pow_step_up",
        AdminStepUpAction.RestoreArticleTrash => "public.admin_article_trash_step_up",
        AdminStepUpAction.ChangeReaderStatus => "public.admin_reader_governance_step_up",
        AdminStepUpAction.UpdateSiteConfig => "public.admin_site_config_step_up",
        _ => throw new ArgumentOutOfRangeException(nameof(action))
    };
}
