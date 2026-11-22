using FsusBlog.V2.Contracts;
using FsusBlogV2.Storage;

namespace FsusBlog.V2.Server.Authoring;

internal static class RecoveryScopeEndpoints
{
    internal static void Map(WebApplication app, string cookie)
    {
        app.MapCommandGet(WireRoutes.DraftRecoveryScope, (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var token = ctx.Request.Cookies[cookie];
            var expected = FsusBlog.V2.Server.Sessions.SiteSessions.Requested(ctx);
            return store.WithSession(token, true, async (db, tx, actor) =>
            {
                FsusBlog.V2.Server.Sessions.SiteSessions.IfCurrent(actor.Id, token, expected);
                var site = await CurrentSchema.ReadRecoverySiteIdAsync(db, tx, ct);
                return Results.Bytes(Wire.EncodeDraftRecoveryScope(new(site, actor.Id)), Aeds.ContentType);
            }, ct);
        });
    }
}
