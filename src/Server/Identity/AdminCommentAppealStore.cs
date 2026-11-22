using System.Buffers.Binary;
using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Comments;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Administration;

internal sealed class AdminCommentAppealStore(AdminSessionGate gate, AdminStepUpService stepUp)
{
    internal Task<byte[]> ReadAppeals(string? session, IQueryCollection query, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, admin) =>
        {
            await CommentAppeals.RequireSchema(db, tx, ct);
            await using var select = Store.Sql(db, tx, $"""
                select a.id,c.article_id,c.id,c.body,a.reason
                from public.comment_appeal a join public.comment c on c.article_id=a.article_id and c.id=a.comment_id
                {CommentAppeals.Adverse}
                where adverse.id=a.adverse_id and a.comment_version=c.moderation_version and not c.deleted
                    and ($1=0 or a.id<$1) and adverse.principal_id<>$2
                    and not exists (select 1 from public.comment_appeal_decision d where d.appeal_id=a.id)
                order by a.id desc limit $3
                """, CommentAppeals.Before(query), admin.Id, Wire.CommentAppealPageSize + 1);
            await using var row = await select.ExecuteReaderAsync(ct);
            List<AdminAppealRow> rows = [];
            while (await row.ReadAsync(ct))
            {
                if (rows.Count == Wire.CommentAppealPageSize) return Wire.EncodeAdminCommentAppeals(rows, true);
                rows.Add(new(row.GetInt64(0), row.GetInt32(1), row.GetInt64(2), row.GetString(3), row.GetString(4)));
            }
            return Wire.EncodeAdminCommentAppeals(rows, false);
        }, ct);

    internal Task<byte[]> BeginAppealStepUp(string? session, long id, byte[] frame, CancellationToken ct)
    {
        CommentAppeals.Reason(Wire.DecodeAdminAppeal(frame).Reason);
        return stepUp.BeginStepUp(session, AppealDecisionDigest(id, frame),
            async (db, tx, admin) => { await VerifyAppeal(db, tx, id, admin.Id, ct); }, ct, AdminStepUpAction.ReviewCommentAppeal);
    }

    internal Task<byte[]> CompleteAppealStepUp(string? session, PasskeyLoginRequest request, CancellationToken ct) =>
        stepUp.CompleteStepUp(session, request, AdminStepUpAction.ReviewCommentAppeal, ct, CommentAppeals.RequireSchema);

    internal Task<byte[]> DecideAppeal(string? session, long id, byte[] frame, string? proof, CancellationToken ct,
        bool fenceVisibleMessages = false)
    {
        var input = Wire.DecodeAdminAppeal(frame);
        var reason = CommentAppeals.Reason(input.Reason);
        return gate.WithLiveAdmin(session, async (db, tx, admin) =>
        {
            var (article, comment, version) = await VerifyAppeal(db, tx, id, admin.Id, ct);
            if (!await stepUp.ConsumeProofAsync(db, tx, admin, proof, AppealDecisionDigest(id, frame), ct,
                    AdminStepUpAction.ReviewCommentAppeal))
                throw new ModerationProofRequiredException();
            bool granted = input.Decision == "granted";
            bool signedReply = false;
            if (granted)
            {
                if (await SqlCommands.Scalar(db, tx, ct, """
                    update public.comment set moderation_status=1,moderation_version=moderation_version+1
                    where article_id=$1 and id=$2 and moderation_version=$3 and moderation_status=2 and not deleted
                    returning reply_to_id is not null and reply_to_id=parent_id and author_mode=3
                    """, article, comment, version) is not bool positiveReply) throw AppealChanged();
                signedReply = positiveReply;
            }
            if (await SqlCommands.Execute(db, tx, ct, """
                with receipt as (
                    insert into public.comment_appeal_decision(appeal_id,principal_id,session_reference,granted,reason,decided_at)
                    values($1,$2,$3,$4,$5,clock_timestamp()) on conflict(appeal_id) do nothing returning appeal_id,decided_at
                )
                insert into public.comment_appeal_event(appeal_id,kind,previous_status,next_status,occurred_at)
                select appeal_id,2,2,$6,decided_at from receipt
                """, id, admin.Id, SHA256.HashData(admin.Digest), granted, reason, (short)(granted ? 1 : 2)) != 1) throw AppealChanged();
            if (signedReply) await CommentReplies.DeliverApproved(db, tx, article, comment, fenceVisibleMessages, ct);
            return Wire.EncodeAdminAppealResult(id);
        }, ct);
    }

    internal static byte[] AppealDecisionDigest(long id, byte[] frame)
    {
        Span<byte> coordinate = stackalloc byte[8];
        BinaryPrimitives.WriteInt64LittleEndian(coordinate, id);
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData("FsusBlog v2 independent appeal review"u8);
        hash.AppendData(coordinate);
        hash.AppendData(frame);
        return hash.GetHashAndReset();
    }

    private static async Task<(int Article, long Comment, long Version)> VerifyAppeal(NpgsqlConnection db, NpgsqlTransaction tx,
        long id, Guid reviewer, CancellationToken ct)
    {
        await CommentAppeals.RequireSchema(db, tx, ct);
        if (id <= 0) throw AppealChanged();
        await using var select = Store.Sql(db, tx, $"""
            select c.article_id,c.id,c.moderation_version,adverse.principal_id
            from public.comment_appeal a join public.comment c on c.article_id=a.article_id and c.id=a.comment_id
            {CommentAppeals.Adverse}
            where a.id=$1 and adverse.id=a.adverse_id and a.comment_version=c.moderation_version and not c.deleted
            for update of c
            """, id);
        int article;
        long comment, version;
        await using (var row = await select.ExecuteReaderAsync(ct))
        {
            await row.ReadRequired(ct, AppealChanged);
            if (reviewer == row.GetGuid(3))
                throw new BusinessException(Rejection.Forbidden, "The original moderator cannot decide this appeal.");
            (article, comment, version) = (row.GetInt32(0), row.GetInt64(1), row.GetInt64(2));
        }
        if (await SqlCommands.Scalar(db, tx, ct,
            "select 1 from public.comment_appeal_decision where appeal_id=$1", id) is not null) throw AppealChanged();
        return (article, comment, version);
    }

    private static BusinessException AppealChanged() => new(Rejection.Conflict, "The pending appeal or underlying decision changed.");
}
