using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Sse;
using Npgsql;
using StackExchange.Redis;

namespace FsusBlog.Server.Infrastructure.Operations;

public sealed record ProductionHealthReport(
    string Status,
    DateTimeOffset CheckedAt,
    IReadOnlyDictionary<string, object?> Checks);

public static class ProductionLivenessProbe
{
    public static object CreateReport()
        => new
        {
            status = "live",
            checkedAt = DateTimeOffset.UtcNow
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

        return new
        {
            status = webRootExists && indexExists && ip2LocationExists ? "ok" : "failed",
            webRootExists,
            indexExists,
            ip2LocationExists
        };
    }

    private object CheckRuntime()
    {
        DbConcurrencyGateSnapshot? dbGate = null;
        if (serviceProvider.GetService<IDbConcurrencyGate>() is { } gate)
        {
            dbGate = gate.GetSnapshot();
        }

        int? sseConnections = serviceProvider.GetService<SseConnectionManager>()?.ConnectionCount;

        return new
        {
            status = "ok",
            dbGate,
            sseConnections,
            availableWorkerThreads = RuntimePressureSnapshot.Capture().AvailableWorkerThreads
        };
    }

    private async Task<object> CheckPostgresAsync(CancellationToken cancellationToken)
    {
        string? connectionString = configuration.GetConnectionString("DefaultConnection");
        if (string.IsNullOrWhiteSpace(connectionString))
        {
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
            return Convert.ToInt32(result) == 1
                ? new { status = "ok" }
                : new { status = "failed", error = "unexpected_result" };
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "postgres readiness check failed");
            return new { status = "failed", error = ex.GetType().Name };
        }
    }

    private async Task<object> CheckRedisAsync(CancellationToken cancellationToken)
    {
        try
        {
            IConnectionMultiplexer multiplexer = serviceProvider.GetRequiredService<IConnectionMultiplexer>();
            IDatabase database = multiplexer.GetDatabase();
            TimeSpan latency = await database.PingAsync(CommandFlags.DemandMaster);
            return new { status = "ok", latencyMs = latency.TotalMilliseconds };
        }
        catch (Exception ex) when (ex is not OperationCanceledException)
        {
            logger.LogWarning(ex, "redis readiness check failed");
            return new { status = "failed", error = ex.GetType().Name };
        }
    }

    private static bool IsHealthyCheck(object? check)
    {
        if (check is null)
        {
            return false;
        }

        object? status = check.GetType().GetProperty("status")?.GetValue(check);
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
            return report.Status == "ready"
                ? TypedResults.Json(report)
                : TypedResults.Json(report, statusCode: StatusCodes.Status503ServiceUnavailable);
        }).AllowAnonymous();

        return endpoints;
    }
}
