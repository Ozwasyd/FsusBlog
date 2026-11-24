namespace FsusBlog.V2.Server.Authoring;

internal static class CanvasGraphEndpoints
{
    internal static void Map(WebApplication app, string cookie, Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        app.MapCommandGet(WireRoutes.CanvasBundleExport, (HttpContext ctx, Store store, Guid id, CancellationToken ct) =>
        {
            long revision = Coordinate(ctx, "revision", long.MaxValue);
            return store.WithSession(ctx.Request.Cookies[cookie], true, async (db, tx, actor) =>
            {
                var bytes = await new CanvasGraphStore(db, tx, actor).ExportBundle(id, revision, ct);
                return Results.File(bytes, Wire.CanvasBundleContentType, "canvas.fsuscanvas");
            }, ct);
        });

        app.MapCommandPost(WireRoutes.CanvasBundlePlan, (HttpContext ctx, Store store, CancellationToken ct) =>
            store.WithSession(ctx.Request.Cookies[cookie], true, async (_, _, _) =>
            {
                var frame = await readFrame(ctx, WireLimits.CanvasBundleBytes + Aeds.HeaderSize, ct);
                return ServerHttp.Frame(Wire.EncodeCanvasBundlePlan(CanvasBundleStore.Plan(Wire.DecodeCanvasBundleIntake(frame))));
            }, ct));

        app.MapCommandPost(WireRoutes.CanvasBundleExecute, (HttpContext ctx, Store store, CancellationToken ct) =>
            store.WithSession(ctx.Request.Cookies[cookie], true, async (db, tx, actor) =>
            {
                var frame = await readFrame(ctx, WireLimits.CanvasBundleExecuteFrameBytes, ct);
                var input = Wire.DecodeCanvasBundleExecute(frame);
                ClientMutationHeader.Require(ctx, input.CommandId);
                var result = await new CanvasGraphStore(db, tx, actor).ImportBundle(input, SHA256.HashData(frame), ct);
                return ServerHttp.Frame(Wire.EncodeCanvasGraphReceipt(result));
            }, ct));

        app.MapCommandGet(WireRoutes.CanvasGraphList, (HttpContext ctx, Store store, CancellationToken ct) =>
            store.WithSession(ctx.Request.Cookies[cookie], true, async (db, tx, actor) =>
                ServerHttp.Frame(Wire.EncodeCanvasGraphList(await new CanvasGraphStore(db, tx, actor).List(ct))), ct));

        app.MapCommandGet(WireRoutes.CanvasGraphPage, (HttpContext ctx, Store store, Guid id, CancellationToken ct) =>
        {
            long revision = Coordinate(ctx, "revision", long.MaxValue);
            int offset = (int)Coordinate(ctx, "offset", 20_000);
            return store.WithSession(ctx.Request.Cookies[cookie], true, async (db, tx, actor) =>
                ServerHttp.Frame(Wire.EncodeCanvasGraphPage(await new CanvasGraphStore(db, tx, actor).Page(id, revision, offset, ct))), ct);
        });

        app.MapCommandGet(WireRoutes.CanvasReference, (HttpContext ctx, Store store, Guid id, Guid nodeId, CancellationToken ct) =>
        {
            long revision = Coordinate(ctx, "revision", long.MaxValue);
            bool requireCurrent = ctx.Request.Query.TryGetValue("current", out var current);
            if (requireCurrent && (current.Count != 1 || current[0] != "1"))
                throw new BusinessException(Rejection.Invalid, "Invalid Canvas reference mode.");
            var token = ctx.Request.Cookies[cookie];
            return store.WithSession(token, true, async (db, tx, actor) =>
            {
                if (requireCurrent)
                    SiteSessions.RequireCurrent(actor.Id, Store.TokenDigest(token)!, SiteSessions.Requested(ctx));
                var resolved = await new CanvasGraphStore(db, tx, actor).Resolve(id, nodeId, revision, requireCurrent, ct);
                return ServerHttp.Frame(Wire.EncodeCanvasReferenceResolution(resolved));
            }, ct);
        });

        app.MapCommandGet(WireRoutes.CanvasGraphHistory, (HttpContext ctx, Store store, Guid id, CancellationToken ct) =>
        {
            long revision = Coordinate(ctx, "revision", long.MaxValue);
            return store.WithSession(ctx.Request.Cookies[cookie], true, async (db, tx, actor) =>
                ServerHttp.Frame(Wire.EncodeCanvasGraphHistory(await new CanvasGraphStore(db, tx, actor).History(id, revision, ct))), ct);
        });

        app.MapCommandPost(WireRoutes.CanvasGraphWrite, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            byte[] frame = await readFrame(ctx, WireLimits.CanvasGraphCommandBytes, ct);
            var command = Wire.DecodeCanvasGraphCommand(frame);
            ClientMutationHeader.Require(ctx, command.CommandId);
            byte[] fingerprint = SHA256.HashData(frame);
            return await store.WithSession(ctx.Request.Cookies[cookie], true, async (db, tx, actor) =>
                ServerHttp.Frame(Wire.EncodeCanvasGraphReceipt(await new CanvasGraphStore(db, tx, actor).Write(command, fingerprint, ct))), ct);
        });
    }

    private static long Coordinate(HttpContext context, string name, long max)
    {
        if (!context.Request.Query.TryGetValue(name, out var values)) return 0;
        if (values.Count != 1 || values[0] is not { Length: > 0 and <= 19 } attempt ||
            !long.TryParse(attempt, NumberStyles.None, CultureInfo.InvariantCulture, out long value) ||
            value < 0 || value > max)
            throw new BusinessException(Rejection.Invalid, "Invalid Canvas paging coordinate.");
        return value;
    }
}
