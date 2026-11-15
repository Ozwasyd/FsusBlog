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
        var fenceVisibleMessages = app.Configuration.GetValue(InboxActivityFence.Setting, false);
        AdminCommentAppeals.Map(app, authority, store, session, passkeyLimit, readFrame);
        app.MapPost(WireRoutes.AdminModerationClaim, async (HttpContext ctx, CancellationToken ct) =>
        {
            RequireOrigin(ctx, authority);
            var frame = await readFrame(ctx, WireLimits.AdminModerationClaimRequestFrameBytes, ct);
            var claim = await store.AcquireCommentClaim(ctx.Request.Cookies[session], Wire.DecodeAdminModerationClaimRequest(frame), ct);
            return Frame(Wire.EncodeAdminModerationClaim(claim));
        }).RequireRateLimiting("command");
        app.MapPost(WireRoutes.AdminModerationRenew, async (HttpContext ctx, CancellationToken ct) =>
        {
            RequireOrigin(ctx, authority);
            var frame = await readFrame(ctx, WireLimits.AdminModerationClaimFrameBytes, ct);
            var claim = await store.RenewCommentClaim(ctx.Request.Cookies[session], Wire.DecodeAdminModerationClaim(frame), ct);
            return Frame(Wire.EncodeAdminModerationClaim(claim));
        }).RequireRateLimiting("command");
        app.MapPost(WireRoutes.AdminModerationRelease, async (HttpContext ctx, CancellationToken ct) =>
        {
            RequireOrigin(ctx, authority);
            var frame = await readFrame(ctx, WireLimits.AdminModerationClaimFrameBytes, ct);
            await store.ReleaseCommentClaim(ctx.Request.Cookies[session], Wire.DecodeAdminModerationClaim(frame), ct);
            return Frame(Wire.EncodeEmptySuccess());
        }).RequireRateLimiting("command");
        app.MapPost(WireRoutes.AdminModerationStepUpBegin, async (HttpContext ctx, CancellationToken ct) =>
        {
            RequireOrigin(ctx, authority);
            var frame = await readFrame(ctx, WireLimits.AdminModerationDecisionFrameBytes, ct);
            return Frame(await store.BeginModerationDecisionStepUp(ctx.Request.Cookies[session], Wire.DecodeAdminModerationDecision(frame), ct));
        }).RequireRateLimiting(passkeyLimit);
        app.MapPost(WireRoutes.AdminModerationDecision, async (HttpContext ctx, CancellationToken ct) =>
        {
            RequireOrigin(ctx, authority);
            var frame = await readFrame(ctx, WireLimits.AdminModerationDecisionFrameBytes, ct);
            var proof = ctx.Request.Headers[WireHeaders.MfaProof] is { Count: 1 } value ? value[0] : null;
            try
            {
                await store.DecideComment(ctx.Request.Cookies[session], proof, Wire.DecodeAdminModerationDecision(frame), ct,
                    fenceVisibleMessages);
                return Frame(Wire.EncodeEmptySuccess());
            }
            catch (ModerationProofRequiredException)
            {
                const int status = StatusCodes.Status428PreconditionRequired;
                return new AedsError(status, Wire.EncodeError(status, "MFA_PROOF_REQUIRED", traceId: ctx.TraceIdentifier));
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
