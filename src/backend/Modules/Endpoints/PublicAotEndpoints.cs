using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Models.Dtos;
using Microsoft.Extensions.Primitives;

namespace FsusBlog.Server.Modules.Endpoints;

public static class PublicAotEndpoints
{
    private const string ManifestTokenHeader = "X-Fsus-Public-Aot-Token";
    private const int MaxNavigationPathChars = 512;

    public static IEndpointRouteBuilder MapPublicAotEndpoints(this IEndpointRouteBuilder app)
    {
        var publicGroup = app.MapGroup("/api/public")
            .WithTags("PublicAot")
            .AllowAnonymous()
            .WithMetadata(new FsusRouteKindMetadata("api"));

        publicGroup.MapGet("/navigation-snapshot.aeds", async (
            HttpContext context,
            string? path,
            IPublicAotShellService shellService,
            CancellationToken cancellationToken) =>
        {
            if (!RequestAcceptsNavigationSnapshot(context.Request.Headers.Accept))
            {
                context.Response.Headers["Cache-Control"] = "no-store";
                return Results.StatusCode(StatusCodes.Status406NotAcceptable);
            }

            if (!TryCreateNavigationSnapshotTargetContext(context, path, out DefaultHttpContext targetContext, out string targetError) ||
                !shellService.TryResolve(targetContext, out PublicAotRouteMatch match))
            {
                context.Response.Headers["Cache-Control"] = "no-store";
                return Results.StatusCode(string.Equals(targetError, "public_navigation_snapshot_path_invalid", StringComparison.Ordinal)
                    ? StatusCodes.Status400BadRequest
                    : StatusCodes.Status404NotFound);
            }

            var result = await shellService.BuildNavigationSnapshotAsync(context, match, cancellationToken);
            if (result.IsFailure || result.Value is null)
            {
                context.Response.Headers["Cache-Control"] = "no-store";
                return Results.StatusCode(result.Error.Code == FsusBlog.Core.Common.ErrorCode.NotFound
                    ? StatusCodes.Status404NotFound
                    : StatusCodes.Status503ServiceUnavailable);
            }

            PublicAotNavigationSnapshot snapshot = result.Value;
            byte[] frame = snapshot.EncodeFrame();
            string entityTag = PublicAotNavigationSnapshot.CreateEntityTag(frame);
            context.Response.Headers.ETag = entityTag;
            context.Response.Headers.CacheControl = "public, max-age=30, stale-while-revalidate=300";
            context.Response.Headers.Vary = "Accept";
            context.Response.Headers["X-Fsus-Public-Aot-Route-Key"] = snapshot.RouteKey;
            context.Response.Headers["X-Fsus-Public-Aot-Renderer-Version"] = snapshot.RendererVersion;
            context.Response.Headers["X-Fsus-Public-Aot-Frontend-Asset-Version"] = snapshot.FrontendAssetVersion;

            if (RequestEntityTagMatches(context.Request.Headers.IfNoneMatch, entityTag))
            {
                return Results.StatusCode(StatusCodes.Status304NotModified);
            }

            return Results.Bytes(frame, PublicAotNavigationSnapshot.MediaType);
        })
        .RequireRateLimiting("public_read");

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

        group.MapGet("/health", async (
            HttpContext context,
            PublicAotSsrHealthService healthService,
            IConfiguration configuration,
            CancellationToken cancellationToken) =>
        {
            if (!IsManifestRequestAuthorized(context, configuration))
            {
                return Results.StatusCode(StatusCodes.Status403Forbidden);
            }

            PublicAotSsrHealthReport report = await healthService.CheckAsync(cancellationToken).ConfigureAwait(false);
            context.Response.Headers["Cache-Control"] = "no-store";
            return Results.Ok(JsonApiResponse<PublicAotSsrHealthReport>.Ok(report));
        });

        return app;
    }

    internal static bool TryCreateNavigationSnapshotTargetContext(
        HttpContext source,
        string? rawPath,
        out DefaultHttpContext target,
        out string error)
    {
        target = new DefaultHttpContext
        {
            RequestServices = source.RequestServices
        };
        error = string.Empty;

        if (rawPath is not null && rawPath.Length > MaxNavigationPathChars)
        {
            error = "public_navigation_snapshot_path_invalid";
            return false;
        }

        string normalized = rawPath?.Trim() ?? string.Empty;
        if (string.IsNullOrWhiteSpace(normalized) ||
            normalized.Length > MaxNavigationPathChars ||
            !normalized.StartsWith("/", StringComparison.Ordinal) ||
            normalized.StartsWith("//", StringComparison.Ordinal) ||
            normalized.Contains("://", StringComparison.Ordinal) ||
            normalized.Contains('\\', StringComparison.Ordinal) ||
            normalized.Contains('\r', StringComparison.Ordinal) ||
            normalized.Contains('\n', StringComparison.Ordinal))
        {
            error = "public_navigation_snapshot_path_invalid";
            return false;
        }

        int fragmentIndex = normalized.IndexOf('#', StringComparison.Ordinal);
        if (fragmentIndex >= 0)
        {
            normalized = normalized[..fragmentIndex];
        }

        int queryIndex = normalized.IndexOf('?', StringComparison.Ordinal);
        string path = queryIndex >= 0 ? normalized[..queryIndex] : normalized;
        string query = queryIndex >= 0 ? normalized[queryIndex..] : string.Empty;
        if (string.IsNullOrWhiteSpace(path))
        {
            error = "public_navigation_snapshot_path_invalid";
            return false;
        }

        target.Request.Path = path;
        target.Request.QueryString = string.IsNullOrWhiteSpace(query) ? QueryString.Empty : new QueryString(query);
        if (!new PublicAotRouteRegistry().TryResolve(target, out _))
        {
            error = "public_navigation_snapshot_path_unsupported";
            return false;
        }

        return true;
    }

    private static bool RequestAcceptsNavigationSnapshot(StringValues accept)
    {
        if (StringValues.IsNullOrEmpty(accept))
        {
            return true;
        }

        foreach (string? rawValue in accept)
        {
            if (string.IsNullOrWhiteSpace(rawValue))
            {
                continue;
            }

            foreach (string token in rawValue.Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
            {
                string mediaType = token.Split(';', 2, StringSplitOptions.TrimEntries)[0];
                if (mediaType is "*/*" or "application/octet-stream" || string.Equals(mediaType, PublicAotNavigationSnapshot.MediaType, StringComparison.OrdinalIgnoreCase))
                {
                    return true;
                }
            }
        }

        return false;
    }

    private static bool RequestEntityTagMatches(StringValues ifNoneMatch, string entityTag)
        => !StringValues.IsNullOrEmpty(ifNoneMatch) &&
            ifNoneMatch
                .SelectMany(static value => (value ?? string.Empty).Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
                .Any(candidate => string.Equals(candidate, entityTag, StringComparison.Ordinal));

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
