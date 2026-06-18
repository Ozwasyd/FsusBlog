using System.Diagnostics;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.Security;
using Npgsql;
using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.Operations;

public sealed record ProductionHealthReport(
    string Status,
    DateTimeOffset CheckedAt,
    IReadOnlyDictionary<string, object?> Checks);

public interface IProductionHealthCheck
{
    string Status { get; }
}

public sealed record ProductionDependencyHealthCheck(
    string Status,
    double? LatencyMs = null,
    string? Error = null) : IProductionHealthCheck;

public sealed record ProductionConfigurationHealthCheck(
    string Status,
    IReadOnlyList<string> Errors) : IProductionHealthCheck;

public sealed record ProductionResourceHealthCheck(
    string Status,
    bool WebRootExists,
    bool IndexExists,
    bool Ip2LocationExists,
    PublicAotSsrWorkerResourceStatus PublicAotSsrWorker) : IProductionHealthCheck;

public sealed record ProductionObservabilityHealthCheck(
    string Status,
    bool Enabled,
    bool ExporterEnabled,
    string ServiceName,
    string ServiceVersion,
    string ActivitySource,
    string Meter,
    int CustomAttributeCount,
    string? Error = null) : IProductionHealthCheck;

public sealed record RuntimeHealthSnapshot(
    string Status,
    DbConcurrencyGateSnapshot? DbGate,
    int? NotificationStreamConnections,
    int AvailableWorkerThreads,
    StartupRuntimeSnapshot? Startup,
    ScheduledPublishRuntimeSnapshot? ScheduledPublish,
    PublicHotReadRuntimeSnapshot? PublicHotRead,
    AuditLogRuntimeSnapshot? AuditLog) : IProductionHealthCheck;

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
        Task<ProductionDependencyHealthCheck> postgresTask = CheckPostgresAsync(cancellationToken);
        Task<ProductionDependencyHealthCheck> redisTask = CheckRedisAsync(cancellationToken);
        Dictionary<string, object?> checks = new(StringComparer.Ordinal)
        {
            ["configuration"] = CheckConfiguration(),
            ["observability"] = CheckObservability(),
            ["resources"] = CheckResources(),
            ["runtime"] = CheckRuntime()
        };

        await Task.WhenAll(postgresTask, redisTask);
        checks["postgres"] = postgresTask.Result;
        checks["redis"] = redisTask.Result;

        bool healthy = checks.Values.All(IsHealthyCheck);
        return new ProductionHealthReport(
            healthy ? "ready" : "not_ready",
            DateTimeOffset.UtcNow,
            checks);
    }

    private ProductionConfigurationHealthCheck CheckConfiguration()
    {
        IReadOnlyList<string> errors = ProductionStartupValidator.ValidateCore(configuration, environment.IsProduction());
        return errors.Count == 0
            ? new ProductionConfigurationHealthCheck("ok", [])
            : new ProductionConfigurationHealthCheck("failed", errors);
    }

    private ProductionResourceHealthCheck CheckResources()
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

        return new ProductionResourceHealthCheck(
            webRootExists && indexExists && ip2LocationExists && publicAotSsrWorkerReady ? "ok" : "failed",
            webRootExists,
            indexExists,
            ip2LocationExists,
            publicAotSsrWorker);
    }

    private ProductionObservabilityHealthCheck CheckObservability()
    {
        ObservabilityRuntimeState? state = serviceProvider.GetService<ObservabilityRuntimeState>();
        return state is null
            ? new ProductionObservabilityHealthCheck(
                "failed",
                Enabled: false,
                ExporterEnabled: false,
                ServiceName: string.Empty,
                ServiceVersion: string.Empty,
                ActivitySource: FsusObservability.ActivitySourceName,
                Meter: FsusObservability.MeterName,
                CustomAttributeCount: FsusObservability.CustomAttributeNames.Count,
                Error: "observability_not_registered")
            : new ProductionObservabilityHealthCheck(
                "ok",
                state.Enabled,
                state.ExporterEnabled,
                state.ServiceName,
                state.ServiceVersion,
                FsusObservability.ActivitySourceName,
                FsusObservability.MeterName,
                FsusObservability.CustomAttributeNames.Count);
    }

    private RuntimeHealthSnapshot CheckRuntime()
    {
        DbConcurrencyGateSnapshot? dbGate = null;
        if (serviceProvider.GetService<IDbConcurrencyGate>() is { } gate)
        {
            dbGate = gate.GetSnapshot();
        }

        int? notificationStreamConnections = serviceProvider.GetService<NotificationStreamConnectionManager>()?.ConnectionCount;
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
            notificationStreamConnections,
            RuntimePressureSnapshot.Capture().AvailableWorkerThreads,
            startupRuntime?.CreateSnapshot(),
            scheduledPublish?.CreateSnapshot(),
            publicHotRead,
            auditLog);
    }

    private async Task<ProductionDependencyHealthCheck> CheckPostgresAsync(CancellationToken cancellationToken)
    {
        long startedAt = System.Diagnostics.Stopwatch.GetTimestamp();
        using Activity? activity = FsusObservability.StartActivity("db.postgres.ping", "db", ActivityKind.Client);
        FsusObservability.SetTag(activity, "fsus.db.system", "postgresql");
        FsusObservability.SetTag(activity, "fsus.db.operation", "ping");
        string? connectionString = configuration.GetConnectionString("DefaultConnection");
        if (string.IsNullOrWhiteSpace(connectionString))
        {
            FsusObservability.RecordDbOperation("ping", "missing_connection_string", FsusObservability.GetElapsed(startedAt));
            return new ProductionDependencyHealthCheck("failed", Error: "missing_connection_string");
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
                ? new ProductionDependencyHealthCheck("ok", LatencyMs: elapsed.TotalMilliseconds)
                : new ProductionDependencyHealthCheck("failed", Error: "unexpected_result");
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "postgres readiness check failed");
            FsusObservability.RecordDbOperation("ping", "failed", FsusObservability.GetElapsed(startedAt));
            return new ProductionDependencyHealthCheck("failed", Error: ex.GetType().Name);
        }
    }

    private async Task<ProductionDependencyHealthCheck> CheckRedisAsync(CancellationToken cancellationToken)
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
            return new ProductionDependencyHealthCheck("ok", LatencyMs: latency.TotalMilliseconds);
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "redis readiness check failed");
            FsusObservability.RecordCacheOperation("ping", "redis", "l2", "failed", FsusObservability.GetElapsed(startedAt));
            return new ProductionDependencyHealthCheck("failed", Error: ex.GetType().Name);
        }
    }

    private static bool IsHealthyCheck(object? check)
        => check is IProductionHealthCheck health
            && string.Equals(health.Status, "ok", StringComparison.Ordinal);
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
        }).RequireAdminPermission(AdminPermissions.AuditRead);

        return endpoints;
    }
}
