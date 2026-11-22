using FsusBlog.V2.Contracts;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminHandleEndpoints
{
    internal static void Map(WebApplication app, Uri origin, AdminHandleStore store, string session, string limit,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        var routes = new AdminActionRoutes(app, origin.GetLeftPart(UriPartial.Authority), session, readFrame);

        app.MapPost(WireRoutes.AdminHandleStepUpBegin, async (HttpContext ctx, CancellationToken ct) =>
            AdminActionRoutes.Frame(await store.BeginRenameStepUp(ctx.Request.Cookies[session], await Command(ctx, ct), ct)))
            .RequireRateLimiting(limit);

        routes.Complete(WireRoutes.AdminHandleStepUpComplete, limit, store.CompleteRenameStepUp);

        app.MapPost(WireRoutes.AdminHandleExecute, async (HttpContext ctx, CancellationToken ct) =>
        {
            ctx.Response.Headers.CacheControl = "no-store";
            var command = await Command(ctx, ct);
            try
            {
                var result = await store.ExecuteRename(ctx.Request.Cookies[session], AdminActionRoutes.Proof(ctx), command, ct);
                ctx.Response.Headers[WireHeaders.AdminPermissionSession] = result.PermissionSession;
                return AdminActionRoutes.Frame(Wire.EncodeAdminHandleReceipt(result.Receipt));
            }
            catch (AdminHandleProofRequiredException)
            {
                return AdminActionRoutes.ProofRequired(ctx);
            }
        }).RequireRateLimiting("command");

        Task<AdminHandleCommand> Command(HttpContext ctx, CancellationToken ct) =>
            routes.ReadIntent(ctx, WireLimits.AdminHandleCommandFrameBytes, Wire.DecodeAdminHandleCommand,
                command => command.IdempotencyKey, required: true, ct);
    }
}
