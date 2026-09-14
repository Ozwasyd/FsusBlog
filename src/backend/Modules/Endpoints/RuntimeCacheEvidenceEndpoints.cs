using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Testing;

namespace FsusBlog.Server.Modules.Endpoints;

internal static class RuntimeCacheEvidenceEndpoints
{
    private const string Route = "/_fsus/testing/runtime-cache/observations/{requestId}";

    internal static WebApplication MapRuntimeCacheEvidenceEndpoints(this WebApplication app)
    {
        if ((!app.Environment.IsDevelopment() && !app.Environment.IsEnvironment("Test")) ||
            string.IsNullOrWhiteSpace(app.Configuration[RuntimeCacheEvidenceMiddleware.SecretConfigurationKey]))
        {
            return app;
        }

        app.MapGet(Route, TakeObservation)
            .AllowAnonymous()
            .WithMetadata(new FsusRouteKindMetadata("testing"));
        return app;
    }

    private static IResult TakeObservation(
        HttpContext context,
        string requestId,
        RuntimeCacheEvidenceStore store,
        IConfiguration configuration)
    {
        string secret = configuration[RuntimeCacheEvidenceMiddleware.SecretConfigurationKey] ?? string.Empty;
        if (!SecretEquals(secret, context.Request.Headers[RuntimeCacheEvidenceMiddleware.SecretHeader].ToString()))
        {
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        }

        return store.TryTake(requestId, out RuntimeCacheRequestObservation? observation)
            ? Results.Ok(observation)
            : Results.NotFound();
    }

    private static bool SecretEquals(string expected, string provided)
    {
        byte[] left = Encoding.UTF8.GetBytes(expected);
        byte[] right = Encoding.UTF8.GetBytes(provided);
        return left.Length > 0 && left.Length == right.Length &&
            CryptographicOperations.FixedTimeEquals(left, right);
    }
}
