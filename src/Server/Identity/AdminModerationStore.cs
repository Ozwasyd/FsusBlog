using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Comments;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Administration;

internal sealed class AdminModerationStore(AdminSessionGate gate, AdminStepUpService stepUp)
{
    private const short ClaimActive = 1;
    private const short ClaimReleased = 2;
    private const short ClaimCompleted = 3;

    internal Task<AdminModerationClaim> AcquireCommentClaim(string? session, AdminModerationClaimRequest target,
        CancellationToken ct) =>
        gate.WithLiveAdmin(session,
            (db, tx, admin) => AcquireCommentClaim(db, tx, admin, target, ct), ct);

    internal static async Task<AdminModerationClaim> AcquireCommentClaim(NpgsqlConnection db, NpgsqlTransaction tx,
        AdminLiveSession admin, AdminModerationClaimRequest target, CancellationToken ct)
    {
        var version = await LockPendingComment(db, tx, target.ArticleId, target.CommentId, ct);
        var token = AdminSql.Token();
        await using var cmd = Store.Sql(db, tx, """
            insert into public.admin_comment_claim as claim
                (article_id,comment_id,principal_id,session_digest,admin_generation,claim_digest,
                 claim_generation,claim_version,claimed_comment_version,expires_at,state)
            values($1,$2,$3,$4,$5,$6,1,1,$7,clock_timestamp()+interval '2 minutes',$8)
            on conflict(article_id,comment_id) do update set
                principal_id=excluded.principal_id,session_digest=excluded.session_digest,
                admin_generation=excluded.admin_generation,claim_digest=excluded.claim_digest,
                claim_generation=claim.claim_generation+1,claim_version=claim.claim_version+1,
                claimed_comment_version=excluded.claimed_comment_version,
                expires_at=clock_timestamp()+interval '2 minutes',state=excluded.state
            where claim.state<>$8 or claim.expires_at<=clock_timestamp()
                or claim.claimed_comment_version<>excluded.claimed_comment_version
                or not exists (
                    select from public.admin_principal p join public.admin_session s on s.principal_id=p.id
                    where p.id=claim.principal_id and p.enabled and p.generation=claim.admin_generation
                        and s.digest=claim.session_digest and s.generation=p.generation and s.expires_at>clock_timestamp()
                        and exists (select from public.admin_passkey_credential where principal_id=p.id)
                )
            returning claim_generation,claim_version,expires_at
            """, target.ArticleId, target.CommentId, admin.Id, admin.Digest, admin.Snapshot.Generation,
            ClaimDigest(token), version, ClaimActive);
        await using var row = await cmd.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct)) throw new BusinessException(Rejection.Conflict, "The pending comment is already claimed.");
        return new AdminModerationClaim(target.ArticleId, target.CommentId, version, token, row.GetInt64(0),
            row.GetInt64(1), row.GetFieldValue<DateTimeOffset>(2).ToUnixTimeMilliseconds());
    }

    internal Task<AdminModerationClaim> RenewCommentClaim(string? session, AdminModerationClaim claim, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, admin) =>
        {
            await CheckClaim(db, tx, admin, Receipt(claim), ct);
            await using var cmd = Store.Sql(db, tx, """
                update public.admin_comment_claim set claim_version=claim_version+1,
                    expires_at=clock_timestamp()+interval '2 minutes'
                where article_id=$1 and comment_id=$2 and expires_at>clock_timestamp()
                returning claim_version, expires_at
                """, claim.ArticleId, claim.CommentId);
            await using var row = await cmd.ExecuteReaderAsync(ct);
            if (!await row.ReadAsync(ct)) throw ModerationChanged();
            return claim with { ClaimVersion = row.GetInt64(0), ExpiresAt = row.GetFieldValue<DateTimeOffset>(1).ToUnixTimeMilliseconds() };
        }, ct);

    internal Task ReleaseCommentClaim(string? session, AdminModerationClaim claim, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, admin) =>
        {
            await CheckClaim(db, tx, admin, Receipt(claim), ct);
            await CloseClaim(db, tx, claim.ArticleId, claim.CommentId, ClaimReleased, ct);
            return true;
        }, ct);

    internal Task<byte[]> BeginModerationDecisionStepUp(string? session, AdminModerationDecision decision, CancellationToken ct) =>
        stepUp.BeginStepUp(session, DecisionDigest(decision), (db, tx, admin) => CheckClaim(db, tx, admin, Receipt(decision), ct), ct);

    internal Task DecideComment(string? session, string? proof, AdminModerationDecision decision, CancellationToken ct,
        bool fenceVisibleMessages = false) =>
        gate.WithLiveAdmin(session, async (db, tx, admin) =>
        {
            if (!await stepUp.ConsumeProofAsync(db, tx, admin, proof, DecisionDigest(decision), ct))
                throw new ModerationProofRequiredException();
            await CheckClaim(db, tx, admin, Receipt(decision), ct);
            var status = checked((short)decision.Decision);
            var (_, notice) = await ApplyCommentDecision(db, tx, admin, Receipt(decision), status, decision.Reason, ct);
            if (notice)
                await CommentReplies.DeliverApproved(db, tx, decision.ArticleId, decision.CommentId, fenceVisibleMessages, ct);
            return true;
        }, ct);

    internal static async Task<(long AuditId, bool Notice)> ApplyCommentDecision(NpgsqlConnection db, NpgsqlTransaction tx,
        AdminLiveSession admin, ClaimCoordinates claim, short status, string reason, CancellationToken ct)
    {
        await using var update = Store.Sql(db, tx, """
            update public.comment set moderation_status=$4, moderation_version=moderation_version+1
            where article_id=$1 and id=$2 and moderation_version=$3 and moderation_status=0 and not deleted
            returning reply_to_id is not null and reply_to_id=parent_id and author_mode=3
            """, claim.ArticleId, claim.CommentId, claim.CommentVersion, status);
        if (await update.ExecuteScalarAsync(ct) is not bool signedReply) throw ModerationChanged();
        await CloseClaim(db, tx, claim.ArticleId, claim.CommentId, ClaimCompleted, ct);
        await using var audit = Store.Sql(db, tx, """
            insert into public.admin_comment_moderation
                (article_id,comment_id,principal_id,previous_status,next_status,reason,happened_at,comment_version)
            values($1,$2,$3,0,$4,$5,clock_timestamp(),$6)
            returning id
            """, claim.ArticleId, claim.CommentId, admin.Id, status, reason, claim.CommentVersion);
        return ((long)(await audit.ExecuteScalarAsync(ct))!, status == 1 && signedReply);
    }

    internal sealed record ClaimCoordinates(int ArticleId, long CommentId, long CommentVersion, string Token, long Generation, long Version);

    internal static ClaimCoordinates Receipt(AdminModerationClaim claim) =>
        new(claim.ArticleId, claim.CommentId, claim.CommentVersion, claim.ClaimToken, claim.ClaimGeneration, claim.ClaimVersion);

    internal static ClaimCoordinates Receipt(AdminModerationDecision decision) =>
        new(decision.ArticleId, decision.CommentId, decision.CommentVersion, decision.ClaimToken, decision.ClaimGeneration, decision.ClaimVersion);

    internal static byte[] DecisionDigest(AdminModerationDecision decision) =>
        SHA256.HashData(Wire.EncodeAdminModerationDecision(decision));

    private static byte[] ClaimDigest(string token) => AdminSql.ChallengeDigest(token, null);

    private static async Task<long> LockPendingComment(NpgsqlConnection db, NpgsqlTransaction tx, int article, long comment,
        CancellationToken ct)
    {
        await using var cmd = Store.Sql(db, tx, """
            select c.moderation_version from public.comment c join public.article a on a.id=c.article_id
            join public.comment_submit_command s on s.article_id=c.article_id and s.comment_id=c.id
            where c.article_id=$1 and c.id=$2 and c.moderation_status=0 and not c.deleted and not a.deleted
            for update of c for share of a,s
            """, article, comment);
        return (await cmd.ExecuteScalarAsync(ct) as long?) ?? throw ModerationChanged();
    }

    internal static async Task CheckClaim(NpgsqlConnection db, NpgsqlTransaction tx, AdminLiveSession admin, ClaimCoordinates claim,
        CancellationToken ct)
    {
        if (await LockPendingComment(db, tx, claim.ArticleId, claim.CommentId, ct) != claim.CommentVersion)
            throw ModerationChanged();
        await using var cmd = Store.Sql(db, tx, """
            select 1 from public.admin_comment_claim
            where article_id=$1 and comment_id=$2 and claim_digest=$3 and principal_id=$4 and session_digest=$5
                and admin_generation=$6 and claim_generation=$7 and claim_version=$8
                and claimed_comment_version=$9 and state=$10 and expires_at>clock_timestamp()
            for update
            """, claim.ArticleId, claim.CommentId, ClaimDigest(claim.Token), admin.Id, admin.Digest, admin.Snapshot.Generation,
            claim.Generation, claim.Version, claim.CommentVersion, ClaimActive);
        if (await cmd.ExecuteScalarAsync(ct) is null) throw ModerationChanged();
    }

    private static async Task CloseClaim(NpgsqlConnection db, NpgsqlTransaction tx, int article, long comment, short state,
        CancellationToken ct)
    {
        await using var cmd = Store.Sql(db, tx, """
            update public.admin_comment_claim set state=$3, claim_version=claim_version+1
            where article_id=$1 and comment_id=$2 and expires_at>clock_timestamp()
            """, article, comment, state);
        if (await cmd.ExecuteNonQueryAsync(ct) != 1) throw ModerationChanged();
    }

    private static BusinessException ModerationChanged() =>
        new(Rejection.Conflict, "The pending comment or claim changed.");
}

internal sealed class ModerationProofRequiredException : Exception;
