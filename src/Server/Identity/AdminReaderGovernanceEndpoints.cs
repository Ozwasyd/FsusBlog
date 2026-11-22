using FsusBlog.V2.Contracts;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminReaderGovernanceEndpoints
{
    internal static void Map(AdminActionRoutes actions, AdminReaderGovernanceStore store)
    {
        actions.App.MapCommandGet(WireRoutes.AdminReaderAccounts, async (HttpContext ctx, CancellationToken ct) =>
        {
            ctx.Response.Headers.CacheControl = "no-store";
            var result = await store.ListReaders(actions.Session(ctx), ctx.Request.Query, ct);
            ctx.Response.Headers[WireHeaders.AdminPermissionSession] = result.PermissionSession;
            return AdminActionRoutes.Frame(Wire.EncodeAdminReaderAccountPage(result.Page));
        });

        actions.Begin(WireRoutes.AdminReaderStatusStepUpBegin, Command, store.BeginStatusStepUp);

        actions.Complete(WireRoutes.AdminReaderStatusStepUpComplete, store.CompleteStatusStepUp);

        actions.App.MapCommandPost(WireRoutes.AdminReaderStatusExecute, async (HttpContext ctx, CancellationToken ct) =>
        {
            ctx.Response.Headers.CacheControl = "no-store";
            var command = await Command(ctx, ct);
            try
            {
                var result = await store.ExecuteStatusChange(actions.Session(ctx), AdminActionRoutes.Proof(ctx), command, ct);
                ctx.Response.Headers[WireHeaders.AdminPermissionSession] = result.PermissionSession;
                return AdminActionRoutes.Frame(Wire.EncodeAdminReaderStatusReceipt(result.Receipt));
            }
            catch (ReaderGovernanceProofRequiredException)
            {
                return AdminActionRoutes.ProofRequired(ctx);
            }
        });

        Task<AdminReaderStatusCommand> Command(HttpContext ctx, CancellationToken ct) =>
            actions.ReadIntent(ctx, WireLimits.AdminReaderStatusCommandFrameBytes, Wire.DecodeAdminReaderStatusCommand,
                command => command.IdempotencyKey, required: true, ct);
    }
}
