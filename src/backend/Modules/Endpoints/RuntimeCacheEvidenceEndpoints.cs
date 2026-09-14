using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Testing;

namespace FsusBlog.Server.Modules.Endpoints;

internal static class RuntimeCacheEvidenceEndpoints
{
    private const string ObservationRoute = "/_fsus/testing/runtime-cache/observations/{requestId}";
    private const string RuntimeSnapshotRoute = "/_fsus/testing/runtime-cache/runtime-snapshot";

    internal static WebApplication MapRuntimeCacheEvidenceEndpoints(this WebApplication app)
    {
        if ((!app.Environment.IsDevelopment() && !app.Environment.IsEnvironment("Test")) ||
            string.IsNullOrWhiteSpace(app.Configuration[RuntimeCacheEvidenceMiddleware.SecretConfigurationKey]))
        {
            return app;
        }

        app.MapGet(ObservationRoute, TakeObservation)
            .AllowAnonymous()
            .WithMetadata(new FsusRouteKindMetadata("testing"));
        app.MapGet(RuntimeSnapshotRoute, TakeRuntimeSnapshot)
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

    private static IResult TakeRuntimeSnapshot(
        HttpContext context,
        IConfiguration configuration)
    {
        string secret = configuration[RuntimeCacheEvidenceMiddleware.SecretConfigurationKey] ?? string.Empty;
        if (!SecretEquals(secret, context.Request.Headers[RuntimeCacheEvidenceMiddleware.SecretHeader].ToString()))
        {
            return Results.StatusCode(StatusCodes.Status403Forbidden);
        }

        ICacheDiagnostics cache = context.RequestServices.GetRequiredService<ICacheDiagnostics>();
        ICacheSingleFlightCoordinator singleFlight = context.RequestServices.GetRequiredService<ICacheSingleFlightCoordinator>();
        CacheL1PolicyResidencySnapshot[] policies = [.. cache.GetL1PolicyResidencySnapshots()];
        using System.Diagnostics.Process process = System.Diagnostics.Process.GetCurrentProcess();
        return Results.Ok(new RuntimeCacheEvidenceRuntimeSnapshot(
            DateTimeOffset.UtcNow,
            Environment.ProcessId,
            policies.Sum(static item => item.Entries),
            policies.Sum(static item => item.LogicalBytes),
            policies.Sum(static item => item.CapacityBytes),
            policies.Sum(static item => item.MaxLogicalBytes),
            policies.Sum(static item => item.MaxCapacityBytes),
            GC.GetTotalAllocatedBytes(precise: true),
            GC.CollectionCount(0),
            GC.CollectionCount(1),
            GC.CollectionCount(2),
            process.WorkingSet64,
            singleFlight is CacheSingleFlightCoordinator concrete ? concrete.ActiveEntryCount : -1,
            policies));
    }

    private static bool SecretEquals(string expected, string provided)
    {
        byte[] left = Encoding.UTF8.GetBytes(expected);
        byte[] right = Encoding.UTF8.GetBytes(provided);
        return left.Length > 0 && left.Length == right.Length &&
            CryptographicOperations.FixedTimeEquals(left, right);
    }
}

internal sealed record RuntimeCacheEvidenceRuntimeSnapshot(
    DateTimeOffset CapturedAt,
    int ProcessId,
    long Entries,
    long LogicalBytes,
    long CapacityBytes,
    long LogicalBudgetBytes,
    long CapacityBudgetBytes,
    long TotalAllocatedBytes,
    int Gen0Collections,
    int Gen1Collections,
    int Gen2Collections,
    long ResidentBytes,
    int ActiveKeyedEntries,
    IReadOnlyList<CacheL1PolicyResidencySnapshot> Policies);
