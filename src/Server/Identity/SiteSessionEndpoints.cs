using FsusBlog.V2.Contracts;

namespace FsusBlog.V2.Server.Sessions;

internal static class SiteSessionEndpoints
{
    internal static void Map(WebApplication app, string sessionName, bool persistent = false)
    {
        app.MapGet(WireRoutes.SiteSessions, async (HttpContext ctx, Store store, CancellationToken ct) =>
            Results.Bytes(Wire.EncodeSiteSessions(await SiteSessions.List(store, ctx.Request.Cookies[sessionName], Current(ctx), ct, persistent)),
                Aeds.ContentType)).RequireRateLimiting("command");
        app.MapPost(WireRoutes.SiteSessionRevoke, (HttpContext ctx, Store store, string id, CancellationToken ct) =>
            Revoke(ctx, store, id, ct)).RequireRateLimiting("command");
        app.MapPost(WireRoutes.SiteSessionsRevokeOthers, (HttpContext ctx, Store store, CancellationToken ct) =>
            Revoke(ctx, store, null, ct)).RequireRateLimiting("command");

        async Task<IResult> Revoke(HttpContext ctx, Store store, string? target, CancellationToken ct)
        {
            await SiteSessions.Revoke(store, ctx.Request.Cookies[sessionName], Current(ctx), target, ct, persistent);
            return Results.Bytes(Wire.EncodeEmptySuccess(), Aeds.ContentType);
        }
    }

    private static string? Current(HttpContext ctx) =>
        ctx.Request.Headers[WireHeaders.CurrentSession] is { Count: 1 } value ? value[0] : null;
}
