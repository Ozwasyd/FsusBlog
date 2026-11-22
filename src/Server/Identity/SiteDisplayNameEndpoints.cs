using FsusBlog.V2.Contracts;

namespace FsusBlog.V2.Server.Sessions;

internal static class SiteDisplayNameEndpoints
{
    internal static void Map(WebApplication app, string sessionName,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        app.MapCommandGet(WireRoutes.SiteDisplayName, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            ctx.Response.Headers.CacheControl = "private, no-store";
            var state = await SiteDisplayNames.Read(store, ctx.Request.Cookies[sessionName], Current(ctx), ct);
            return ServerHttp.Frame(Wire.EncodeSiteDisplayNameState(state));
        });

        app.MapCommandPost(WireRoutes.SiteDisplayName, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            ctx.Response.Headers.CacheControl = "private, no-store";
            var command = Wire.DecodeSiteDisplayNameCommand(await readFrame(ctx, WireLimits.SiteDisplayNameFrameBytes, ct));
            var state = await SiteDisplayNames.Update(store, ctx.Request.Cookies[sessionName], Current(ctx), command, ct);
            return ServerHttp.Frame(Wire.EncodeSiteDisplayNameState(state));
        });
    }

    private static string? Current(HttpContext ctx) =>
        ctx.Request.Headers[WireHeaders.CurrentSession] is { Count: 1 } value ? value[0] : null;
}
