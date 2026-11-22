using FsusBlog.V2.Contracts;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminArticleTrashRestore
{
    internal static void Map(AdminActionRoutes actions, AdminArticleTrashRestoreStore store)
    {
        actions.Availability(WireRoutes.AdminArticleTrashRestoreAvailability, store.CheckTrashRestoreAvailability);
        actions.Complete(WireRoutes.AdminArticleTrashRestoreComplete, store.CompleteTrashRestoreStepUp);
        actions.Begin(WireRoutes.AdminArticleTrashRestoreBegin, Intent, store.BeginTrashRestoreStepUp);
        actions.App.MapPost(WireRoutes.AdminArticleTrashRestoreExecute, async (HttpContext ctx, CancellationToken ct) =>
        {
            var result = await store.RestoreFromTrash(actions.Session(ctx), AdminActionRoutes.Proof(ctx), await Intent(ctx, ct), ct);
            return AdminActionRoutes.Frame(Wire.EncodeAdminArticleTrashRestoreReceipt(result));
        }).RequireRateLimiting("command");

        Task<AdminArticleTrashRestoreIntent> Intent(HttpContext ctx, CancellationToken ct) =>
            actions.ReadIntent(ctx, WireLimits.AdminArticleTrashRestoreIntentFrameBytes, Wire.DecodeAdminArticleTrashRestoreIntent,
                intent => intent.IdempotencyKey, required: true, ct);
    }
}
