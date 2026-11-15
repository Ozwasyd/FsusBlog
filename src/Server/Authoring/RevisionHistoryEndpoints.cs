using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Authoring;
using FsusBlog.V2.Server.Sessions;

namespace FsusBlog.V2.Server.Authoring;

internal static class RevisionHistoryEndpoints
{
    internal static void Map(WebApplication app, string cookie, Func<HttpContext, string, int, string?> query,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        app.MapGet(WireRoutes.DraftRevisionHistory, (HttpContext ctx, Store store, int id, CancellationToken ct) =>
        {
            var expected = Expected(ctx, id);
            var cursor = query(ctx, "cursor", WireLimits.RevisionHistoryCursorChars);
            var token = ctx.Request.Cookies[cookie];
            return store.WithSession(token, true, async (db, tx, actor) =>
            {
                var published = await RevisionHistoryStore.LockCurrent(db, tx, actor, id, expected, ct);
                long before = 0;
                if (cursor is not null && !RevisionHistoryCursor.TryDecode(token!, id, expected, cursor, out before))
                    throw new BusinessException(Rejection.Invalid, "Invalid or expired revision history cursor.");
                var items = await RevisionHistoryStore.Read(db, tx, id, expected, before, ct);
                var next = "";
                if (items.Count > WireLimits.RevisionHistoryPageSize)
                {
                    items.RemoveAt(items.Count - 1);
                    next = RevisionHistoryCursor.Encode(token!, id, expected, items[^1].Revision);
                }
                var page = new RevisionHistoryPage(id, expected, published, next, items);
                return Results.Bytes(Wire.EncodeRevisionHistory(page), Aeds.ContentType);
            }, ct);
        }).RequireRateLimiting("command");

        app.MapGet(WireRoutes.DraftRevisionComparison, (HttpContext ctx, Store store, int id, long sourceRevision, CancellationToken ct) =>
        {
            var expected = Expected(ctx, id);
            var map = query(ctx, "map", 16);
            if (map is not (null or "body-insertion" or "body-chain" or "body-edit" or "properties"))
                throw new BusinessException(Rejection.Invalid, "Unknown saved revision map.");
            if (sourceRevision <= 0 || sourceRevision > expected || (sourceRevision == expected && map != "properties"))
                throw new BusinessException(Rejection.Invalid, "A historical source revision is required.");
            var token = ctx.Request.Cookies[cookie];
            var handle = SiteSessions.Requested(ctx);
            return store.WithSession(token, true, async (db, tx, actor) =>
            {
                if (handle is not null || map is not null)
                    SiteSessions.RequireCurrent(actor.Id, Store.TokenDigest(token)!, handle);
                await RevisionHistoryStore.LockCurrent(db, tx, actor, id, expected, ct);
                if (map == "properties")
                {
                    var cursor = query(ctx, "offset", 4);
                    int offset = 0;
                    if (cursor is not null && (!int.TryParse(cursor, NumberStyles.None, CultureInfo.InvariantCulture, out offset) ||
                        offset > PropertySchema.MaxDefinitions))
                        throw new BusinessException(Rejection.Invalid, "Invalid saved property cursor.");
                    var page = await new PropertyStore(db, tx, actor).ReadSnapshot(id, sourceRevision, offset, ct);
                    SiteSessions.RequireCurrent(actor.Id, Store.TokenDigest(token)!, handle);
                    return Results.Bytes(Wire.EncodePropertyEditor(page), Aeds.ContentType);
                }
                if (map == "body-edit")
                {
                    var chain = await ArticleBodyInsertionStore.ReadEditChain(db, tx, id, expected, sourceRevision, ct);
                    SiteSessions.RequireCurrent(actor.Id, Store.TokenDigest(token)!, handle);
                    return Results.Bytes(Wire.EncodeDraftRevisionBodyEditChain(chain), Aeds.ContentType);
                }
                if (map == "body-chain")
                {
                    var chain = await ArticleBodyInsertionStore.ReadChain(db, tx, id, expected, sourceRevision, ct);
                    SiteSessions.RequireCurrent(actor.Id, Store.TokenDigest(token)!, handle);
                    return Results.Bytes(Wire.EncodeDraftRevisionBodyInsertionChain(chain), Aeds.ContentType);
                }
                if (map is not null)
                {
                    var proof = await ArticleBodyInsertionStore.Read(db, tx, id, expected, sourceRevision, ct);
                    SiteSessions.RequireCurrent(actor.Id, Store.TokenDigest(token)!, handle);
                    return Results.Bytes(Wire.EncodeDraftRevisionBodyInsertion(proof), Aeds.ContentType);
                }
                var current = await RevisionHistoryStore.ReadSource(db, tx, id, expected, ct);
                var source = await RevisionHistoryStore.ReadSource(db, tx, id, sourceRevision, ct);
                var comparison = new RevisionComparison(id, expected, sourceRevision, current.Title, current.Body, source.Title, source.Body);
                if (handle is not null) SiteSessions.RequireCurrent(actor.Id, Store.TokenDigest(token)!, handle);
                return Results.Bytes(Wire.EncodeRevisionComparison(comparison), Aeds.ContentType);
            }, ct);
        }).RequireRateLimiting("command");

        app.MapPost(WireRoutes.DraftRollback, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var input = Wire.DecodeDraftRollback(await readFrame(ctx, WireLimits.MaxDraftRollbackFrameBytes, ct));
            if (ctx.Request.Headers.TryGetValue(WireHeaders.ClientMutationId, out var header) &&
                (header.Count != 1 || !Guid.TryParseExact(header[0], "D", out var id) || id != input.IdempotencyKey))
                throw new BusinessException(Rejection.Invalid, "Command key does not match its request header.");
            return await store.WithSession(ctx.Request.Cookies[cookie], true, async (db, tx, actor) =>
            {
                var result = await Store.RollbackDraft(db, tx, actor, input, ct);
                var response = new Draft(result.Id, result.Revision, result.Title, result.Body, result.PublishedRevision is not null);
                return Results.Bytes(Wire.EncodeDraft(response), Aeds.ContentType);
            }, ct);
        }).RequireRateLimiting("command");

        long Expected(HttpContext ctx, int id)
        {
            if (id <= 0 || !long.TryParse(query(ctx, "revision", 19), NumberStyles.None, CultureInfo.InvariantCulture, out var revision) ||
                revision <= 0)
                throw new BusinessException(Rejection.Invalid, "A valid draft revision is required.");
            return revision;
        }
    }
}
