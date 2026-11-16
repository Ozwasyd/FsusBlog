using FsusBlog.V2.Contracts;

namespace FsusBlog.V2.Server.Authoring;

internal static class PublicationRightsEndpoints
{
    internal static void Map(WebApplication app, string cookie, Func<HttpContext, string, int, string?> query,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        app.MapGet(WireRoutes.DraftRights, (HttpContext ctx, Store store, int id, CancellationToken ct) =>
        {
            var rev = DraftRevisionQuery.Read(ctx, id, query);
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
            ClientMutationHeader.Require(ctx, input.IdempotencyKey);
            return await store.WithSession(ctx.Request.Cookies[cookie], true, async (db, tx, actor) =>
                Results.Bytes(Wire.EncodeArticleRightsPolicy(await Store.SetRights(db, tx, actor, input, ct)), Aeds.ContentType), ct);
        }).RequireRateLimiting("command");
    }
}
