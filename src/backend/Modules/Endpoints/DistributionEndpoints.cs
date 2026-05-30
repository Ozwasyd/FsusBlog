using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Services.Distribution;

namespace FsusBlog.Server.Modules.Endpoints;

public static class DistributionEndpoints
{
    public static IEndpointRouteBuilder MapDistributionEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/feed/rss.xml", async (HttpContext ctx, BlogDistributionService service, CancellationToken cancellationToken) =>
            Results.Content(await BuildNoCacheTextAsync(ctx, () => service.BuildRssAsync(cancellationToken)), "application/rss+xml; charset=utf-8"))
            .AllowAnonymous()
            .CacheOutput(static builder => ApplyDistributionCache(builder));

        app.MapGet("/api/Article/rss", async (HttpContext ctx, BlogDistributionService service, CancellationToken cancellationToken) =>
            Results.Content(await BuildNoCacheTextAsync(ctx, () => service.BuildRssAsync(cancellationToken)), "application/rss+xml; charset=utf-8"))
            .AllowAnonymous()
            .CacheOutput(static builder => ApplyDistributionCache(builder));

        app.MapGet("/feed/atom.xml", async (HttpContext ctx, BlogDistributionService service, CancellationToken cancellationToken) =>
            Results.Content(await BuildNoCacheTextAsync(ctx, () => service.BuildAtomAsync(cancellationToken)), "application/atom+xml; charset=utf-8"))
            .AllowAnonymous()
            .CacheOutput(static builder => ApplyDistributionCache(builder));

        app.MapGet("/feed/feed.json", async (HttpContext ctx, BlogDistributionService service, CancellationToken cancellationToken) =>
        {
            ApplyNoCacheHeaders(ctx);
            return Results.Json(await service.BuildJsonFeedAsync(cancellationToken), contentType: "application/feed+json; charset=utf-8");
        })
            .AllowAnonymous()
            .CacheOutput(static builder => ApplyDistributionCache(builder));

        app.MapGet("/sitemap.xml", async (HttpContext ctx, BlogDistributionService service, CancellationToken cancellationToken) =>
            Results.Content(await BuildNoCacheTextAsync(ctx, () => service.BuildSitemapAsync(cancellationToken)), "application/xml; charset=utf-8"))
            .AllowAnonymous()
            .CacheOutput(static builder => ApplyDistributionCache(builder));

        app.MapGet("/robots.txt", async (HttpContext ctx, BlogDistributionService service, CancellationToken cancellationToken) =>
            Results.Text(await BuildNoCacheTextAsync(ctx, () => service.BuildRobotsAsync(cancellationToken)), "text/plain; charset=utf-8"))
            .AllowAnonymous()
            .CacheOutput(static builder => ApplyDistributionCache(builder));

        app.MapGet("/api/public/articles/{articleId:int}/related", async (
            int articleId,
            RelatedReadingService service,
            CancellationToken cancellationToken) =>
        {
            RelatedReadingResponse? response = await service.BuildAsync(articleId, cancellationToken);
            if (response is null)
            {
                return Results.NotFound(JsonApiResponse<RelatedReadingResponse>.Fail("article_not_found"));
            }

            return Results.Ok(JsonApiResponse<RelatedReadingResponse>.Ok(response));
        }).AllowAnonymous();

        return app;
    }

    private static void ApplyDistributionCache(Microsoft.AspNetCore.OutputCaching.OutputCachePolicyBuilder builder)
    {
        builder
            .Expire(TimeSpan.FromMinutes(1))
            .Tag(CacheTag.ArticleList.ToOutputCacheTag())
            .Tag(CacheTag.Seo.ToOutputCacheTag());
    }

    private static async Task<string> BuildNoCacheTextAsync(HttpContext ctx, Func<Task<string>> build)
    {
        ApplyNoCacheHeaders(ctx);
        return await build();
    }

    private static void ApplyNoCacheHeaders(HttpContext ctx)
    {
        ctx.Response.Headers["Cache-Control"] = "no-cache";
        ctx.Response.Headers.Remove("ETag");
        ctx.Response.Headers.Remove("Last-Modified");
    }
}
