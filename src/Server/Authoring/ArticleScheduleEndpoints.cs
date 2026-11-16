using FsusBlog.V2.Contracts;

namespace FsusBlog.V2.Server.Authoring;

internal static class ArticleScheduleEndpoints
{
    internal static void Map(WebApplication app, string cookie, Func<HttpContext, string, int, string?> query,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        app.MapGet(WireRoutes.DraftSchedule, (HttpContext ctx, Store store, int id, CancellationToken ct) =>
        {
            var rev = DraftRevisionQuery.Read(ctx, id, query);
            return store.WithSession(ctx.Request.Cookies[cookie], true, async (db, tx, actor) =>
                Results.Bytes(Wire.EncodeArticleSchedule(await ArticleScheduleStore.Read(db, tx, actor, id, rev, ct)), Aeds.ContentType), ct);
        }).RequireRateLimiting("command");

        app.MapPost(WireRoutes.DraftScheduleCommand, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var input = Wire.DecodeArticleScheduleCommand(await readFrame(ctx, WireLimits.MaxArticleScheduleFrameBytes, ct));
            ClientMutationHeader.Require(ctx, input.IdempotencyKey);
            return await store.WithSession(ctx.Request.Cookies[cookie], true, async (db, tx, actor) =>
                Results.Bytes(Wire.EncodeArticleSchedule(await Store.Schedule(db, tx, actor, input, ct)), Aeds.ContentType), ct);
        }).RequireRateLimiting("command");
    }
}
