using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Services;

using Microsoft.AspNetCore.Mvc;

namespace FsusBlog.Server.Modules.Endpoints;

internal static class CacheMissSingleFlightScenarioEndpoints
{
    private const string Route = "/_fsus/testing/runtime-cache/scenarios/cache-miss-singleflight/{articleId:int}";

    internal static WebApplication MapCacheMissSingleFlightScenarioEndpoints(this WebApplication app)
    {
        app.MapGet(Route, ExecuteAsync)
            .AllowAnonymous()
            .WithMetadata(new FsusRouteKindMetadata("testing"));
        app.MapDelete(Route, ResetAsync)
            .AllowAnonymous()
            .WithMetadata(new FsusRouteKindMetadata("testing"));
        return app;
    }

    private static async Task<IResult> ExecuteAsync(
        HttpContext context,
        int articleId,
        [FromServices] ArticleService articles,
        [FromServices] IConfiguration configuration,
        CancellationToken cancellationToken)
    {
        if (!IsAuthenticated(context, configuration))
        {
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        }

        var detail = await articles.GetByIdAsync(
            articleId,
            includePrivate: false,
            cancellationToken).ConfigureAwait(false);
        return detail is null
            ? Results.NotFound()
            : Results.Bytes(
                ServerCacheBinaryCodec.EncodeArticleDetail(detail),
                "application/octet-stream");
    }

    private static async Task<IResult> ResetAsync(
        HttpContext context,
        int articleId,
        [FromServices] ICacheInvalidationStore cache,
        [FromServices] CacheSingleFlightCoordinator singleFlight,
        [FromServices] IConfiguration configuration,
        CancellationToken cancellationToken)
    {
        if (!IsAuthenticated(context, configuration))
        {
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        }

        if (singleFlight.ActiveEntryCount != 0)
        {
            return Results.Conflict(new
            {
                error = "cache_singleflight_not_drained"
            });
        }

        await cache.RemoveAsync(CachePolicyId.ArticleDetail, articleId, cancellationToken)
            .ConfigureAwait(false);
        return Results.NoContent();
    }

    private static bool IsAuthenticated(HttpContext context, IConfiguration configuration)
    {
        string expected = configuration[RuntimeCacheEvidenceMiddleware.SecretConfigurationKey] ?? string.Empty;
        string provided = context.Request.Headers[RuntimeCacheEvidenceMiddleware.SecretHeader].ToString();
        byte[] left = Encoding.UTF8.GetBytes(expected);
        byte[] right = Encoding.UTF8.GetBytes(provided);
        return left.Length > 0
            && left.Length == right.Length
            && CryptographicOperations.FixedTimeEquals(left, right);
    }
}
