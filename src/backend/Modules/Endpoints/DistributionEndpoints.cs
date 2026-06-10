using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Services.Distribution;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace FsusBlog.Server.Modules.Endpoints;

public static class DistributionEndpoints
{
    public static IEndpointRouteBuilder MapDistributionEndpoints(this IEndpointRouteBuilder app)
    {
        app.MapGet("/feed/rss.xml", async (HttpContext ctx, BlogDistributionService service, CancellationToken cancellationToken) =>
            await BuildCachedTextResultAsync(ctx, () => service.BuildRssAsync(cancellationToken), "application/rss+xml; charset=utf-8"))
            .AllowAnonymous()
            .CacheOutput(static builder => ApplyDistributionCache(builder));

        app.MapGet("/api/Article/rss", async (HttpContext ctx, BlogDistributionService service, CancellationToken cancellationToken) =>
            await BuildCachedTextResultAsync(ctx, () => service.BuildRssAsync(cancellationToken), "application/rss+xml; charset=utf-8"))
            .AllowAnonymous()
            .CacheOutput(static builder => ApplyDistributionCache(builder));

        app.MapGet("/feed/atom.xml", async (HttpContext ctx, BlogDistributionService service, CancellationToken cancellationToken) =>
            await BuildCachedTextResultAsync(ctx, () => service.BuildAtomAsync(cancellationToken), "application/atom+xml; charset=utf-8"))
            .AllowAnonymous()
            .CacheOutput(static builder => ApplyDistributionCache(builder));

        app.MapGet("/feed/feed.json", async (HttpContext ctx, BlogDistributionService service, CancellationToken cancellationToken) =>
        {
            string body = JsonSerializer.Serialize(await service.BuildJsonFeedAsync(cancellationToken));
            return BuildCachedTextResult(ctx, body, "application/feed+json; charset=utf-8");
        })
            .AllowAnonymous()
            .CacheOutput(static builder => ApplyDistributionCache(builder));

        app.MapGet("/sitemap.xml", async (HttpContext ctx, BlogDistributionService service, CancellationToken cancellationToken) =>
            await BuildCachedTextResultAsync(ctx, () => service.BuildSitemapAsync(cancellationToken), "application/xml; charset=utf-8"))
            .AllowAnonymous()
            .CacheOutput(static builder => ApplyDistributionCache(builder));

        app.MapGet("/robots.txt", async (HttpContext ctx, BlogDistributionService service, CancellationToken cancellationToken) =>
            await BuildCachedTextResultAsync(ctx, () => service.BuildRobotsAsync(cancellationToken), "text/plain; charset=utf-8"))
            .AllowAnonymous()
            .CacheOutput(static builder => ApplyDistributionCache(builder));

        return app;
    }

    private static void ApplyDistributionCache(Microsoft.AspNetCore.OutputCaching.OutputCachePolicyBuilder builder)
    {
        builder
            .Expire(TimeSpan.FromMinutes(1))
            .Tag(CacheTag.ArticleList.ToOutputCacheTag())
            .Tag(CacheTag.Seo.ToOutputCacheTag());
    }

    private static async Task<IResult> BuildCachedTextResultAsync(HttpContext ctx, Func<Task<string>> build, string contentType)
        => BuildCachedTextResult(ctx, await build(), contentType);

    private static IResult BuildCachedTextResult(HttpContext ctx, string body, string contentType)
    {
        string etag = BuildWeakEtag(body);
        ctx.Response.Headers.CacheControl = "public, max-age=60, stale-while-revalidate=300";
        ctx.Response.Headers.ETag = etag;
        if (RequestHasMatchingEtag(ctx, etag))
        {
            return Results.StatusCode(StatusCodes.Status304NotModified);
        }

        return Results.Content(body, contentType);
    }

    private static string BuildWeakEtag(string body)
    {
        byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes(body));
        return $"W/\"{Convert.ToHexString(hash).ToLowerInvariant()}\"";
    }

    private static bool RequestHasMatchingEtag(HttpContext ctx, string etag)
        => ctx.Request.Headers.IfNoneMatch
            .ToString()
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Any(candidate => string.Equals(candidate, etag, StringComparison.Ordinal));
}
