using System.Security.Cryptography;
using Fido2NetLib;
using Fido2NetLib.Objects;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Administration;

internal sealed partial class AdminPasskeyStore
{
    private enum StepUpAction { ModerateComment = 1, PublishSitePage = 2, PublishArticleRollback = 3, ActivateAppearance = 4,
        ReviewCommentAppeal = 5, ModerateCommentBatch = 6, DraftArticleRollback = 7, ArticleArchive = 8,
        ActivateRootCommentPow = 9 }
    private const short StepUpChallenge = 1;
    private const short StepUpProof = 2;

    internal Task<byte[]> BeginModerationStepUp(string? session, AdminModerationIntent intent, CancellationToken ct) =>
        BeginStepUp(session, IntentDigest(intent), (db, tx, _) => CheckPendingComment(db, tx, intent, locked: false, ct), ct);

    private Task<byte[]> BeginStepUp(string? session, byte[] bodyDigest,
        Func<NpgsqlConnection, NpgsqlTransaction, LiveAdmin, Task> verifyTarget, CancellationToken ct,
        StepUpAction action = StepUpAction.ModerateComment) =>
        WithLiveAdmin(session, StepUpPermission(action), async (db, tx, admin) =>
        {
            await verifyTarget(db, tx, admin);
            await using var query = Store.Sql(db, tx, """
                select credential_id from public.admin_passkey_credential where principal_id=$1
                """, admin.Id);
            var credential = (await query.ExecuteScalarAsync(ct) as byte[]) ?? throw Denied();
            var options = _verifier.GetAssertionOptions(new GetAssertionOptionsParams
            {
                AllowedCredentials = [new PublicKeyCredentialDescriptor(credential)],
                UserVerification = UserVerificationRequirement.Required
            });
            var token = Token();
            await SaveStepUp(db, tx, admin, token, action, StepUpChallenge, bodyDigest, options.ToJson(), 120, ct);
            return PasskeyWire.LoginBegin(token, checked((uint)options.Timeout), options.RpId!, options.Challenge, [credential]);
        }, ct);

    internal Task<byte[]> CompleteModerationStepUp(string? session, PasskeyLoginRequest request, CancellationToken ct) =>
        CompleteStepUp(session, request, StepUpAction.ModerateComment, ct);

    private async Task<byte[]> CompleteStepUp(string? session, PasskeyLoginRequest request,
        StepUpAction action, CancellationToken ct)
    {
        var permission = StepUpPermission(action);
        var articleRollback = action is StepUpAction.PublishArticleRollback or StepUpAction.DraftArticleRollback or StepUpAction.ArticleArchive;
        var rollbackLabel = action switch
        {
            StepUpAction.DraftArticleRollback => "draft rollback",
            StepUpAction.ArticleArchive => "archive transition",
            _ => "published rollback"
        };
        var challenge = await WithLiveAdmin(session, permission, async (db, tx, admin) =>
        {
            if (action == StepUpAction.ReviewCommentAppeal)
                await FsusBlog.V2.Server.Comments.CommentAppeals.RequireSchema(db, tx, ct);
            if (action == StepUpAction.ModerateCommentBatch) await RequireModerationBatchSchema(db, tx, ct);
            if (action == StepUpAction.DraftArticleRollback) await RequireArticleDraftRollbackSchema(db, tx, ct);
            if (action == StepUpAction.ArticleArchive) await RequireArticleArchiveSchema(db, tx, ct);
            await using var consume = Store.Sql(db, tx, $"""
                delete from {StepUpTable(action)}
                where digest=$1 and principal_id=$2 and session_digest=$3 and generation=$4 and kind=$5 and action=$6
                  and expires_at>clock_timestamp()
                returning options,body_digest
                """, ChallengeDigest(request.Token, null), admin.Id, admin.Digest, admin.Snapshot.Generation, StepUpChallenge, (int)action);
            await using var row = await consume.ExecuteReaderAsync(ct);
            if (!await row.ReadAsync(ct))
            {
                if (articleRollback)
                    throw new BusinessException(Rejection.Forbidden, $"The {rollbackLabel} challenge expired or does not match this session.");
                throw Denied();
            }
            return (Options: row.GetString(0), Digest: row.GetFieldValue<byte[]>(1));
        }, ct);
        try
        {
            RequireCredentialId(request.CredentialId, request.RawId);
            if (request.RememberMe) throw Denied();
        }
        catch (BusinessException ex) when (articleRollback && ex.Rejection == Rejection.Unauthorized)
        {
            throw new BusinessException(Rejection.Forbidden, $"The {rollbackLabel} requires a verified administrator Passkey.");
        }

        return await WithLiveAdmin(session, permission, async (db, tx, admin) =>
        {
            await using var user = Store.Sql(db, tx, "select user_handle from public.admin_principal where id=$1", admin.Id);
            var handle = (await user.ExecuteScalarAsync(ct) as byte[]) ?? throw Denied();
            try
            {
                await VerifyCredential(db, tx, admin.Id, handle, request, AssertionOptions.FromJson(challenge.Options), ct,
                    requireHandle: false);
            }
            catch (BusinessException ex) when (articleRollback && ex.Rejection == Rejection.Unauthorized)
            {
                throw new BusinessException(Rejection.Forbidden, $"The {rollbackLabel} requires a verified administrator Passkey.");
            }
            var proof = Token();
            await SaveStepUp(db, tx, admin, proof, action, StepUpProof, challenge.Digest, null, 45, ct);
            return MfaWire.EncodeChallenge(true, "admin-sensitive", proof);
        }, ct);
    }

