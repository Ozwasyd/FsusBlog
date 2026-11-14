using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;

namespace FsusBlog.V2.Server.Authoring;

internal static class PublicationRightsEndpoints
{
    internal static void Map(WebApplication app, string cookie, Func<HttpContext, string, int, string?> query,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        app.MapGet(WireRoutes.DraftRights, (HttpContext ctx, Store store, int id, CancellationToken ct) =>
        {
            if (id <= 0 || !long.TryParse(query(ctx, "revision", 19), NumberStyles.None, CultureInfo.InvariantCulture, out var rev) || rev <= 0)
                throw new BusinessException(Rejection.Invalid, "A valid draft revision is required.");
            return store.WithSession(ctx.Request.Cookies[cookie], true, async (db, tx, actor) =>
            {
                await RevisionHistoryStore.LockCurrent(db, tx, actor, id, rev, ct);
                var policy = await PublicationRightsStore.Read(db, tx, id, rev, ct);
                return Results.Bytes(Wire.EncodeArticleRightsPolicy(policy), Aeds.ContentType);
            }, ct);
        }).RequireRateLimiting("command");

        app.MapPost(WireRoutes.DraftRightsCommand, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var input = Wire.DecodeArticleRightsCommand(await readFrame(ctx, WireLimits.MaxArticleRightsFrameBytes, ct));
            if (ctx.Request.Headers.TryGetValue(WireHeaders.ClientMutationId, out var header) &&
                (header.Count != 1 || !Guid.TryParseExact(header[0], "D", out var key) || key != input.IdempotencyKey))
                throw new BusinessException(Rejection.Invalid, "Command key does not match its request header.");
            return await store.WithSession(ctx.Request.Cookies[cookie], true, async (db, tx, actor) =>
                Results.Bytes(Wire.EncodeArticleRightsPolicy(await Store.SetRights(db, tx, actor, input, ct)), Aeds.ContentType), ct);
        }).RequireRateLimiting("command");
    }
}
