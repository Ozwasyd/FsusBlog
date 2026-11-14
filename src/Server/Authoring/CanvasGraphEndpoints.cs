using System.Globalization;
using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;

namespace FsusBlog.V2.Server.Authoring;

internal static class CanvasGraphEndpoints
{
    internal static void Map(WebApplication app, string cookie, Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        app.MapGet(WireRoutes.CanvasGraphList, (HttpContext ctx, Store store, CancellationToken ct) =>
            store.WithSession(ctx.Request.Cookies[cookie], true, async (db, tx, actor) =>
                Frame(Wire.EncodeCanvasGraphList(await new CanvasGraphStore(db, tx, actor).List(ct))), ct))
            .RequireRateLimiting("command");

        app.MapGet(WireRoutes.CanvasGraphPage, (HttpContext ctx, Store store, Guid id, CancellationToken ct) =>
        {
            long revision = Coordinate(ctx, "revision", long.MaxValue);
            int offset = (int)Coordinate(ctx, "offset", 20_000);
            return store.WithSession(ctx.Request.Cookies[cookie], true, async (db, tx, actor) =>
                Frame(Wire.EncodeCanvasGraphPage(await new CanvasGraphStore(db, tx, actor).Page(id, revision, offset, ct))), ct);
        }).RequireRateLimiting("command");

        app.MapGet(WireRoutes.CanvasReference, (HttpContext ctx, Store store, Guid id, Guid nodeId, CancellationToken ct) =>
        {
            long revision = Coordinate(ctx, "revision", long.MaxValue);
            return store.WithSession(ctx.Request.Cookies[cookie], true, async (db, tx, actor) =>
                Frame(Wire.EncodeCanvasReferenceResolution(await new CanvasGraphStore(db, tx, actor).Resolve(id, nodeId, revision, ct))), ct);
        }).RequireRateLimiting("command");

        app.MapGet(WireRoutes.CanvasGraphHistory, (HttpContext ctx, Store store, Guid id, CancellationToken ct) =>
        {
            long revision = Coordinate(ctx, "revision", long.MaxValue);
            return store.WithSession(ctx.Request.Cookies[cookie], true, async (db, tx, actor) =>
                Frame(Wire.EncodeCanvasGraphHistory(await new CanvasGraphStore(db, tx, actor).History(id, revision, ct))), ct);
        }).RequireRateLimiting("command");

        app.MapPost(WireRoutes.CanvasGraphWrite, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            byte[] frame = await readFrame(ctx, WireLimits.CanvasGraphCommandBytes, ct);
            var command = Wire.DecodeCanvasGraphCommand(frame);
            if (ctx.Request.Headers.TryGetValue(WireHeaders.ClientMutationId, out var header) &&
                (header.Count != 1 || !Guid.TryParseExact(header[0], "D", out var id) || id != command.CommandId))
                throw new BusinessException(Rejection.Invalid, "Command key does not match its request header.");
            byte[] fingerprint = SHA256.HashData(frame);
            return await store.WithSession(ctx.Request.Cookies[cookie], true, async (db, tx, actor) =>
                Frame(Wire.EncodeCanvasGraphReceipt(await new CanvasGraphStore(db, tx, actor).Write(command, fingerprint, ct))), ct);
        }).RequireRateLimiting("command");
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

    private static IResult Frame(byte[] bytes) => Results.Bytes(bytes, Aeds.ContentType);
}
