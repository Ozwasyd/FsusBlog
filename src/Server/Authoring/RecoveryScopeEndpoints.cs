using FsusBlog.V2.Contracts;
using FsusBlogV2.Storage;

namespace FsusBlog.V2.Server.Authoring;

internal static class RecoveryScopeEndpoints
{
    internal static void Map(WebApplication app, string cookie)
    {
        app.MapGet(WireRoutes.DraftRecoveryScope, (HttpContext ctx, Store store, CancellationToken ct) =>
            store.WithSession(ctx.Request.Cookies[cookie], true, async (db, tx, actor) =>
            {
                var site = await CurrentSchema.ReadRecoverySiteIdAsync(db, tx, ct);
                return Results.Bytes(Wire.EncodeDraftRecoveryScope(new(site, actor.Id)), Aeds.ContentType);
            }, ct)).RequireRateLimiting("command");
    }
}
