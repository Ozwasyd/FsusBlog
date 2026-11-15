using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlogV2.Storage;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminModerationEndpoints
{
    internal static void Map(WebApplication app, Uri origin, AdminPasskeyStore store, string session, string passkeyLimit,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        var authority = origin.GetLeftPart(UriPartial.Authority);
        var actions = new AdminActionRoutes(app, authority, session, readFrame);
        var fenceVisibleMessages = app.Configuration.GetValue(InboxActivityFence.Setting, false);
        AdminCommentAppeals.Map(app, authority, store, session, passkeyLimit, readFrame);
        if (app.Configuration.GetValue(AdminModerationBatchEndpoints.Setting, false))
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

    internal static void RequireOrigin(HttpContext ctx, string authority)
    {
        var origin = ctx.Request.Headers.Origin;
        if (origin.Count == 1 && string.Equals(origin[0], authority, StringComparison.OrdinalIgnoreCase)) return;
        var referer = ctx.Request.Headers.Referer;
        if (origin.Count == 0 && referer.Count == 1 && Uri.TryCreate(referer[0], UriKind.Absolute, out var uri) &&
            string.Equals(uri.GetLeftPart(UriPartial.Authority), authority, StringComparison.OrdinalIgnoreCase)) return;
        throw new BusinessException(Rejection.Forbidden, "A same-origin administrator request is required.");
    }

    private static IResult Frame(byte[] frame) => Results.Bytes(frame, Aeds.ContentType);
}
