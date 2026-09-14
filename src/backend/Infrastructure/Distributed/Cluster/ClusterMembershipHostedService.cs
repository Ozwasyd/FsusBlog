using System.Diagnostics;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Distributed.Scheduling;
using FsusBlog.Server.Infrastructure.Distributed.StateControl;

namespace FsusBlog.Server.Infrastructure.Distributed.Cluster;

public sealed class ClusterMembershipHostedService(
    IClusterMembershipStore store,
    ILeaseManager leaseManager,
    IResponsibilityRuntime responsibilityRuntime,
    ClusterMembershipOptions options,
    TimeProvider timeProvider,
    ILogger<ClusterMembershipHostedService> logger,
    IClusterOperationsTelemetry? telemetry = null) : BackgroundService
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
        telemetry?.RecordNodeLifecycle(descriptor, "alive", "node-registered");

        using var timer = new PeriodicTimer(options.HeartbeatInterval, timeProvider);
        do
        {
            try
            {
                await RunHeartbeatCycleAsync(stoppingToken).ConfigureAwait(false);
            }
            catch (RedisOperationUnavailableException ex) when (!stoppingToken.IsCancellationRequested)
            {
                logger.LogWarning(ex, "cluster-membership-heartbeat-redis-unavailable");
            }
        }
        while (await timer.WaitForNextTickAsync(stoppingToken).ConfigureAwait(false));
    }

    private async Task RunHeartbeatCycleAsync(CancellationToken cancellationToken)
    {
        DateTimeOffset now = timeProvider.GetUtcNow();
        IReadOnlyList<ActiveResponsibility> active =
            await responsibilityRuntime.ListActiveAsync(cancellationToken).ConfigureAwait(false);
        await store.MarkHeartbeatAsync(
            new NodeHeartbeat(
                options.NodeId,
                options.InstanceId,
                now,
                CaptureResources(),
                active
                    .Select(static item => item.Assignment.Capability)
                    .Distinct()
                    .OrderBy(static capability => capability.Value, StringComparer.Ordinal)
                    .ToArray()),
            cancellationToken).ConfigureAwait(false);
        await DetectFailuresAsSingleWriterAsync(now, cancellationToken).ConfigureAwait(false);
        telemetry?.RecordNodeCounts(
            await store.ListNodesAsync(cancellationToken).ConfigureAwait(false));
    }

    private async Task DetectFailuresAsSingleWriterAsync(
        DateTimeOffset now,
        CancellationToken cancellationToken)
    {
        TimeSpan ttl = TimeSpan.FromTicks(Math.Max(
            TimeSpan.FromSeconds(5).Ticks,
            options.HeartbeatInterval.Ticks * 2));
        LeaseAcquireResult acquired = await leaseManager.TryAcquireAsync(
            new LeaseKey("cluster", "failure-detector"),
            options.NodeId,
            ttl,
            cancellationToken).ConfigureAwait(false);
        if (!acquired.Acquired || acquired.Lease is null)
        {
            return;
        }
        try
        {
            IReadOnlyList<NodeDescriptor> before =
                await store.ListNodesAsync(cancellationToken).ConfigureAwait(false);
            await store.DetectFailuresAsync(
                now,
                options.SuspectAfter,
                options.DeadAfter,
                cancellationToken).ConfigureAwait(false);
            IReadOnlyList<NodeDescriptor> after =
                await store.ListNodesAsync(cancellationToken).ConfigureAwait(false);
            foreach (NodeDescriptor node in after)
            {
                NodeDescriptor? previous = before.FirstOrDefault(
                    candidate => candidate.NodeId == node.NodeId
                        && candidate.InstanceId == node.InstanceId);
                if (previous is not null && previous.Status != node.Status)
                {
                    telemetry?.RecordNodeLifecycle(
                        node,
                        ClusterMembershipWireNames.Status(node.Status),
                        "heartbeat-timeout");
                }
            }
        }
        finally
        {
            _ = await leaseManager.ReleaseAsync(
                acquired.Lease.LeaseId,
                acquired.Lease.FencingToken,
                CancellationToken.None).ConfigureAwait(false);
        }
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
                NodeDescriptor? descriptor = (await store
                        .ListNodesAsync(cancellationToken)
                        .ConfigureAwait(false))
                    .FirstOrDefault(node =>
                        node.NodeId == options.NodeId
                        && node.InstanceId == options.InstanceId);
                if (descriptor is not null)
                {
                    telemetry?.RecordNodeLifecycle(
                        descriptor,
                        "draining",
                        "host-stopping");
                }
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
