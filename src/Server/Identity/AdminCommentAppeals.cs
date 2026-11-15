using System.Buffers.Binary;
using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Comments;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminCommentAppeals
{
    internal static void Map(WebApplication app, string origin, AdminPasskeyStore store, string session, string passkeyLimit,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        var actions = new AdminActionRoutes(app, origin, session, readFrame);
        var fenceVisibleMessages = app.Configuration.GetValue(InboxActivityFence.Setting, false);
        app.MapGet(WireRoutes.AdminCommentAppeals, async (HttpContext ctx, CancellationToken ct) =>
            Frame(await store.ReadAppeals(ctx.Request.Cookies[session], ctx.Request.Query, ct))).RequireRateLimiting("command");

        app.MapPost(WireRoutes.AdminAppealStepUpBegin, async (long id, HttpContext ctx, CancellationToken ct) =>
        {
            var frame = await actions.Read(ctx, Wire.CommentAppealFrameBytes, ct);
            return Frame(await store.BeginAppealStepUp(ctx.Request.Cookies[session], id, frame, ct));
        }).RequireRateLimiting(passkeyLimit);

        actions.Post(WireRoutes.AdminAppealStepUpComplete, WireLimits.MaxPasskeyFrameBytes, (cookie, frame, ct) =>
            store.CompleteAppealStepUp(cookie, PasskeyWire.ReadLogin(frame, discoverable: false), ct)).RequireRateLimiting(passkeyLimit);

        app.MapPost(WireRoutes.AdminAppealDecision, async (long id, HttpContext ctx, CancellationToken ct) =>
        {
            var frame = await actions.Read(ctx, Wire.CommentAppealFrameBytes, ct);
            var proof = AdminActionRoutes.Proof(ctx);
            try { return Frame(await store.DecideAppeal(ctx.Request.Cookies[session], id, frame, proof, ct, fenceVisibleMessages)); }
            catch (ModerationProofRequiredException)
            {
                return AdminActionRoutes.ProofRequired(ctx);
            }
        }).RequireRateLimiting("command");
    }

    private static IResult Frame(byte[] frame) => Results.Bytes(frame, Aeds.ContentType);
}

internal sealed partial class AdminPasskeyStore
{
    internal Task<byte[]> ReadAppeals(string? session, IQueryCollection query, CancellationToken ct) =>
        WithLiveAdmin(session, CurrentSchema.CommentModeratePermission, async (db, tx, admin) =>
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
        return BeginStepUp(session, AppealDecisionDigest(id, frame),
            async (db, tx, admin) => { await VerifyAppeal(db, tx, id, admin.Id, ct); }, ct, StepUpAction.ReviewCommentAppeal);
    }

    internal Task<byte[]> CompleteAppealStepUp(string? session, PasskeyLoginRequest request, CancellationToken ct) =>
        CompleteStepUp(session, request, StepUpAction.ReviewCommentAppeal, ct);

    internal Task<byte[]> DecideAppeal(string? session, long id, byte[] frame, string? proof, CancellationToken ct,
        bool fenceVisibleMessages = false)
    {
        var input = Wire.DecodeAdminAppeal(frame);
        var reason = CommentAppeals.Reason(input.Reason);
        return WithLiveAdmin(session, CurrentSchema.CommentModeratePermission, async (db, tx, admin) =>
        {
            var (article, comment, version) = await VerifyAppeal(db, tx, id, admin.Id, ct);
            if (proof is not { Length: 43 } || !proof.All(c => char.IsAsciiLetterOrDigit(c) || c is '-' or '_') ||
                !await ConsumeStepUpProof(db, tx, admin, ChallengeDigest(proof, null), AppealDecisionDigest(id, frame), ct,
                    StepUpAction.ReviewCommentAppeal))
                throw new ModerationProofRequiredException();
            bool granted = input.Decision == "granted";
            bool signedReply = false;
            if (granted)
            {
                await using var update = Store.Sql(db, tx, """
                    update public.comment set moderation_status=1,moderation_version=moderation_version+1
                    where article_id=$1 and id=$2 and moderation_version=$3 and moderation_status=2 and not deleted
                    returning reply_to_id is not null and reply_to_id=parent_id and author_mode=3
                    """, article, comment, version);
                if (await update.ExecuteScalarAsync(ct) is not bool positiveReply) throw AppealChanged();
                signedReply = positiveReply;
            }
            await using var receipt = Store.Sql(db, tx, """
                with receipt as (
                    insert into public.comment_appeal_decision(appeal_id,principal_id,session_reference,granted,reason,decided_at)
                    values($1,$2,$3,$4,$5,clock_timestamp()) on conflict(appeal_id) do nothing returning appeal_id,decided_at
                )
                insert into public.comment_appeal_event(appeal_id,kind,previous_status,next_status,occurred_at)
                select appeal_id,2,2,$6,decided_at from receipt
                """, id, admin.Id, SHA256.HashData(admin.Digest), granted, reason, (short)(granted ? 1 : 2));
            if (await receipt.ExecuteNonQueryAsync(ct) != 1) throw AppealChanged();
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
            if (!await row.ReadAsync(ct)) throw AppealChanged();
            if (reviewer == row.GetGuid(3))
                throw new BusinessException(Rejection.Forbidden, "The original moderator cannot decide this appeal.");
            (article, comment, version) = (row.GetInt32(0), row.GetInt64(1), row.GetInt64(2));
        }
        await using var decided = Store.Sql(db, tx, "select 1 from public.comment_appeal_decision where appeal_id=$1", id);
        if (await decided.ExecuteScalarAsync(ct) is not null) throw AppealChanged();
        return (article, comment, version);
    }

    private static BusinessException AppealChanged() => new(Rejection.Conflict, "The pending appeal or underlying decision changed.");
}
