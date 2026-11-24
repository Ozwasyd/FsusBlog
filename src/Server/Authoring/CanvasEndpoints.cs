namespace FsusBlog.V2.Server.Authoring;

internal static class CanvasEndpoints
{
    internal static void Map(WebApplication app, string cookie, Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        CanvasGraphEndpoints.Map(app, cookie, readFrame);
        Map(WireRoutes.CanvasCreate, async (_, store, frame, ct) => Wire.EncodeCanvasCreated(
            await store.Create(Wire.DecodeCanvasCreate(frame), ct)));
        Map(WireRoutes.CanvasPreview, async (context, store, frame, ct) => Wire.EncodeCanvasLinkPlan(
            await store.Preview(Wire.DecodeCanvasPreview(frame), ct, SelectVisualEdge(context))));
        Map(WireRoutes.CanvasConfirm, async (_, store, frame, ct) => Wire.EncodeCanvasLinked(
            await store.Confirm(Wire.DecodeCanvasConfirm(frame).PlanId, ct)));

        void Map(string path, Func<HttpContext, CanvasStore, byte[], CancellationToken, Task<byte[]>> operation) =>
            app.MapCommandPost(path, async (HttpContext ctx, Store store, CancellationToken ct) =>
            {
                var frame = await readFrame(ctx, WireLimits.CanvasRequestBytes, ct);
                var token = ctx.Request.Cookies[cookie];
                var result = await store.WithSession(token, true,
                    (db, tx, actor) => operation(ctx, new CanvasStore(db, tx, actor, Store.TokenDigest(token)!), frame, ct), ct);
                return ServerHttp.Frame(result);
            });
    }

    private static bool SelectVisualEdge(HttpContext context)
    {
        if (!context.Request.Query.TryGetValue("edge", out var selection)) return false;
        if (selection.Count == 1 && selection[0] == "visual-only") return true;
        throw new BusinessException(Rejection.Invalid, "Invalid Canvas edge selection.");
    }
}
