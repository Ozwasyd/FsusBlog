using System.Text.Json;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Services.Distribution;

namespace FsusBlog.Server.Modules.Endpoints;

public static class DistributionEndpoints
{
    private const string DistributionVaryHeader = "Accept-Encoding, CF-IPCountry, X-Fsus-Region";
    private static readonly CacheTag[] s_distributionOutputCacheTags = [CacheTag.ArticleList, CacheTag.Seo];
    private static readonly CacheTag[] s_sitemapOutputCacheTags = [.. s_distributionOutputCacheTags, CacheTag.SystemPage];

    internal static IReadOnlyList<CacheTag> SitemapOutputCacheTags => s_sitemapOutputCacheTags;

    public static IEndpointRouteBuilder MapDistributionEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/feed/rss.xml", async (HttpContext ctx, BlogDistributionService service, CancellationToken cancellationToken) =>
            await BuildCachedTextResultAsync(ctx, () => service.BuildRssAsync(cancellationToken), "application/rss+xml; charset=utf-8"))
            .AllowAnonymous()
            .AllowPublicResponseCompression()
            .CacheOutput(static builder => ApplyDistributionCache(builder));

        app.MapGet("/api/Article/rss", async (HttpContext ctx, BlogDistributionService service, CancellationToken cancellationToken) =>
            await BuildCachedTextResultAsync(ctx, () => service.BuildRssAsync(cancellationToken), "application/rss+xml; charset=utf-8"))
            .AllowAnonymous()
            .AllowPublicResponseCompression()
            .CacheOutput(static builder => ApplyDistributionCache(builder));

        app.MapGet("/feed/atom.xml", async (HttpContext ctx, BlogDistributionService service, CancellationToken cancellationToken) =>
            await BuildCachedTextResultAsync(ctx, () => service.BuildAtomAsync(cancellationToken), "application/atom+xml; charset=utf-8"))
            .AllowAnonymous()
            .AllowPublicResponseCompression()
            .CacheOutput(static builder => ApplyDistributionCache(builder));

        app.MapGet("/feed/feed.json", async (HttpContext ctx, BlogDistributionService service, CancellationToken cancellationToken) =>
        {
            string body = JsonSerializer.Serialize(await service.BuildJsonFeedAsync(cancellationToken));
            return BuildCachedTextResult(ctx, body, "application/feed+json; charset=utf-8");
        })
            .AllowAnonymous()
            .AllowPublicResponseCompression()
            .CacheOutput(static builder => ApplyDistributionCache(builder));

        app.MapGet("/sitemap.xml", async (HttpContext ctx, BlogDistributionService service, CancellationToken cancellationToken) =>
            await BuildCachedTextResultAsync(ctx, () => service.BuildSitemapAsync(cancellationToken), "application/xml; charset=utf-8"))
            .AllowAnonymous()
            .AllowPublicResponseCompression()
            .CacheOutput(static builder => ApplySitemapCache(builder));

        app.MapGet("/sitemap/{page:int}.xml", async (int page, HttpContext ctx, BlogDistributionService service, CancellationToken cancellationToken) =>
        {
            string? body = await service.BuildSitemapPageAsync(page, cancellationToken);
            return body is null
                ? Results.NotFound()
                : BuildCachedTextResult(ctx, body, "application/xml; charset=utf-8");
        })
            .AllowAnonymous()
            .AllowPublicResponseCompression()
            .CacheOutput(static builder => ApplySitemapCache(builder));

        app.MapGet("/robots.txt", async (HttpContext ctx, BlogDistributionService service, CancellationToken cancellationToken) =>
            await BuildCachedTextResultAsync(ctx, () => service.BuildRobotsAsync(cancellationToken), "text/plain; charset=utf-8"))
            .AllowAnonymous()
            .AllowPublicResponseCompression()
            .CacheOutput(static builder => ApplyDistributionCache(builder));

        return app;
    }

    private static void ApplyDistributionCache(Microsoft.AspNetCore.OutputCaching.OutputCachePolicyBuilder builder)
        => ApplyDistributionCache(builder, s_distributionOutputCacheTags);

    private static void ApplySitemapCache(Microsoft.AspNetCore.OutputCaching.OutputCachePolicyBuilder builder)
        => ApplyDistributionCache(builder, s_sitemapOutputCacheTags);

    private static void ApplyDistributionCache(
        Microsoft.AspNetCore.OutputCaching.OutputCachePolicyBuilder builder,
        IReadOnlyList<CacheTag> tags)
    {
        builder.Expire(TimeSpan.FromMinutes(1));
        foreach (CacheTag tag in tags)
        {
            builder.Tag(tag.ToOutputCacheTag());
        }
    }

    private static async Task<IResult> BuildCachedTextResultAsync(HttpContext ctx, Func<Task<string>> build, string contentType)
        => BuildCachedTextResult(ctx, await build(), contentType);

    private static IResult BuildCachedTextResult(HttpContext ctx, string body, string contentType)
    {
        ctx.Response.Headers.CacheControl = "public, max-age=60, stale-while-revalidate=300";
        ctx.Response.Headers.Vary = DistributionVaryHeader;

        return Results.Content(body, contentType);
    }
}
