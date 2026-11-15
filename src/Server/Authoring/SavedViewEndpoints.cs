using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Sessions;
using FsusBlogV2.Storage;

namespace FsusBlog.V2.Server.Authoring;

internal static class SavedViewEndpoints
{
    internal const string PlacementUnavailable = "Saved view placement storage is unavailable.";

    internal static void Map(WebApplication app, string cookie, Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame,
        Func<HttpContext, string, int, string?> query)
    {
        app.MapGet(WireRoutes.SavedViews, (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var after = query(ctx, "after", 36);
            var version = query(ctx, "revision", 19);
            Guid id = Guid.Empty;
            long revision = 0;
            if (after is not null && (!Guid.TryParseExact(after, "D", out id) || id == Guid.Empty ||
                !long.TryParse(version, NumberStyles.None, CultureInfo.InvariantCulture, out revision) || revision <= 0) ||
                after is null && version is not null)
                throw new BusinessException(Rejection.Invalid, "Invalid saved view catalog page.");
            return Run(ctx, store, async (view, _, token) => Wire.EncodeSavedViewCatalog(await view.List(id, revision, token)), ct);
        }).RequireRateLimiting("command");

        app.MapPost(WireRoutes.SavedViews, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var command = Wire.DecodeSavedViewCommand(await readFrame(ctx, WireLimits.SavedViewKeywordCommandFrameBytes, ct));
            return await Run(ctx, store, async (view, _, token) => Wire.EncodeSavedViewReceipt(await view.Change(command, token)), ct);
        }).RequireRateLimiting("command");

        app.MapPost(WireRoutes.SavedViewExecute, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var command = Wire.DecodeSavedViewExecute(await readFrame(ctx, WireLimits.SavedViewExecuteFrameBytes, ct));
            return await Run(ctx, store, async (view, session, token) => Wire.EncodePropertyArticlePage(await view.Open(command, session, token)), ct);
        }).RequireRateLimiting("command");

        app.MapGet(WireRoutes.SavedViewPlacement, (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var view = query(ctx, "view", 36);
            var schema = query(ctx, "viewSchema", 9);
            var skip = query(ctx, "offset", 4);
            var version = query(ctx, "revision", 19);
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
        }).RequireRateLimiting("command");

        app.MapPost(WireRoutes.SavedViewPlacement, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var command = Wire.DecodeSavedViewPlacementCommand(await readFrame(ctx, WireLimits.SavedViewPlacementFrameBytes, ct));
            return await Run(ctx, store, async (view, _, token) => Wire.EncodeSavedViewReceipt(await view.ChangePlacement(command, token)), ct,
                placement: true);
        }).RequireRateLimiting("command");

        Task<IResult> Run(HttpContext ctx, Store store, Func<SavedViewStore, string, CancellationToken, Task<byte[]>> operation, CancellationToken ct,
            bool placement = false)
        {
            var token = ctx.Request.Cookies[cookie];
            var expected = ctx.Request.Headers[WireHeaders.CurrentSession] is { Count: 1 } header ? header[0] : null;
            return store.WithSession<IResult>(token, true, async (db, tx, actor) =>
            {
                SiteSessions.RequireCurrent(actor.Id, Store.TokenDigest(token)!, expected);
                if (!await CurrentSchema.HasSavedViewsAsync(db, tx, ct))
                    throw new BusinessException(Rejection.NotFound, "Saved view storage is unavailable.");
                if (placement && !await CurrentSchema.HasSavedViewPlacementAsync(db, tx, ct))
                    throw new BusinessException(Rejection.NotFound, PlacementUnavailable);
                var site = await CurrentSchema.ReadRecoverySiteIdAsync(db, tx, ct);
                var data = await operation(new SavedViewStore(db, tx, actor, site), expected!, ct);
                return Results.Bytes(data, Aeds.ContentType);
            }, ct);
        }
    }
}
