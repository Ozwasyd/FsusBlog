using FsusBlog.V2.Contracts;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminHandleEndpoints
{
    internal static void Map(AdminActionRoutes actions, AdminHandleStore store)
    {
        actions.Begin(WireRoutes.AdminHandleStepUpBegin, Command, store.BeginRenameStepUp);

        actions.Complete(WireRoutes.AdminHandleStepUpComplete, store.CompleteRenameStepUp);

        actions.App.MapPost(WireRoutes.AdminHandleExecute, async (HttpContext ctx, CancellationToken ct) =>
        {
            ctx.Response.Headers.CacheControl = "no-store";
            var command = await Command(ctx, ct);
            try
            {
                var result = await store.ExecuteRename(actions.Session(ctx), AdminActionRoutes.Proof(ctx), command, ct);
                ctx.Response.Headers[WireHeaders.AdminPermissionSession] = result.PermissionSession;
                return AdminActionRoutes.Frame(Wire.EncodeAdminHandleReceipt(result.Receipt));
            }
            catch (AdminHandleProofRequiredException)
            {
                return AdminActionRoutes.ProofRequired(ctx);
            }
        }).RequireRateLimiting("command");

        Task<AdminHandleCommand> Command(HttpContext ctx, CancellationToken ct) =>
            actions.ReadIntent(ctx, WireLimits.AdminHandleCommandFrameBytes, Wire.DecodeAdminHandleCommand,
                command => command.IdempotencyKey, required: true, ct);
    }
}
