namespace FsusBlog.V2.Server.Authoring;

internal sealed class DraftMutationRoutes(WebApplication app, string cookie,
    Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
{
    internal void MapSchedule(Func<HttpContext, string, int, string?> query)
    {
        Get(WireRoutes.DraftSchedule, query, ArticleScheduleStore.Read, Wire.EncodeArticleSchedule);
        Post(WireRoutes.DraftScheduleCommand, WireLimits.MaxArticleScheduleFrameBytes, Wire.DecodeArticleScheduleCommand,
            input => input.IdempotencyKey, Store.Schedule, value => ServerHttp.Frame(Wire.EncodeArticleSchedule(value)));
    }

    internal void MapRights(Func<HttpContext, string, int, string?> query)
    {
        Get(WireRoutes.DraftRights, query, async (db, tx, actor, id, revision, ct) =>
        {
            await RevisionHistoryStore.LockCurrent(db, tx, actor, id, revision, ct);
            return await PublicationRightsStore.Read(db, tx, id, revision, ct);
        }, Wire.EncodeArticleRightsPolicy);
        Post(WireRoutes.DraftRightsCommand, WireLimits.MaxArticleRightsFrameBytes, Wire.DecodeArticleRightsCommand,
            input => input.IdempotencyKey, Store.SetRights, value => ServerHttp.Frame(Wire.EncodeArticleRightsPolicy(value)));
    }

    internal void MapRollback() =>
        Post(WireRoutes.DraftRollback, WireLimits.MaxDraftRollbackFrameBytes, Wire.DecodeDraftRollback,
            input => input.IdempotencyKey, Store.RollbackDraft, ServerHttp.DraftResponse);

    private void Get<T>(string route, Func<HttpContext, string, int, string?> query,
        Func<NpgsqlConnection, NpgsqlTransaction, Identity, int, long, CancellationToken, Task<T>> read, Func<T, byte[]> encode) =>
        app.MapCommandGet(route, (HttpContext ctx, Store store, int id, CancellationToken ct) =>
        {
            var revision = DraftRevisionQuery.Read(ctx, id, query);
            return store.WithSession(ctx.Request.Cookies[cookie], true, async (db, tx, actor) =>
                ServerHttp.Frame(encode(await read(db, tx, actor, id, revision, ct))), ct);
        });

    private delegate T Decode<T>(ReadOnlySpan<byte> frame);

    private void Post<T, TResult>(string route, int maximumBytes, Decode<T> decode, Func<T, Guid> key,
        Func<NpgsqlConnection, NpgsqlTransaction, Identity, T, CancellationToken, Task<TResult>> apply, Func<TResult, IResult> respond) =>
        app.MapCommandPost(route, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var input = decode(await readFrame(ctx, maximumBytes, ct));
            ClientMutationHeader.Require(ctx, key(input));
            return await store.WithSession(ctx.Request.Cookies[cookie], true, async (db, tx, actor) =>
                respond(await apply(db, tx, actor, input, ct)), ct);
        });
}
