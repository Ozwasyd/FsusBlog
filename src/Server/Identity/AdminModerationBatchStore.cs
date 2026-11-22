using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Comments;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Administration;

internal sealed class AdminModerationBatchStore(AdminSessionGate gate, AdminStepUpService stepUp)
{
    internal Task<IReadOnlyList<AdminModerationClaim>> AcquireModerationBatch(string? session,
        IReadOnlyList<AdminModerationClaimRequest> targets, CancellationToken ct) =>
        gate.WithLiveAdmin<IReadOnlyList<AdminModerationClaim>>(session, async (db, tx, admin) =>
        {
            await RequireModerationBatchSchema(db, tx, ct);
            var claims = new AdminModerationClaim[targets.Count];
            var conflicts = 0;
            var ordered = targets.Select((target, index) => (target, index))
                .OrderBy(row => row.target.ArticleId).ThenByDescending(row => row.target.CommentId);
            foreach (var (target, index) in ordered)
            {
                try { claims[index] = await AdminModerationStore.AcquireCommentClaim(db, tx, admin, target, ct); }
                catch (BusinessException error) when (error.Rejection == Rejection.Conflict) { conflicts |= 1 << index; }
            }
            if (conflicts != 0) throw new ModerationBatchConflictException(conflicts);
            return claims;
        }, ct);

    internal Task<byte[]> BeginModerationBatchStepUp(string? session, byte[] frame, CancellationToken ct)
    {
        var decision = Wire.DecodeAdminModerationBatchDecision(frame);
        return stepUp.BeginStepUp(session, SHA256.HashData(frame), async (db, tx, admin) =>
        {
            await RequireModerationBatchSchema(db, tx, ct);
            await VerifyModerationBatchClaims(db, tx, admin, decision, ct);
        }, ct, AdminStepUpAction.ModerateCommentBatch);
    }

    internal Task<byte[]> CompleteModerationBatchStepUp(string? session, PasskeyLoginRequest request, CancellationToken ct) =>
        stepUp.CompleteStepUp(session, request, AdminStepUpAction.ModerateCommentBatch, ct, RequireModerationBatchSchema);

    internal Task<AdminModerationBatchReceipt> DecideModerationBatch(string? session, string? proof, byte[] frame,
        bool fenceVisibleMessages, CancellationToken ct)
    {
        var decision = Wire.DecodeAdminModerationBatchDecision(frame);
        return gate.WithLiveAdmin(session, async (db, tx, admin) =>
        {
            await RequireModerationBatchSchema(db, tx, ct);
            if (!await stepUp.ConsumeProofAsync(db, tx, admin, proof, SHA256.HashData(frame), ct,
                    AdminStepUpAction.ModerateCommentBatch))
                throw new ModerationProofRequiredException();
            var ordered = await VerifyModerationBatchClaims(db, tx, admin, decision, ct);
            var status = checked((short)decision.Decision);
            await using var summary = Store.Sql(db, tx, """
                insert into public.admin_comment_batch(principal_id,session_reference,decision,item_count,decided_at)
                values($1,$2,$3,$4,clock_timestamp()) returning id
                """, admin.Id, SHA256.HashData(admin.Digest), status, decision.Rows.Count);
            var batch = (long)(await summary.ExecuteScalarAsync(ct))!;
            var audits = new List<long>(ordered.Length);
            var approved = new List<AdminModerationStore.ClaimCoordinates>();
            foreach (var (row, index) in ordered)
            {
                var claim = Receipt(row);
                try
                {
                    var (audit, notice) = await AdminModerationStore.ApplyCommentDecision(db, tx, admin, claim, status, decision.Reason, ct);
                    audits.Add(audit);
                    if (notice) approved.Add(claim);
                }
                catch (BusinessException error) when (error.Rejection == Rejection.Conflict)
                { throw new ModerationBatchConflictException(1 << index); }
            }
            await SqlCommands.Execute(db, tx, ct, """
                insert into public.admin_comment_batch_item(batch_id,moderation_id)
                select $1, audit_id from unnest($2::bigint[]) as audit_id
                """, batch, audits.ToArray());
            if (approved.Count > 0 && await CurrentSchema.HasCommentReplySchemaAsync(db, tx, ct))
                await DeliverModerationBatchNotices(db, tx, approved, fenceVisibleMessages, ct);
            return new AdminModerationBatchReceipt(batch, ordered.Length);
        }, ct);
    }

    private static async Task<(AdminModerationBatchItem Row, int Index)[]> VerifyModerationBatchClaims(NpgsqlConnection db,
        NpgsqlTransaction tx, AdminLiveSession admin, AdminModerationBatchDecision decision, CancellationToken ct)
    {
        var ordered = decision.Rows.Select((row, index) => (Row: row, Index: index))
            .OrderBy(target => target.Row.ArticleId).ThenByDescending(target => target.Row.CommentId).ToArray();
        var conflicts = 0;
        foreach (var (row, index) in ordered)
        {
            try
            {
                await AdminModerationStore.CheckClaim(db, tx, admin, Receipt(row), ct);
                if (decision.Decision == 1)
                {
                    await using var mask = Store.Sql(db, tx, """
                        select 1 from public.comment_blocked_region where article_id=$1 and comment_id=$2 limit 1
                        """, row.ArticleId, row.CommentId);
                    if (await mask.ExecuteScalarAsync(ct) is not null) conflicts |= 1 << index;
                }
            }
            catch (BusinessException error) when (error.Rejection == Rejection.Conflict) { conflicts |= 1 << index; }
        }
        if (conflicts != 0) throw new ModerationBatchConflictException(conflicts);
        return ordered;
    }

    private static AdminModerationStore.ClaimCoordinates Receipt(AdminModerationBatchItem row) =>
        new(row.ArticleId, row.CommentId, row.CommentVersion, row.ClaimToken, row.ClaimGeneration, row.ClaimVersion);

    private static async Task DeliverModerationBatchNotices(NpgsqlConnection db, NpgsqlTransaction tx,
        IReadOnlyList<AdminModerationStore.ClaimCoordinates> approved, bool fenceVisibleMessages, CancellationToken ct)
    {
        var notices = new List<CommentReplies.ApprovedNotice>(approved.Count);
        foreach (var row in approved)
        {
            var notice = await CommentReplies.FindApprovedNotice(db, tx, row.ArticleId, row.CommentId, ct);
            if (notice is not null) notices.Add(notice);
        }
        // Inbox writes lock the recipient's delivery head until commit. Every batch takes the same account order.
        foreach (var notice in notices.OrderBy(n => n.Recipient).ThenBy(n => n.Article).ThenBy(n => n.Reply))
            await CommentReplies.DeliverNotice(db, tx, notice, fenceVisibleMessages, ct);
    }

    private static async Task RequireModerationBatchSchema(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        if (!await CurrentSchema.HasAdminCommentBatchSchemaAsync(db, tx, ct))
            throw new BusinessException(Rejection.NotFound, "Batch moderation is unavailable.");
    }
}

internal sealed class ModerationBatchConflictException(int positions) : Exception
{
    internal int Positions { get; } = positions;
}
