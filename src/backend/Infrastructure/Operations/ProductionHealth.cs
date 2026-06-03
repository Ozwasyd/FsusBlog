using System.Diagnostics;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Sse;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.Security;
using Npgsql;
using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.Operations;

public sealed record ProductionHealthReport(
    string Status,
    DateTimeOffset CheckedAt,
    IReadOnlyDictionary<string, object?> Checks);

public sealed record RuntimeHealthSnapshot(
    string Status,
    DbConcurrencyGateSnapshot? DbGate,
    int? SseConnections,
    int AvailableWorkerThreads,
    StartupRuntimeSnapshot? Startup,
    ScheduledPublishRuntimeSnapshot? ScheduledPublish,
    PublicHotReadRuntimeSnapshot? PublicHotRead,
    AuditLogRuntimeSnapshot? AuditLog);

public static class ProductionLivenessProbe
{
    public static IReadOnlyDictionary<string, object?> CreateReport()
        => new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["status"] = "live",
            ["checkedAt"] = DateTimeOffset.UtcNow
        };
}

public sealed class ProductionReadinessProbe(
    IConfiguration configuration,
    IWebHostEnvironment environment,
    IServiceProvider serviceProvider,
    ILogger<ProductionReadinessProbe> logger)
{
    public async Task<ProductionHealthReport> CheckAsync(CancellationToken cancellationToken)
    {
        Dictionary<string, object?> checks = new(StringComparer.Ordinal)
        {
            ["configuration"] = CheckConfiguration(),
            ["observability"] = CheckObservability(),
            ["resources"] = CheckResources(),
            ["runtime"] = CheckRuntime()
        };

        checks["postgres"] = await CheckPostgresAsync(cancellationToken);
        checks["redis"] = await CheckRedisAsync(cancellationToken);

        bool healthy = checks.Values.All(IsHealthyCheck);
        return new ProductionHealthReport(
            healthy ? "ready" : "not_ready",
            DateTimeOffset.UtcNow,
            checks);
    }

    private object CheckConfiguration()
    {
        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, environment.IsProduction());
        return errors.Count == 0
            ? new { status = "ok" }
            : new { status = "failed", errors };
    }

    private object CheckResources()
    {
        string webRoot = environment.WebRootPath;
        if (string.IsNullOrWhiteSpace(webRoot))
        {
            webRoot = Path.Combine(environment.ContentRootPath, "wwwroot");
        }

        string? ip2Location = ProductionResourcePaths.ResolveIp2LocationBinPath(AppContext.BaseDirectory);
        bool webRootExists = Directory.Exists(webRoot);
        bool indexExists = File.Exists(Path.Combine(webRoot, "index.html"));
        bool ip2LocationExists = !string.IsNullOrEmpty(ip2Location);
        PublicAotSsrWorkerResourceStatus publicAotSsrWorker = PublicAotNodeSsrRenderer.CheckWorkerResource(environment, configuration);
        bool publicAotSsrWorkerReady = !environment.IsProduction()
            || string.Equals(publicAotSsrWorker.Status, "ok", StringComparison.Ordinal);

        return new
        {
            status = webRootExists && indexExists && ip2LocationExists && publicAotSsrWorkerReady ? "ok" : "failed",
            webRootExists,
            indexExists,
            ip2LocationExists,
            publicAotSsrWorker
        };
    }

    private object CheckObservability()
    {
        ObservabilityRuntimeState? state = serviceProvider.GetService<ObservabilityRuntimeState>();
        return state is null
            ? new { status = "failed", error = "observability_not_registered" }
            : new
            {
                status = "ok",
                state.Enabled,
                state.ExporterEnabled,
                state.ServiceName,
                state.ServiceVersion,
                activitySource = FsusObservability.ActivitySourceName,
                meter = FsusObservability.MeterName,
                customAttributeCount = FsusObservability.CustomAttributeNames.Count
            };
    }

    private RuntimeHealthSnapshot CheckRuntime()
    {
        DbConcurrencyGateSnapshot? dbGate = null;
        if (serviceProvider.GetService<IDbConcurrencyGate>() is { } gate)
        {
            dbGate = gate.GetSnapshot();
        }

        int? sseConnections = serviceProvider.GetService<SseConnectionManager>()?.ConnectionCount;
        StartupRuntimeState? startupRuntime = serviceProvider.GetService<StartupRuntimeState>();
        ScheduledPublishRuntimeState? scheduledPublish = serviceProvider.GetService<ScheduledPublishRuntimeState>();
        PublicHotReadRuntimeSnapshot? publicHotRead = serviceProvider.GetService<PublicHotReadStore>()?.CreateRuntimeSnapshot();
        AuditLogRuntimeSnapshot? auditLog = serviceProvider.GetService<AuditLogRuntimeState>()?.Snapshot();
        string status = publicHotRead is null
            || string.Equals(publicHotRead.State, nameof(PublicHotReadState.Ready), StringComparison.Ordinal)
            ? "ok"
            : "degraded";

        return new RuntimeHealthSnapshot(
            status,
            dbGate,
            sseConnections,
            RuntimePressureSnapshot.Capture().AvailableWorkerThreads,
            startupRuntime?.CreateSnapshot(),
            scheduledPublish?.CreateSnapshot(),
            publicHotRead,
            auditLog);
    }

    private async Task<object> CheckPostgresAsync(CancellationToken cancellationToken)
    {
        long startedAt = System.Diagnostics.Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("db.postgres.ping", "db", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.db.system", "postgresql");
        FsusObservability.SetTag(activity, "fsus.db.operation", "ping");
        string? connectionString = configuration.GetConnectionString("DefaultConnection");
        if (string.IsNullOrWhiteSpace(connectionString))
        {
            FsusObservability.RecordDbOperation("ping", "missing_connection_string", FsusObservability.GetElapsed(startedAt));
            return new { status = "failed", error = "missing_connection_string" };
        }

        try
        {
            await using var connection = new NpgsqlConnection(connectionString);
            await connection.OpenAsync(cancellationToken);
            await using var command = connection.CreateCommand();
            command.CommandText = "select 1";
            command.CommandTimeout = 3;
            object? result = await command.ExecuteScalarAsync(cancellationToken);
            TimeSpan elapsed = FsusObservability.GetElapsed(startedAt);
            FsusObservability.RecordDbOperation("ping", Convert.ToInt32(result) == 1 ? "ok" : "unexpected_result", elapsed);
            return Convert.ToInt32(result) == 1
                ? new { status = "ok", latencyMs = elapsed.TotalMilliseconds }
                : new { status = "failed", error = "unexpected_result" };
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "postgres readiness check failed");
            FsusObservability.RecordDbOperation("ping", "failed", FsusObservability.GetElapsed(startedAt));
            return new { status = "failed", error = ex.GetType().Name };
        }
    }

    private async Task<object> CheckRedisAsync(CancellationToken cancellationToken)
    {
        long startedAt = System.Diagnostics.Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("cache.redis.ping", "cache", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.cache.operation", "ping");
        FsusObservability.SetTag(activity, "fsus.cache.policy", "redis");
        FsusObservability.SetTag(activity, "fsus.cache.layer", "l2");
        try
        {
            IConnectionMultiplexer multiplexer = serviceProvider.GetRequiredService<IConnectionMultiplexer>();
            IDatabase database = multiplexer.GetDatabase();
            TimeSpan latency = await database.PingAsync(CommandFlags.DemandMaster);
            FsusObservability.RecordCacheOperation("ping", "redis", "l2", "ok", FsusObservability.GetElapsed(startedAt));
            return new { status = "ok", latencyMs = latency.TotalMilliseconds };
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "redis readiness check failed");
            FsusObservability.RecordCacheOperation("ping", "redis", "l2", "failed", FsusObservability.GetElapsed(startedAt));
            return new { status = "failed", error = ex.GetType().Name };
        }
    }

    private static bool IsHealthyCheck(object? check)
    {
        if (check is null)
        {
            return false;
        }

        object? status = check.GetType()
            .GetProperty("status", System.Reflection.BindingFlags.IgnoreCase | System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public)
            ?.GetValue(check);
        return string.Equals(Convert.ToString(status), "ok", StringComparison.Ordinal);
    }
}

public static class ProductionHealthEndpoints
{
    public static IEndpointRouteBuilder MapProductionHealthEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/health/live", () => TypedResults.Json(ProductionLivenessProbe.CreateReport())).AllowAnonymous();

        endpoints.MapGet("/health/ready", async Task<IResult> (
            ProductionReadinessProbe probe,
            CancellationToken cancellationToken) =>
        {
            ProductionHealthReport report = await probe.CheckAsync(cancellationToken);
            int statusCode = report.Status == "ready"
                ? StatusCodes.Status200OK
                : StatusCodes.Status503ServiceUnavailable;
            return TypedResults.Json(report, statusCode: statusCode);
        }).AllowAnonymous();

        endpoints.MapGet("/api/ops/crawler-ranges/status", (CrawlerDetectorService detector) =>
        {
            CrawlerRangeStatus status = detector.GetRangeStatus();
            return TypedResults.Json(new
            {
                googleRanges = status.GoogleRanges,
                bingRanges = status.BingRanges,
                lastSyncAt = status.LastSyncAt,
                lastSuccessAt = status.LastSuccessAt,
                source = status.Source,
                lastError = status.LastError
            });
        }).RequireAuthorization(policy => policy.RequireRole("admin"));

        return endpoints;
    }
}
