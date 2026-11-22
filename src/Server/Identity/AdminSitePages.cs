using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server.Content;
using FsusBlogV2.Storage;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminSitePages
{
    internal const string LegacyPrefix = "/api/binary/system/admin/page";

    internal static bool IsLegacyRoute(PathString path)
    {
        if (path == WireRoutes.AdminLegacySitePageUpdate || path == WireRoutes.AdminLegacySitePageUpdate + "/")
            return true;
        if (!path.StartsWithSegments(LegacyPrefix, out var remaining) || remaining.Value is not { Length: > 1 } segment)
            return false;
        // Routing accepts an optional trailing slash. Guard both forms on the public origin.
        var slug = segment.AsSpan(1);
        return !slug.TrimEnd('/').IsEmpty && !slug.TrimEnd('/').Contains('/');
    }

    internal static void Map(WebApplication app, AdminSitePageStore store, string session)
    {
        app.MapCommandGet(WireRoutes.AdminSitePages, async (HttpContext ctx, SitePages pages, CancellationToken ct) =>
        {
            var frame = await store.SitePagesOverview(ctx.Request.Cookies[session], pages, ct);
            if (pages.EditorEnabled) ctx.Response.Headers[WireHeaders.AdminSitePageEditor] = "1";
            return ServerHttp.Frame(frame);
        });
        app.MapCommandGet(WireRoutes.AdminSitePage, async (HttpContext ctx, SitePages pages, string slug, CancellationToken ct) =>
            ServerHttp.Frame(await store.SitePage(ctx.Request.Cookies[session], pages, slug, ct)));

        app.MapCommandGet(LegacyPrefix + "/{slug}", async (HttpContext ctx, SitePages pages, string slug, CancellationToken ct) =>
        {
            var token = ctx.Request.Cookies[session];
            if (!pages.EditorEnabled) return ServerHttp.Frame(await store.SitePage(token, pages, slug, ct));
            var page = await store.CurrentSitePage(token, pages, slug, ct);
            ctx.Response.Headers.ETag = FormattableString.Invariant($"\"{page.Slug}.{page.Revision}.{page.Digest}\"");
            return ServerHttp.Frame(SitePageWire.Encode(page.Slug, page.Markdown));
        });
    }
}
