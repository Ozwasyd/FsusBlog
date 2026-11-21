using FsusBlog.V2.Contracts;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminArticleTrashRestore
{
    internal static void Map(WebApplication app, Uri origin, AdminArticleTrashRestoreStore store, string session, string limit,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        var routes = new AdminActionRoutes(app, origin.GetLeftPart(UriPartial.Authority), session, readFrame);
        routes.Availability(WireRoutes.AdminArticleTrashRestoreAvailability, store.CheckTrashRestoreAvailability);
        routes.Complete(WireRoutes.AdminArticleTrashRestoreComplete, limit, store.CompleteTrashRestoreStepUp);
        app.MapPost(WireRoutes.AdminArticleTrashRestoreBegin, async (HttpContext ctx, CancellationToken ct) =>
            AdminActionRoutes.Frame(await store.BeginTrashRestoreStepUp(ctx.Request.Cookies[session], await Intent(ctx, ct), ct)))
            .RequireRateLimiting(limit);
        app.MapPost(WireRoutes.AdminArticleTrashRestoreExecute, async (HttpContext ctx, CancellationToken ct) =>
        {
            var result = await store.RestoreFromTrash(ctx.Request.Cookies[session], AdminActionRoutes.Proof(ctx), await Intent(ctx, ct), ct);
            return AdminActionRoutes.Frame(Wire.EncodeAdminArticleTrashRestoreReceipt(result));
        }).RequireRateLimiting("command");

        Task<AdminArticleTrashRestoreIntent> Intent(HttpContext ctx, CancellationToken ct) =>
            routes.ReadIntent(ctx, WireLimits.AdminArticleTrashRestoreIntentFrameBytes, Wire.DecodeAdminArticleTrashRestoreIntent,
                intent => intent.IdempotencyKey, required: true, ct);
    }
}
