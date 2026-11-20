using FsusBlog.V2.Contracts;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminCommentAppeals
{
    internal static void Map(WebApplication app, string origin, AdminCommentAppealStore store, string session, string passkeyLimit,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame, bool fenceVisibleMessages)
    {
        var actions = new AdminActionRoutes(app, origin, session, readFrame);
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
