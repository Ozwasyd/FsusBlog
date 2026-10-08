using System.Globalization;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Testing;

using Microsoft.AspNetCore.Mvc;

namespace FsusBlog.Server.Modules.Endpoints;

internal static class RuntimeCacheChurnEvidenceEndpoints
{
    internal const string BoundaryRoute = "/_fsus/testing/runtime-cache/cache-churn/generation-boundary";

    internal static WebApplication MapRuntimeCacheChurnEvidenceEndpoints(this WebApplication app)
    {
        if (!RuntimeCacheEvidenceEndpoints.IsEnabled(app))
        {
            return app;
        }
        // Registration is nested under the existing Development/Test + secret
        // gate. This observer has no mutation, cache clear or publication route.
        app.MapGet(BoundaryRoute, ObserveAsync)
            .AllowAnonymous()
            .WithMetadata(new FsusRouteKindMetadata("testing"));
        return app;
    }

    private static async Task<IResult> ObserveAsync(
        HttpContext context,
        string runId,
        [FromQuery(Name = "namespace")] string testNamespace,
        [FromServices] IRuntimeKeyScope scope,
        [FromServices] ICacheStringReader cache,
        [FromServices] IPublicHotArtifactObligationStore obligations,
        [FromServices] PublicHotReadStore hotRead,
        [FromServices] PublicAotInvalidationTracker aot,
        CancellationToken cancellationToken)
    {
        if (!RuntimeCacheEvidenceMiddleware.AllowsAuthenticatedHeader(
                context, RuntimeCacheEvidenceMiddleware.SecretHeader)
            || !HttpTestSessionKeyScope.IsValidSessionId(testNamespace)
            || !string.Equals(scope.ScopeToken, testNamespace, StringComparison.Ordinal)
            || runId.Length is < 1 or > 128
            || runId.Any(static character => !char.IsAsciiLetterOrDigit(character) && character is not '-' and not '_' and not '.'))
        {
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        }

        string? raw = await cache.GetStringAsync(CachePolicyId.TaxonomyFrameVersion, "main", cancellationToken);
        long? taxonomyCounter = long.TryParse(raw, NumberStyles.None, CultureInfo.InvariantCulture, out long version)
            && version >= 0 ? version : null;
        PublicHotArtifactObligation? obligation = await obligations.GetActiveAsync(cancellationToken);
        return Results.Ok(new RuntimeCacheChurnGenerationBoundary(
            "fsusblog.cache-churn-generation-boundary.v1",
            runId,
            testNamespace,
            scope.ScopeToken,
            taxonomyCounter,
            hotRead.Current.Version,
            obligation,
            aot.Snapshot(),
            DatabaseGeneration: null,
            MutationReceiptBinding: null,
            CommonGenerationBinding: null));
    }
}

// Counter/snapshot/obligation domains are diagnostic observations, not cycle
// receipts. Null binding fields are unavailable evidence, never a zero or a
// copied delivery counter. Category has no canonical Generation property.
internal sealed record RuntimeCacheChurnGenerationBoundary(
    string Schema,
    string RunId,
    string Namespace,
    string ScopeToken,
    long? TaxonomyFrameCounter,
    long HotReadSnapshotVersion,
    PublicHotArtifactObligation? DeliveryObligation,
    PublicAotInvalidationRuntimeSnapshot AotInvalidation,
    long? DatabaseGeneration,
    string? MutationReceiptBinding,
    string? CommonGenerationBinding);
