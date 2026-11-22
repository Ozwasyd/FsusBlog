using FsusBlog.V2.Contracts;
using static FsusBlog.V2.Server.Administration.AdminActionRoutes;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminCommentAppeals
{
    internal static void Map(AdminActionRoutes actions, AdminCommentAppealStore store, bool fenceVisibleMessages)
    {
        actions.App.MapCommandGet(WireRoutes.AdminCommentAppeals, async (HttpContext ctx, CancellationToken ct) =>
            Frame(await store.ReadAppeals(actions.Session(ctx), ctx.Request.Query, ct)));

        actions.App.MapPost(WireRoutes.AdminAppealStepUpBegin, async (long id, HttpContext ctx, CancellationToken ct) =>
        {
            var frame = await actions.Read(ctx, Wire.CommentAppealFrameBytes, ct);
            return Frame(await store.BeginAppealStepUp(actions.Session(ctx), id, frame, ct));
        }).RequireRateLimiting(actions.PasskeyLimit);

        actions.Post(WireRoutes.AdminAppealStepUpComplete, WireLimits.MaxPasskeyFrameBytes, (cookie, frame, ct) =>
            store.CompleteAppealStepUp(cookie, PasskeyWire.ReadLogin(frame, discoverable: false), ct)).RequireRateLimiting(actions.PasskeyLimit);

        actions.App.MapCommandPost(WireRoutes.AdminAppealDecision, async (long id, HttpContext ctx, CancellationToken ct) =>
        {
            var frame = await actions.Read(ctx, Wire.CommentAppealFrameBytes, ct);
            var proof = Proof(ctx);
            try { return Frame(await store.DecideAppeal(actions.Session(ctx), id, frame, proof, ct, fenceVisibleMessages)); }
            catch (ModerationProofRequiredException)
            {
                return ProofRequired(ctx);
            }
        });
    }
}
