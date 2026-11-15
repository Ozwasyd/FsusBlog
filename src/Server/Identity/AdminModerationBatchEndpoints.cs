using System.Globalization;
using FsusBlog.V2.Contracts;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminModerationBatchEndpoints
{
    internal const string Setting = "FSUSBLOG_ADMIN_COMMENT_BATCH";

    internal static void Map(WebApplication app, string origin, AdminPasskeyStore store, string session, string passkeyLimit,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame, bool fenceVisibleMessages)
    {
        app.MapPost(WireRoutes.AdminModerationBatchClaim, (HttpContext ctx, CancellationToken ct) => Run(ctx, origin, async () =>
        {
            var targets = Wire.DecodeAdminModerationBatchTargets(await readFrame(ctx, WireLimits.AdminModerationBatchTargetsFrameBytes, ct));
            return Wire.EncodeAdminModerationBatchClaims(await store.AcquireModerationBatch(ctx.Request.Cookies[session], targets, ct));
        })).RequireRateLimiting("command");

        app.MapPost(WireRoutes.AdminModerationBatchStepUpBegin, (HttpContext ctx, CancellationToken ct) => Run(ctx, origin, async () =>
        {
            var frame = await readFrame(ctx, WireLimits.AdminModerationBatchDecisionFrameBytes, ct);
            return await store.BeginModerationBatchStepUp(ctx.Request.Cookies[session], frame, ct);
        })).RequireRateLimiting(passkeyLimit);

        app.MapPost(WireRoutes.AdminModerationBatchStepUpComplete, (HttpContext ctx, CancellationToken ct) => Run(ctx, origin, async () =>
        {
            var frame = await readFrame(ctx, WireLimits.MaxPasskeyFrameBytes, ct);
            return await store.CompleteModerationBatchStepUp(ctx.Request.Cookies[session], PasskeyWire.ReadLogin(frame, discoverable: false), ct);
        })).RequireRateLimiting(passkeyLimit);

        app.MapPost(WireRoutes.AdminModerationBatchDecision, (HttpContext ctx, CancellationToken ct) => Run(ctx, origin, async () =>
        {
            var frame = await readFrame(ctx, WireLimits.AdminModerationBatchDecisionFrameBytes, ct);
            var proof = AdminActionRoutes.Proof(ctx);
            var receipt = await store.DecideModerationBatch(ctx.Request.Cookies[session], proof, frame, fenceVisibleMessages, ct);
            return Wire.EncodeAdminModerationBatchReceipt(receipt);
        })).RequireRateLimiting("command");
    }

    private static async Task<IResult> Run(HttpContext ctx, string origin, Func<Task<byte[]>> apply)
    {
        AdminModerationEndpoints.RequireOrigin(ctx, origin);
        try { return Results.Bytes(await apply(), Aeds.ContentType); }
        catch (ModerationBatchConflictException error)
        {
            const int status = StatusCodes.Status409Conflict;
            var details = $"moderation_batch_conflicts:{error.Positions.ToString("x5", CultureInfo.InvariantCulture)}";
            return new AedsError(status, Wire.EncodeError(status, "Selected comments or their claims changed.", details,
                traceId: ctx.TraceIdentifier));
        }
        catch (ModerationProofRequiredException)
        {
            return AdminActionRoutes.ProofRequired(ctx);
        }
    }
}
