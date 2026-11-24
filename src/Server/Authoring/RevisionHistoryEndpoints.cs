namespace FsusBlog.V2.Server.Authoring;

internal static class RevisionHistoryEndpoints
{
    internal static void Map(WebApplication app, string cookie, Func<HttpContext, string, int, string?> query,
        DraftMutationRoutes mutations)
    {
        app.MapCommandGet(WireRoutes.DraftRevisionHistory, (HttpContext ctx, Store store, int id, CancellationToken ct) =>
        {
            var expected = DraftRevisionQuery.Read(ctx, id, query);
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
                return ServerHttp.Frame(Wire.EncodeRevisionHistory(page));
            }, ct);
        });

        app.MapCommandGet(WireRoutes.DraftRevisionComparison, (HttpContext ctx, Store store, int id, long sourceRevision, CancellationToken ct) =>
        {
            var expected = DraftRevisionQuery.Read(ctx, id, query);
            var map = query(ctx, "map", 16);
            if (map is not (null or "body-insertion" or "body-chain" or "body-edit" or "properties" or "metadata"))
                throw new BusinessException(Rejection.Invalid, "Unknown saved revision map.");
            if (sourceRevision <= 0 || sourceRevision > expected || (sourceRevision == expected && map != "properties"))
                throw new BusinessException(Rejection.Invalid, "A historical source revision is required.");
            var token = ctx.Request.Cookies[cookie];
            var handle = SiteSessions.Requested(ctx);
            return store.WithSession(token, true, async (db, tx, actor) =>
            {
                var requireCurrent = handle is not null || map is not null;
                var digest = requireCurrent ? Store.TokenDigest(token)! : null;
                if (requireCurrent) SiteSessions.RequireCurrent(actor.Id, digest!, handle);
                await RevisionHistoryStore.LockCurrent(db, tx, actor, id, expected, ct);
                if (map == "metadata")
                {
                    ctx.Response.Headers.CacheControl = "no-store";
                    var metadata = await RevisionHistoryStore.ReadMetadata(db, tx, id, expected, sourceRevision, ct);
                    await Content.ArticleMediaStore.WriteCoverHeaders(db, tx, ctx.Response, id, expected, ct, sourceRevision);
                    return Reply(metadata, pair => Wire.EncodeRevisionMetadataComparison(id, expected, sourceRevision, pair.Current, pair.Source));
                }
                if (map == "properties")
                {
                    var cursor = query(ctx, "offset", 4);
                    int offset = 0;
                    if (cursor is not null && (!int.TryParse(cursor, NumberStyles.None, CultureInfo.InvariantCulture, out offset) ||
                        offset > PropertySchema.MaxDefinitions))
                        throw new BusinessException(Rejection.Invalid, "Invalid saved property cursor.");
                    return Reply(await new PropertyStore(db, tx, actor).ReadSnapshot(id, sourceRevision, offset, ct), Wire.EncodePropertyEditor);
                }
                if (map == "body-edit")
                    return Reply(await ArticleBodyInsertionStore.ReadEditChain(db, tx, id, expected, sourceRevision, ct), Wire.EncodeDraftRevisionBodyEditChain);
                if (map == "body-chain")
                    return Reply(await ArticleBodyInsertionStore.ReadChain(db, tx, id, expected, sourceRevision, ct), Wire.EncodeDraftRevisionBodyInsertionChain);
                if (map is not null)
                    return Reply(await ArticleBodyInsertionStore.Read(db, tx, id, expected, sourceRevision, ct), Wire.EncodeDraftRevisionBodyInsertion);
                var current = await RevisionHistoryStore.ReadSource(db, tx, id, expected, ct);
                var source = await RevisionHistoryStore.ReadSource(db, tx, id, sourceRevision, ct);
                var comparison = new RevisionComparison(id, expected, sourceRevision, current.Title, current.Body, source.Title, source.Body);
                return Reply(comparison, Wire.EncodeRevisionComparison);

                IResult Reply<T>(T data, Func<T, byte[]> encode)
                {
                    if (requireCurrent) SiteSessions.RequireCurrent(actor.Id, digest!, handle);
                    return ServerHttp.Frame(encode(data));
                }
            }, ct);
        });

        mutations.MapRollback();
    }
}
