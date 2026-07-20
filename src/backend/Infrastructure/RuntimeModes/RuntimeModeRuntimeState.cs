namespace FsusBlog.Server.Infrastructure.RuntimeModes;

public sealed record RuntimeModeHealthSnapshot(
    string Mode,
    IReadOnlyList<string> StaticRoles,
    bool ClusterMembershipEnabled,
    bool AdaptiveSchedulerEnabled,
    bool DistributedInvalidationEnabled,
    bool LocalInvocationOnly,
    bool ClusterFoundationActive,
    DateTime CapturedAtUtc);

public sealed class RuntimeModeRuntimeState(RuntimeModePlan plan)
{
    private int _clusterFoundationActive;

    public RuntimeModePlan Plan { get; } = plan;

    internal void SetClusterFoundationActive(bool active)
        => Volatile.Write(ref _clusterFoundationActive, active ? 1 : 0);

    public RuntimeModeHealthSnapshot Capture()
        => new(
            Plan.Mode,
            Plan.StaticRoles.Order(StringComparer.Ordinal).ToArray(),
            Plan.ClusterMembershipEnabled,
            Plan.AdaptiveSchedulerEnabled,
            Plan.DistributedInvalidationEnabled,
            Plan.LocalInvocationOnly,
            Volatile.Read(ref _clusterFoundationActive) == 1,
            DateTime.UtcNow);
}

internal sealed class RuntimeModeStartupLogService(
    RuntimeModeRuntimeState runtimeState,
    ILogger<RuntimeModeStartupLogService> logger) : IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken)
    {
        RuntimeModeHealthSnapshot snapshot = runtimeState.Capture();
        logger.LogInformation(
            "runtime-mode {Mode} | StaticRoles={StaticRoles} ClusterMembership={ClusterMembership} AdaptiveScheduler={AdaptiveScheduler} DistributedInvalidation={DistributedInvalidation} LocalInvocationOnly={LocalInvocationOnly}",
            snapshot.Mode,
            string.Join(',', snapshot.StaticRoles),
            snapshot.ClusterMembershipEnabled ? "enabled" : "disabled",
            snapshot.AdaptiveSchedulerEnabled ? "enabled" : "disabled",
            snapshot.DistributedInvalidationEnabled ? "enabled" : "disabled",
            snapshot.LocalInvocationOnly);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}

internal sealed class ClusterRuntimeFoundationHostedService(
    RuntimeModeRuntimeState runtimeState,
    ILogger<ClusterRuntimeFoundationHostedService> logger) : IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken)
    {
        runtimeState.SetClusterFoundationActive(true);
        logger.LogInformation(
            "cluster-runtime-foundation active | Mode={Mode} MembershipGate={MembershipGate} SchedulerGate={SchedulerGate}",
            runtimeState.Plan.Mode,
            runtimeState.Plan.ClusterMembershipEnabled,
            runtimeState.Plan.AdaptiveSchedulerEnabled);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        runtimeState.SetClusterFoundationActive(false);
        return Task.CompletedTask;
    }
}
