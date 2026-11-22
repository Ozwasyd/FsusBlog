using FsusBlog.V2.Contracts;
using static FsusBlog.V2.Server.Administration.AdminActionRoutes;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminModerationEndpoints
{
    internal static void Map(AdminActionRoutes actions, AdminModerationStore store, bool fenceVisibleMessages)
    {
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
            store.BeginModerationDecisionStepUp(cookie, Wire.DecodeAdminModerationDecision(frame), ct)).RequireRateLimiting(actions.PasskeyLimit);
        actions.App.MapPost(WireRoutes.AdminModerationDecision, async (HttpContext ctx, CancellationToken ct) =>
        {
            var frame = await actions.Read(ctx, WireLimits.AdminModerationDecisionFrameBytes, ct);
            var proof = Proof(ctx);
            try
            {
                await store.DecideComment(actions.Session(ctx), proof, Wire.DecodeAdminModerationDecision(frame), ct,
                    fenceVisibleMessages);
                return Frame(Wire.EncodeEmptySuccess());
            }
            catch (ModerationProofRequiredException)
            {
                return ProofRequired(ctx);
            }
        }).RequireRateLimiting("command");
    }
}
