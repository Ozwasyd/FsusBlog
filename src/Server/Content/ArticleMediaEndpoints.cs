using System.Globalization;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Sessions;
using FsusBlogV2.Storage;
using Microsoft.AspNetCore.Http.Features;

namespace FsusBlog.V2.Server.Content;

internal static class ArticleMediaEndpoints
{
    internal static void Map(WebApplication app, string cookie, bool publishedMedia)
    {
        app.MapGet(WireRoutes.ArticleMedia, async (int id, HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var revision = Revision(ctx);
            var session = ctx.Request.Cookies[cookie];
            return await store.WithSession(session, true, async (db, tx, actor) =>
            {
                SiteSessions.IfCurrent(actor.Id, session, SiteSessions.Requested(ctx));
                await Authoring.RevisionHistoryStore.LockCurrent(db, tx, actor, id, revision, ct);
                var ids = await ArticleMediaStore.Read(db, tx, id, revision, ct);
                var digest = Store.TokenDigest(session)!;
                var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
                var entries = ids.Select(asset => new ArticleMediaEntry(asset, new ArticleMediaTicket(id, revision, asset).Encode(digest, now))).ToArray();
                if (SiteSessions.Requested(ctx) is not null)
                    await ArticleMediaStore.WriteCoverHeaders(db, tx, ctx.Response, id, revision, ct);
                if (publishedMedia)
                {
                    ctx.Response.Headers[WireHeaders.ArticlePublishImagesEnabled] = "1";
                    if (await CurrentSchema.HasPublicationCoverAsync(db, tx, ct))
                        ctx.Response.Headers[WireHeaders.ArticlePublishCoverEnabled] = "1";
                }
                return Results.Bytes(Wire.EncodeArticleMedia(id, revision, entries), Aeds.ContentType);
            }, ct);
        }).RequireRateLimiting("command");

        app.MapPost(WireRoutes.ArticleMediaCommand, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            var session = ctx.Request.Cookies[cookie];
            if (ctx.Request.ContentType != Aeds.ContentType || ctx.Request.ContentLength != ArticleMediaCommand.FrameBytes)
                throw new BusinessException(Rejection.Invalid, "Expected a bounded private attachment command.");
            if (ctx.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } limit)
                limit.MaxRequestBodySize = ArticleMediaCommand.FrameBytes;
            var frame = new byte[ArticleMediaCommand.FrameBytes];
            await ctx.Request.Body.ReadExactlyAsync(frame, ct);
            var command = Wire.DecodeArticleMediaCommand(frame);
            return await store.WithSession(session, true, async (db, tx, actor) =>
            {
                SiteSessions.RequireCurrent(actor.Id, Store.TokenDigest(session)!,
                    MediaEndpoints.Only(ctx.Request.Headers[WireHeaders.CurrentSession], WireLimits.SiteSessionIdBytes));
                var saved = await Store.SetPrivateAttachment(db, tx, actor, command, ct);
                return Results.Bytes(Wire.EncodeDraft(new(saved.Id, saved.Revision, saved.Title, saved.Body, saved.PublishedRevision is not null)), Aeds.ContentType);
            }, ct);
        }).RequireRateLimiting("command");

        app.MapPost(WireRoutes.ArticleCoverSave, async (HttpContext ctx, Store store, CancellationToken ct) =>
        {
            if (ctx.Request.ContentType != Aeds.ContentType || ctx.Request.ContentLength != ArticleCoverCommand.FrameBytes)
                throw new BusinessException(Rejection.Invalid, "Expected a bounded saved cover command.");
            if (ctx.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } limit)
                limit.MaxRequestBodySize = ArticleCoverCommand.FrameBytes;
            var frame = new byte[ArticleCoverCommand.FrameBytes];
            await ctx.Request.Body.ReadExactlyAsync(frame, ct);
            var command = Wire.DecodeArticleCoverCommand(frame);
            ClientMutationHeader.Require(ctx, command.IdempotencyKey, required: true);
            return await SiteSessions.WithCurrentAuthor(store, ctx.Request.Cookies[cookie], SiteSessions.Requested(ctx), async (db, tx, actor, _) =>
            {
                var saved = await Store.SetCover(db, tx, actor, command, ct);
                return Results.Bytes(Wire.EncodeDraft(new(saved.Id, saved.Revision, saved.Title, saved.Body, saved.PublishedRevision is not null)), Aeds.ContentType);
            }, ct);
        }).RequireRateLimiting("command");

        app.MapMethods(WireRoutes.ArticleMediaPreview, [HttpMethods.Get, HttpMethods.Head], async (
            HttpContext ctx, Store store, MediaStore media, CancellationToken ct) =>
        {
            MediaEndpoints.SetHidden(ctx.Response);
            var authorization = ctx.Request.Headers.Authorization;
            const string scheme = "Bearer ";
            if (Store.TokenDigest(ctx.Request.Cookies[cookie]) is not { } digest ||
                ctx.Request.QueryString.HasValue || authorization.Count != 1 || authorization[0] is not { } header ||
                header.Length != scheme.Length + ArticleMediaTicket.EncodedLength ||
                !header.StartsWith(scheme, StringComparison.OrdinalIgnoreCase) ||
                !ArticleMediaTicket.TryDecode(header[scheme.Length..], digest, DateTimeOffset.UtcNow.ToUnixTimeSeconds(), out var value)) return;
            await MediaEndpoints.ReadPrivate(ctx, store, media, cookie, app.Logger, async (db, tx, actor) =>
                await ArticleMediaStore.Contains(db, tx, actor.Id, value.Article, value.Revision, value.Asset, ct) ? value.Asset : null, ct);
        }).RequireRateLimiting(MediaEndpoints.ReadPolicy).WithMetadata(new MediaEndpoints.PrivateRead());
    }

    private static long Revision(HttpContext ctx) => long.TryParse(MediaEndpoints.Only(ctx.Request.Query["revision"], 19),
        NumberStyles.None, CultureInfo.InvariantCulture, out var revision) && revision > 0
        ? revision : throw new BusinessException(Rejection.Invalid, "A valid draft revision is required.");
}
