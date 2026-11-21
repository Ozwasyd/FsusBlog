using FsusBlog.V2.Contracts;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminReaderGovernanceEndpoints
{
    internal static void Map(WebApplication app, Uri origin, AdminReaderGovernanceStore store, string session, string limit,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        var routes = new AdminActionRoutes(app, origin.GetLeftPart(UriPartial.Authority), session, readFrame);

        app.MapGet(WireRoutes.AdminReaderAccounts, async (HttpContext ctx, CancellationToken ct) =>
        {
            ctx.Response.Headers.CacheControl = "no-store";
            var result = await store.ListReaders(ctx.Request.Cookies[session], ctx.Request.Query, ct);
            ctx.Response.Headers[WireHeaders.AdminPermissionSession] = result.PermissionSession;
            return AdminActionRoutes.Frame(Wire.EncodeAdminReaderAccountPage(result.Page));
        }).RequireRateLimiting("command");

        app.MapPost(WireRoutes.AdminReaderStatusStepUpBegin, async (HttpContext ctx, CancellationToken ct) =>
            AdminActionRoutes.Frame(await store.BeginStatusStepUp(ctx.Request.Cookies[session], await Command(ctx, ct), ct)))
            .RequireRateLimiting(limit);

        routes.Complete(WireRoutes.AdminReaderStatusStepUpComplete, limit, store.CompleteStatusStepUp);

        app.MapPost(WireRoutes.AdminReaderStatusExecute, async (HttpContext ctx, CancellationToken ct) =>
        {
            ctx.Response.Headers.CacheControl = "no-store";
            var command = await Command(ctx, ct);
            try
            {
                var result = await store.ExecuteStatusChange(ctx.Request.Cookies[session], AdminActionRoutes.Proof(ctx), command, ct);
                ctx.Response.Headers[WireHeaders.AdminPermissionSession] = result.PermissionSession;
                return AdminActionRoutes.Frame(Wire.EncodeAdminReaderStatusReceipt(result.Receipt));
            }
            catch (ReaderGovernanceProofRequiredException)
            {
                return AdminActionRoutes.ProofRequired(ctx);
            }
        }).RequireRateLimiting("command");

        Task<AdminReaderStatusCommand> Command(HttpContext ctx, CancellationToken ct) =>
            routes.ReadIntent(ctx, WireLimits.AdminReaderStatusCommandFrameBytes, Wire.DecodeAdminReaderStatusCommand,
                command => command.IdempotencyKey, required: true, ct);
    }
}
