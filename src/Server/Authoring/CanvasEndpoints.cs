using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;

namespace FsusBlog.V2.Server.Authoring;

internal static class CanvasEndpoints
{
    internal static void Map(WebApplication app, string cookie, Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        CanvasGraphEndpoints.Map(app, cookie, readFrame);
        Map(WireRoutes.CanvasCreate, async (store, frame, ct) => Wire.EncodeCanvasCreated(
            await store.Create(Wire.DecodeCanvasCreate(frame), ct)));
        Map(WireRoutes.CanvasPreview, async (store, frame, ct) => Wire.EncodeCanvasLinkPlan(
            await store.Preview(Wire.DecodeCanvasPreview(frame), ct)));
        Map(WireRoutes.CanvasConfirm, async (store, frame, ct) => Wire.EncodeCanvasLinked(
            await store.Confirm(Wire.DecodeCanvasConfirm(frame).PlanId, ct)));

        void Map(string path, Func<CanvasStore, byte[], CancellationToken, Task<byte[]>> operation) =>
            app.MapPost(path, async (HttpContext ctx, Store store, CancellationToken ct) =>
            {
                var frame = await readFrame(ctx, WireLimits.CanvasRequestBytes, ct);
                var token = ctx.Request.Cookies[cookie];
                var result = await store.WithSession(token, true,
                    (db, tx, actor) => operation(new CanvasStore(db, tx, actor, Store.TokenDigest(token)!), frame, ct), ct);
                return Results.Bytes(result, Aeds.ContentType);
            }).RequireRateLimiting("command");
    }
}
