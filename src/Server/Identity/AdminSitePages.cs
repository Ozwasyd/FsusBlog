using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server.Content;
using FsusBlogV2.Storage;

namespace FsusBlog.V2.Server.Administration;

internal static class AdminSitePages
{
    internal const string LegacyPrefix = "/api/binary/system/admin/page";

    internal static bool IsLegacyRoute(PathString path)
    {
        if (!path.StartsWithSegments(LegacyPrefix, out var remaining) || remaining.Value is not { Length: > 1 } segment)
            return false;
        // Routing accepts an optional trailing slash. Guard both forms on the public origin.
        var slug = segment.AsSpan(1);
        return !slug.TrimEnd('/').IsEmpty && !slug.TrimEnd('/').Contains('/');
    }

    internal static void Map(WebApplication app, AdminPasskeyStore store, string session)
    {
        app.MapGet(WireRoutes.AdminSitePages, async (HttpContext ctx, SitePages pages, CancellationToken ct) =>
            Results.Bytes(await store.SitePagesOverview(ctx.Request.Cookies[session], pages, ct), Aeds.ContentType))
            .RequireRateLimiting("command");
        foreach (var route in new[] { WireRoutes.AdminSitePage, LegacyPrefix + "/{slug}" })
        {
            app.MapGet(route, async (HttpContext ctx, SitePages pages, string slug, CancellationToken ct) =>
                Results.Bytes(await store.SitePage(ctx.Request.Cookies[session], pages, slug, ct), Aeds.ContentType))
                .RequireRateLimiting("command");
        }
    }
}

internal sealed partial class AdminPasskeyStore
{
    internal Task<byte[]> SitePagesOverview(string? token, SitePages pages, CancellationToken ct) =>
        WithSession(token, CurrentSchema.SystemConfigPermission, (_, _, _) =>
            Task.FromResult(Wire.EncodeAdminSitePages(new(pages.ConfiguredMask))), ct);

    internal Task<byte[]> SitePage(string? token, SitePages pages, string slug, CancellationToken ct) =>
        WithSession(token, CurrentSchema.SystemConfigPermission, (_, _, _) => Task.FromResult(pages.ConfiguredPage(slug)), ct);
}
