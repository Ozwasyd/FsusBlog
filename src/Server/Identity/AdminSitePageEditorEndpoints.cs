using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server.Content;
using FsusBlog.V2.Server.Security;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminSitePageEditorEndpoints
{
    internal static void Map(WebApplication app, Uri origin, AdminPasskeyStore store, string session, string passkeyLimit,
        Func<HttpContext, int, CancellationToken, Task<byte[]>> readFrame)
    {
        var authority = origin.GetLeftPart(UriPartial.Authority);
        app.MapGet(WireRoutes.AdminSitePageRevision, async (HttpContext ctx, SitePages pages, string slug, CancellationToken ct) =>
            Frame(Wire.EncodeAdminSitePageRevision(await store.CurrentSitePage(ctx.Request.Cookies[session], pages, slug, ct))))
            .RequireRateLimiting("query");

        app.MapPost(WireRoutes.AdminSitePageStepUpBegin, async (HttpContext ctx, SitePages pages, CancellationToken ct) =>
        {
            AdminModerationEndpoints.RequireOrigin(ctx, authority);
            var frame = await readFrame(ctx, WireLimits.AdminSitePagePublishFrameBytes, ct);
            var intent = Wire.DecodeAdminSitePagePublish(frame);
            return Frame(await store.BeginSitePageStepUp(ctx.Request.Cookies[session], pages, intent, ct));
        }).RequireRateLimiting(passkeyLimit);
        app.MapPost(WireRoutes.AdminSitePageStepUpComplete, async (HttpContext ctx, CancellationToken ct) =>
        {
            AdminModerationEndpoints.RequireOrigin(ctx, authority);
            var frame = await readFrame(ctx, WireLimits.MaxPasskeyFrameBytes, ct);
            var assertion = PasskeyWire.ReadLogin(frame, discoverable: false);
            return Frame(await store.CompleteSitePageStepUp(ctx.Request.Cookies[session], assertion, ct));
        }).RequireRateLimiting(passkeyLimit);

        app.MapPost(WireRoutes.AdminSitePagePow, (HttpContext ctx, SitePages pages, ScopedPow pow, CancellationToken ct) =>
            ScopedPow.Protect(ctx, async () =>
            {
                AdminModerationEndpoints.RequireOrigin(ctx, authority);
                var frame = await readFrame(ctx, WireLimits.AdminSitePagePublishFrameBytes, ct);
                var intent = Wire.DecodeAdminSitePagePublish(frame);
                return await store.IssueSitePagePow(ctx.Request.Cookies[session], pages, intent, frame, pow, ctx, ct);
            }, PowScope.AdminSitePagePublish)).RequireRateLimiting("command");

        app.MapPost(WireRoutes.AdminSitePagePublish, (HttpContext ctx, SitePages pages, ScopedPow pow, CancellationToken ct) =>
            ScopedPow.Protect(ctx, async () =>
            {
                AdminModerationEndpoints.RequireOrigin(ctx, authority);
                var frame = await readFrame(ctx, WireLimits.AdminSitePagePublishFrameBytes, ct);
                var intent = Wire.DecodeAdminSitePagePublish(frame);
                var proof = ctx.Request.Headers[WireHeaders.MfaProof] is { Count: 1 } value ? value[0] : null;
                await store.PublishSitePage(ctx.Request.Cookies[session], pages, intent, frame, proof, pow, ctx, ct);
                return Wire.EncodeEmptySuccess();
            }, PowScope.AdminSitePagePublish)).RequireRateLimiting("command");
    }

    private static IResult Frame(byte[] frame) => Results.Bytes(frame, Aeds.ContentType);
}
