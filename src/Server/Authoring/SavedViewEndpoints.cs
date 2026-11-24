namespace FsusBlog.V2.Server.Authoring;

internal static class SavedViewEndpoints
{
    internal const string PlacementUnavailable = "Saved view placement storage is unavailable.";

    internal static void Map(WebApplication app, string cookie)
    {
        app.MapCommandGet(WireRoutes.SavedViews, (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var after = ServerHttp.Query(ctx, "after", 36);
            var version = ServerHttp.Query(ctx, "revision", 19);
            Guid id = Guid.Empty;
            long revision = 0;
            if (after is not null && (!Guid.TryParseExact(after, "D", out id) || id == Guid.Empty ||
                !long.TryParse(version, NumberStyles.None, CultureInfo.InvariantCulture, out revision) || revision <= 0) ||
                after is null && version is not null)
                throw new BusinessException(Rejection.Invalid, "Invalid saved view catalog page.");
            return Run(ctx, store, async (view, _, token) => Wire.EncodeSavedViewCatalog(await view.List(id, revision, token)), ct);
        });

        app.MapCommandPost(WireRoutes.SavedViews, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var command = Wire.DecodeSavedViewCommand(await ServerHttp.ReadFrame(ctx, WireLimits.SavedViewKeywordCommandFrameBytes, ct));
            return await Run(ctx, store, async (view, _, token) => Wire.EncodeSavedViewReceipt(await view.Change(command, token)), ct);
        });

        app.MapCommandPost(WireRoutes.SavedViewExecute, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var command = Wire.DecodeSavedViewExecute(await ServerHttp.ReadFrame(ctx, WireLimits.SavedViewExecuteFrameBytes, ct));
            return await Run(ctx, store, async (view, session, token) => Wire.EncodePropertyArticlePage(await view.Open(command, session, token)), ct);
        });

        app.MapCommandGet(WireRoutes.SavedViewPlacement, (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var view = ServerHttp.Query(ctx, "view", 36);
            var schema = ServerHttp.Query(ctx, "viewSchema", 9);
            var skip = ServerHttp.Query(ctx, "offset", 4);
            var version = ServerHttp.Query(ctx, "revision", 19);
            var id = Guid.Empty;
            var offset = 0;
            long revision = 0;
            if (ctx.Request.Query.Keys.Any(key => key is not ("view" or "viewSchema" or "offset" or "revision")) ||
                view is not null && (!Guid.TryParseExact(view, "D", out id) || id == Guid.Empty || schema != "1" || skip is not null) ||
                view is null && schema is not null ||
                skip is not null && (!int.TryParse(skip, NumberStyles.None, CultureInfo.InvariantCulture, out offset) ||
                    offset <= 0 || offset >= WireLimits.SavedViewMaxCount || offset % WireLimits.SavedViewPageSize != 0 ||
                    !long.TryParse(version, NumberStyles.None, CultureInfo.InvariantCulture, out revision) || revision <= 0) ||
                skip is null && version is not null)
                throw new BusinessException(Rejection.Invalid, "Invalid saved view link or placement page.");
            return Run(ctx, store, async (saved, _, token) => Wire.EncodeSavedViewPlacement(await saved.Placement(id, offset, revision, token)), ct,
                placement: true);
        });

        app.MapCommandPost(WireRoutes.SavedViewPlacement, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var command = Wire.DecodeSavedViewPlacementCommand(await ServerHttp.ReadFrame(ctx, WireLimits.SavedViewPlacementFrameBytes, ct));
            return await Run(ctx, store, async (view, _, token) => Wire.EncodeSavedViewReceipt(await view.ChangePlacement(command, token)), ct,
                placement: true);
        });

        Task<IResult> Run(HttpContext ctx, Store store, Func<SavedViewStore, string, CancellationToken, Task<byte[]>> operation, CancellationToken ct,
            bool placement = false)
        {
            var token = ctx.Request.Cookies[cookie];
            var expected = SiteSessions.Requested(ctx);
            return SiteSessions.WithCurrentAuthor<IResult>(store, token, expected, async (db, tx, actor, _) =>
            {
                if (!await CurrentSchema.HasSavedViewsAsync(db, tx, ct))
                    throw new BusinessException(Rejection.NotFound, "Saved view storage is unavailable.");
                if (placement && !await CurrentSchema.HasSavedViewPlacementAsync(db, tx, ct))
                    throw new BusinessException(Rejection.NotFound, PlacementUnavailable);
                var site = await CurrentSchema.ReadRecoverySiteIdAsync(db, tx, ct);
                var data = await operation(new SavedViewStore(db, tx, actor, site), expected!, ct);
                return ServerHttp.Frame(data);
            }, ct);
        }
    }
}
