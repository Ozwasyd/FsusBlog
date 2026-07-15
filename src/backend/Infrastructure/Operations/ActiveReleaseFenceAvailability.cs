using FsusBlog.Server.Infrastructure.Bootstrap;

namespace FsusBlog.Server.Infrastructure.Operations;

public static class ActiveReleaseFenceAvailabilityPolicy
{
    public const string AllowSyntheticLocalFenceKey = "ActiveReleaseFence:AllowSyntheticLocalFence";
    public const string RefreshIntervalKey = "ActiveReleaseFence:RefreshIntervalMs";
    public const string StaleThresholdKey = "ActiveReleaseFence:StaleThresholdSeconds";
    public const int MinimumRefreshIntervalMs = 100;
    public const int MaximumRefreshIntervalMs = 30_000;
    public const int MinimumStaleThresholdSeconds = 5;
    public const int MaximumStaleThresholdSeconds = 600;
    private const int DefaultRefreshIntervalMs = 5_000;
    private const int DefaultStaleThresholdSeconds = 30;

    public static TimeSpan RefreshInterval(IConfiguration configuration)
        => TimeSpan.FromMilliseconds(Math.Clamp(
            configuration.GetValue(RefreshIntervalKey, DefaultRefreshIntervalMs),
            MinimumRefreshIntervalMs,
            MaximumRefreshIntervalMs));

    public static TimeSpan StaleThreshold(IConfiguration configuration)
        => TimeSpan.FromSeconds(Math.Clamp(
            configuration.GetValue(StaleThresholdKey, DefaultStaleThresholdSeconds),
            MinimumStaleThresholdSeconds,
            MaximumStaleThresholdSeconds));

    public static int FailuresBeforeShutdown(IConfiguration configuration)
    {
        double refreshMilliseconds = RefreshInterval(configuration).TotalMilliseconds;
        double staleMilliseconds = StaleThreshold(configuration).TotalMilliseconds;
        return Math.Max(1, (int)Math.Ceiling(staleMilliseconds / refreshMilliseconds));
    }
}

public sealed class ActiveReleaseFenceStartupException(string errorCode, Exception? innerException = null)
    : InvalidOperationException(
        $"Active release fence durable witness is unreachable at startup ({errorCode}); refusing to boot.",
        innerException)
{
    public string ErrorCode { get; } = errorCode;
}

public sealed class ActiveReleaseFenceStartupValidationHostedService(
    IActiveReleaseFence fence,
    IWebHostEnvironment environment,
    StartupRuntimeState runtimeState,
    ILogger<ActiveReleaseFenceStartupValidationHostedService> logger) : IHostedService
{
    internal const string TaskName = "activeReleaseFenceStartupProbe";

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        ActiveReleaseFenceRuntimeSnapshot snapshot;
        Exception? failure = null;
        try
        {
            snapshot = await fence.RefreshAsync(
                forceStoreRead: true,
                cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            failure = ex;
            snapshot = fence.Current;
        }

        if (snapshot.StoreReachable)
        {
            runtimeState.ReportStartupTask(TaskName, "completed", snapshot.Fence.Status);
            ActiveReleaseFenceMetrics.RecordOperation("startup_probe", "accepted", snapshot.Fence.Status);
            return;
        }

        string errorCode = snapshot.ErrorCode ?? "active_release_fence_store_unavailable";
        ActiveReleaseFenceMetrics.RecordOperation("startup_probe", "rejected", errorCode);
        if (environment.IsProduction())
        {
            runtimeState.ReportStartupTask(TaskName, "failed", errorCode);
            logger.LogCritical(
                failure,
                "active-release-fence-startup-probe-failed errorCode={ErrorCode}",
                errorCode);
            throw new ActiveReleaseFenceStartupException(errorCode, failure);
        }

        runtimeState.ReportStartupTask(TaskName, "degraded", errorCode);
        logger.LogWarning(
            failure,
            "active-release-fence-startup-probe-degraded errorCode={ErrorCode}",
            errorCode);
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