    // The original intent proof remains separate from the claim-bound HTTP decision.
    internal Task<T> WithModerationProof<T>(string? session, string? proof, AdminModerationIntent intent,
        Func<NpgsqlConnection, NpgsqlTransaction, Guid, Task<T>> apply, CancellationToken ct) =>
        WithLiveAdmin(session, CurrentSchema.CommentModeratePermission, async (db, tx, admin) =>
        {
            if (!await ConsumeStepUpProof(db, tx, admin, ChallengeDigest(proof, null), IntentDigest(intent), ct)) throw Denied();
            await CheckPendingComment(db, tx, intent, locked: true, ct);
            return await apply(db, tx, admin.Id);
        }, ct);

    internal static byte[] IntentDigest(AdminModerationIntent intent) => SHA256.HashData(Wire.EncodeAdminModerationIntent(intent));

    private static async Task<bool> ConsumeStepUpProof(NpgsqlConnection db, NpgsqlTransaction tx, LiveAdmin admin,
        byte[] proofDigest, byte[] bodyDigest, CancellationToken ct, StepUpAction action = StepUpAction.ModerateComment)
    {
        await using var consume = Store.Sql(db, tx, $"""
            delete from {StepUpTable(action)}
            where digest=$1 and principal_id=$2 and session_digest=$3 and generation=$4 and kind=$5 and action=$6
              and body_digest=$7 and expires_at>clock_timestamp()
            """, proofDigest, admin.Id, admin.Digest, admin.Snapshot.Generation, StepUpProof, (int)action, bodyDigest);
        return await consume.ExecuteNonQueryAsync(ct) == 1;
    }

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

    private static Task SaveStepUp(NpgsqlConnection db, NpgsqlTransaction tx, LiveAdmin admin, string token, StepUpAction action, short kind,
        byte[] bodyDigest, string? options, int seconds, CancellationToken ct) =>
        Execute(db, tx, ct, $"""
            insert into {StepUpTable(action)}(digest,principal_id,session_digest,generation,action,body_digest,options,expires_at,kind)
            values($1,$2,$3,$4,$5,$6,$7,clock_timestamp()+$8 * interval '1 second',$9)
            on conflict (session_digest,kind) do update
                set digest=excluded.digest,action=excluded.action,body_digest=excluded.body_digest,
                    options=excluded.options,expires_at=excluded.expires_at
            """, ChallengeDigest(token, null), admin.Id, admin.Digest, admin.Snapshot.Generation, (int)action, bodyDigest,
            Optional(NpgsqlTypes.NpgsqlDbType.Text, options), seconds, kind);

    private static string StepUpTable(StepUpAction action) => action switch
    {
        StepUpAction.ModerateComment => "public.admin_step_up",
        StepUpAction.PublishSitePage => "public.admin_site_page_step_up",
        StepUpAction.PublishArticleRollback or StepUpAction.DraftArticleRollback or StepUpAction.ArticleArchive =>
            "public.admin_article_rollback_step_up",
        StepUpAction.ActivateAppearance => "public.admin_appearance_step_up",
        StepUpAction.ReviewCommentAppeal => "public.comment_appeal_admin_step_up",
        StepUpAction.ModerateCommentBatch => "public.admin_comment_batch_step_up",
        StepUpAction.ActivateRootCommentPow => "public.admin_root_comment_pow_step_up",
        _ => throw new ArgumentOutOfRangeException(nameof(action))
    };

    private static string StepUpPermission(StepUpAction action) => action switch
    {
        StepUpAction.ModerateComment => CurrentSchema.CommentModeratePermission,
        StepUpAction.PublishSitePage => CurrentSchema.SystemConfigPermission,
        StepUpAction.PublishArticleRollback or StepUpAction.DraftArticleRollback or StepUpAction.ArticleArchive =>
            CurrentSchema.ArticleWritePermission,
        StepUpAction.ActivateAppearance => CurrentSchema.SystemConfigPermission,
        StepUpAction.ReviewCommentAppeal => CurrentSchema.CommentModeratePermission,
        StepUpAction.ModerateCommentBatch => CurrentSchema.CommentModeratePermission,
        StepUpAction.ActivateRootCommentPow => CurrentSchema.SystemConfigPermission,
        _ => throw new ArgumentOutOfRangeException(nameof(action))
    };
}
