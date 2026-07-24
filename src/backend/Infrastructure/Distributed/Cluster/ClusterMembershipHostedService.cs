using System.Diagnostics;

namespace FsusBlog.Server.Infrastructure.Distributed.Cluster;

public sealed class ClusterMembershipHostedService(
    IClusterMembershipStore store,
    ClusterMembershipOptions options,
    TimeProvider timeProvider,
    ILogger<ClusterMembershipHostedService> logger) : BackgroundService
{
    private readonly object _sampleGate = new();
    private TimeSpan _lastCpuTime = Process.GetCurrentProcess().TotalProcessorTime;
    private DateTimeOffset _lastSampleAt = timeProvider.GetUtcNow();

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        if (!options.Enabled)
        {
            return;
        }
        NodeDescriptor descriptor = NodeDescriptor.Create(
            options.NodeId,
            options.InstanceId,
            options.Version,
            options.StartedAt,
            options.Mode,
            options.Capabilities);
        await store.UpsertNodeAsync(descriptor, stoppingToken).ConfigureAwait(false);

        using var timer = new PeriodicTimer(options.HeartbeatInterval, timeProvider);
        do
        {
            DateTimeOffset now = timeProvider.GetUtcNow();
            await store.MarkHeartbeatAsync(
                new NodeHeartbeat(
                    options.NodeId,
                    options.InstanceId,
                    now,
                    CaptureResources(),
                    []),
                stoppingToken).ConfigureAwait(false);
            await store.DetectFailuresAsync(
                now,
                options.SuspectAfter,
                options.DeadAfter,
                stoppingToken).ConfigureAwait(false);
        }
        while (await timer.WaitForNextTickAsync(stoppingToken).ConfigureAwait(false));
    }

    public override async Task StopAsync(CancellationToken cancellationToken)
    {
        if (options.Enabled)
        {
            try
            {
                await store.SetNodeStatusAsync(
                    options.NodeId,
                    options.InstanceId,
                    ClusterMemberStatus.Draining,
                    cancellationToken).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                logger.LogWarning(ex, "cluster-membership-draining-mark-failed");
            }
        }
        await base.StopAsync(cancellationToken).ConfigureAwait(false);
    }

    private NodeResourceHints CaptureResources()
    {
        GCMemoryInfo gc = GC.GetGCMemoryInfo();
        long available = Math.Max(1, gc.TotalAvailableMemoryBytes);
        double memoryPressure = Math.Clamp(
            GC.GetTotalMemory(false) * 100d / available,
            0,
            100);
        double cpuUsage;
        lock (_sampleGate)
        {
            using Process process = Process.GetCurrentProcess();
            DateTimeOffset now = timeProvider.GetUtcNow();
            TimeSpan cpuElapsed = process.TotalProcessorTime - _lastCpuTime;
            TimeSpan wallElapsed = now - _lastSampleAt;
            cpuUsage = wallElapsed <= TimeSpan.Zero
                ? 0
                : Math.Clamp(
                    cpuElapsed.TotalMilliseconds * 100d
                        / (wallElapsed.TotalMilliseconds * Environment.ProcessorCount),
                    0,
                    100);
            _lastCpuTime = process.TotalProcessorTime;
            _lastSampleAt = now;
        }
        return new NodeResourceHints(
            cpuUsage,
            memoryPressure,
            GC.GetTotalMemory(false),
            0,
            0,
            0,
            0,
            0,
            true,
            0);
    }
}
