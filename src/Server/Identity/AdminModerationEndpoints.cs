using FsusBlog.V2.Contracts;
using FsusBlogV2.Storage;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminModerationEndpoints
{
    internal static void Map(WebApplication app, Uri origin, AdminPasskeyStore store, string session, string passkeyLimit,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame, FsusBlog.V2.Server.Operations.SiteCapabilities capabilities)
    {
        var authority = origin.GetLeftPart(UriPartial.Authority);
        var actions = new AdminActionRoutes(app, authority, session, readFrame);
        var fenceVisibleMessages = capabilities.AdminInboxActivityOrder;
        AdminCommentAppeals.Map(app, authority, store, session, passkeyLimit, readFrame, fenceVisibleMessages);
        if (capabilities.AdminCommentBatch)
            AdminModerationBatchEndpoints.Map(app, authority, store, session, passkeyLimit, readFrame, fenceVisibleMessages);
        actions.Post(WireRoutes.AdminModerationClaim, WireLimits.AdminModerationClaimRequestFrameBytes, async (cookie, frame, ct) =>
            Wire.EncodeAdminModerationClaim(await store.AcquireCommentClaim(cookie, Wire.DecodeAdminModerationClaimRequest(frame), ct)))
            .RequireRateLimiting("command");
        actions.Post(WireRoutes.AdminModerationRenew, WireLimits.AdminModerationClaimFrameBytes, async (cookie, frame, ct) =>
            Wire.EncodeAdminModerationClaim(await store.RenewCommentClaim(cookie, Wire.DecodeAdminModerationClaim(frame), ct)))
            .RequireRateLimiting("command");
        actions.Post(WireRoutes.AdminModerationRelease, WireLimits.AdminModerationClaimFrameBytes, async (cookie, frame, ct) =>
        {
            await store.ReleaseCommentClaim(cookie, Wire.DecodeAdminModerationClaim(frame), ct);
            return Wire.EncodeEmptySuccess();
        }).RequireRateLimiting("command");
        actions.Post(WireRoutes.AdminModerationStepUpBegin, WireLimits.AdminModerationDecisionFrameBytes, (cookie, frame, ct) =>
            store.BeginModerationDecisionStepUp(cookie, Wire.DecodeAdminModerationDecision(frame), ct)).RequireRateLimiting(passkeyLimit);
        app.MapPost(WireRoutes.AdminModerationDecision, async (HttpContext ctx, CancellationToken ct) =>
        {
            var frame = await actions.Read(ctx, WireLimits.AdminModerationDecisionFrameBytes, ct);
            var proof = AdminActionRoutes.Proof(ctx);
            try
            {
                await store.DecideComment(ctx.Request.Cookies[session], proof, Wire.DecodeAdminModerationDecision(frame), ct,
                    fenceVisibleMessages);
                return Frame(Wire.EncodeEmptySuccess());
            }
            catch (ModerationProofRequiredException)
            {
                return AdminActionRoutes.ProofRequired(ctx);
            }
        }).RequireRateLimiting("command");
    }

    private static IResult Frame(byte[] frame) => Results.Bytes(frame, Aeds.ContentType);
}
