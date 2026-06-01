using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Models.Dtos;

namespace FsusBlog.Server.Modules.Endpoints;

public static class PublicAotEndpoints
{
    private const string ManifestTokenHeader = "X-Fsus-Public-Aot-Token";

    public static IEndpointRouteBuilder MapPublicAotEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/internal/public-aot")
            .WithTags("PublicAot")
            .AllowAnonymous()
            .WithMetadata(new FsusRouteKindMetadata("api"));

        group.MapGet("/manifest", async (
            HttpContext context,
            string? scope,
            string? changedSince,
            IPublicAotRouteManifestProvider manifestProvider,
            IConfiguration configuration,
            CancellationToken cancellationToken) =>
        {
            if (!IsManifestRequestAuthorized(context, configuration))
            {
                return Results.StatusCode(StatusCodes.Status403Forbidden);
            }

            PublicAotRouteManifestScope manifestScope = PublicAotRouteManifestScope.FromQuery(scope, changedSince);
            IReadOnlyList<PublicAotRouteDescriptor> routes = await manifestProvider
                .ListRoutesAsync(manifestScope, cancellationToken)
                .ConfigureAwait(false);
            var response = new PublicAotRouteManifestResponse(
                manifestScope.Scope,
                DateTimeOffset.UtcNow,
                routes);

            context.Response.Headers["Cache-Control"] = "no-store";
            return Results.Ok(JsonApiResponse<PublicAotRouteManifestResponse>.Ok(response));
        });

        return app;
    }

    private static bool IsManifestRequestAuthorized(HttpContext context, IConfiguration configuration)
    {
        string? requiredToken = configuration["PublicAot:ManifestToken"];
        if (string.IsNullOrWhiteSpace(requiredToken))
        {
            return true;
        }

        return context.Request.Headers.TryGetValue(ManifestTokenHeader, out var providedToken) &&
            string.Equals(providedToken.ToString(), requiredToken.Trim(), StringComparison.Ordinal);
    }
}
