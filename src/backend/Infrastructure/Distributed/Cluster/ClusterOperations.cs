using System.Collections.Concurrent;
using System.Diagnostics;
using System.Diagnostics.Metrics;

using FsusBlog.Server.Infrastructure.Distributed.Scheduling;
using FsusBlog.Server.Infrastructure.Distributed.StateControl;

namespace FsusBlog.Server.Infrastructure.Distributed.Cluster;

public enum ClusterOperationsEventKind
{
    SchedulerDecision = 0,
    NodeLifecycle = 1,
    ResponsibilityTransition = 2,
    Lease = 3,
    OperatorAction = 4
}

public sealed record ClusterOperationsEvent(
    long Sequence,
    DateTimeOffset ObservedAt,
    ClusterOperationsEventKind Kind,
    string State,
    string Reason,
    string? NodeId,
    string? ResponsibilityId,
    string? SourceNodeId,
    string? TargetNodeId,
    string? TraceId);

public sealed record ClusterOperationsMetricSnapshot(
    long NodesAlive,
    long NodesSuspect,
    long SchedulerAssignments,
    long SchedulerRebalances,
    long LeaseAcquireSuccess,
    long LeaseAcquireFailure,
    long LeaseRenewFailure,
    long ResponsibilityMigrations,
    long ResponsibilityFailures);

public interface IClusterOperationsTelemetry
{
    void RecordNodeCounts(IReadOnlyList<NodeDescriptor> nodes);

    void RecordNodeLifecycle(NodeDescriptor node, string state, string reason);

    void RecordSchedulerDecision(
        ResponsibilityAssignmentSnapshot previous,
        ResponsibilityAssignmentSnapshot current);

    void RecordResponsibilityTransition(
        ResponsibilityAssignment assignment,
        string state,
        string reason,
        string? sourceNodeId = null);

    void RecordLease(string operation, bool success, ResponsibilityAssignment? assignment);

    void RecordActivationDuration(TimeSpan elapsed);

    void RecordOperatorAction(
        string state,
        string reason,
        string? nodeId = null,
        string? responsibilityId = null);

    IReadOnlyList<ClusterOperationsEvent> RecentEvents(int limit);

    ClusterOperationsMetricSnapshot CaptureMetrics();
}

public sealed class ClusterOperationsTelemetry(
    TimeProvider timeProvider,
    ILogger<ClusterOperationsTelemetry> logger) : IClusterOperationsTelemetry
{
    private const int EventCapacity = 512;
    private static readonly Meter s_meter = new("FsusBlog.Server.Cluster", "1.3.0");
    private static readonly ObservableGauge<long> s_aliveNodes =
        s_meter.CreateObservableGauge("cluster.nodes.alive", ObserveAliveNodes);
    private static readonly ObservableGauge<long> s_suspectNodes =
        s_meter.CreateObservableGauge("cluster.nodes.suspect", ObserveSuspectNodes);
    private static readonly Counter<long> s_assignmentCounter =
        s_meter.CreateCounter<long>("scheduler.assignment.count");
    private static readonly Counter<long> s_rebalanceCounter =
        s_meter.CreateCounter<long>("scheduler.rebalance.count");
    private static readonly Counter<long> s_leaseAcquireSuccess =
        s_meter.CreateCounter<long>("lease.acquire.success");
    private static readonly Counter<long> s_leaseAcquireFailure =
        s_meter.CreateCounter<long>("lease.acquire.failure");
    private static readonly Counter<long> s_leaseRenewFailure =
        s_meter.CreateCounter<long>("lease.renew.failure");
    private static readonly Histogram<double> s_activationDuration =
        s_meter.CreateHistogram<double>("responsibility.activation.duration", "ms");
    private static readonly Counter<long> s_migrationCounter =
        s_meter.CreateCounter<long>("responsibility.migration.count");
    private static readonly Counter<long> s_failureCounter =
        s_meter.CreateCounter<long>("responsibility.failure.count");

    private static long s_aliveNodeCount;
    private static long s_suspectNodeCount;
    private readonly ConcurrentQueue<ClusterOperationsEvent> _events = new();
    private long _sequence;
    private long _assignments;
    private long _rebalances;
    private long _leaseAcquireSuccess;
    private long _leaseAcquireFailure;
    private long _leaseRenewFailure;
    private long _migrations;
    private long _failures;

    public void RecordNodeCounts(IReadOnlyList<NodeDescriptor> nodes)
    {
        long alive = nodes.LongCount(static node => node.Status == ClusterMemberStatus.Alive);
        long suspect = nodes.LongCount(static node => node.Status == ClusterMemberStatus.Suspect);
        Volatile.Write(ref s_aliveNodeCount, alive);
        Volatile.Write(ref s_suspectNodeCount, suspect);
    }

    public void RecordNodeLifecycle(NodeDescriptor node, string state, string reason)
    {
        Enqueue(
            ClusterOperationsEventKind.NodeLifecycle,
            state,
            reason,
            node.NodeId.Value,
            null,
            null,
            null);
        logger.LogInformation(
            "cluster-node-lifecycle NodeId={NodeId} InstanceId={InstanceId} State={State} Reason={Reason}",
            node.NodeId.Value,
            node.InstanceId,
            state,
            reason);
    }

    public void RecordSchedulerDecision(
        ResponsibilityAssignmentSnapshot previous,
        ResponsibilityAssignmentSnapshot current)
    {
        long assignmentCount = current.Assignments.Count;
        Interlocked.Add(ref _assignments, assignmentCount);
        s_assignmentCounter.Add(assignmentCount);
        int migrations = current.Assignments.Count(assignment =>
            previous.Assignments.Any(previousAssignment =>
                previousAssignment.ResponsibilityId == assignment.ResponsibilityId
                && previousAssignment.Replica == assignment.Replica
                && previousAssignment.NodeId != assignment.NodeId));
        if (migrations > 0)
        {
            Interlocked.Increment(ref _rebalances);
            Interlocked.Add(ref _migrations, migrations);
            s_rebalanceCounter.Add(1);
            s_migrationCounter.Add(migrations);
        }
        Enqueue(
            ClusterOperationsEventKind.SchedulerDecision,
            current.Enabled ? "active" : "disabled",
            current.Unassigned.Count == 0 ? "reconciled" : "unassigned-responsibilities",
            null,
            null,
            null,
            null);
        logger.LogInformation(
            "cluster-scheduler-decision Generation={Generation} Enabled={Enabled} Assignments={Assignments} Unassigned={Unassigned} Migrations={Migrations}",
            current.Generation,
            current.Enabled,
            current.Assignments.Count,
            current.Unassigned.Count,
            migrations);
    }

    public void RecordResponsibilityTransition(
        ResponsibilityAssignment assignment,
        string state,
        string reason,
        string? sourceNodeId = null)
    {
        if (StringComparer.Ordinal.Equals(state, "failed"))
        {
            Interlocked.Increment(ref _failures);
            s_failureCounter.Add(1);
        }
        Enqueue(
            ClusterOperationsEventKind.ResponsibilityTransition,
            state,
            reason,
            assignment.NodeId.Value,
            assignment.ResponsibilityId.Value,
            sourceNodeId,
            assignment.NodeId.Value);
        logger.LogInformation(
            "cluster-responsibility-transition ResponsibilityId={ResponsibilityId} Replica={Replica} NodeId={NodeId} State={State} Reason={Reason}",
            assignment.ResponsibilityId.Value,
            assignment.Replica,
            assignment.NodeId.Value,
            state,
            reason);
    }

    public void RecordLease(string operation, bool success, ResponsibilityAssignment? assignment)
    {
        switch (operation)
        {
            case "acquire" when success:
                Interlocked.Increment(ref _leaseAcquireSuccess);
                s_leaseAcquireSuccess.Add(1);
                break;
            case "acquire":
                Interlocked.Increment(ref _leaseAcquireFailure);
                s_leaseAcquireFailure.Add(1);
                break;
            case "renew" when !success:
                Interlocked.Increment(ref _leaseRenewFailure);
                s_leaseRenewFailure.Add(1);
                break;
        }
        Enqueue(
            ClusterOperationsEventKind.Lease,
            success ? "succeeded" : "failed",
            operation,
            assignment?.NodeId.Value,
            assignment?.ResponsibilityId.Value,
            null,
            null);
    }

    public void RecordActivationDuration(TimeSpan elapsed)
        => s_activationDuration.Record(elapsed.TotalMilliseconds);

    public void RecordOperatorAction(
        string state,
        string reason,
        string? nodeId = null,
        string? responsibilityId = null)
    {
        Enqueue(
            ClusterOperationsEventKind.OperatorAction,
            state,
            reason,
            nodeId,
            responsibilityId,
            null,
            null);
        logger.LogInformation(
            "cluster-operator-action NodeId={NodeId} ResponsibilityId={ResponsibilityId} State={State} Reason={Reason}",
            nodeId,
            responsibilityId,
            state,
            reason);
    }

    public IReadOnlyList<ClusterOperationsEvent> RecentEvents(int limit)
    {
        if (limit is <= 0 or > EventCapacity)
        {
            throw new ArgumentOutOfRangeException(nameof(limit));
        }
        return _events
            .Reverse()
            .Take(limit)
            .OrderBy(static clusterEvent => clusterEvent.Sequence)
            .ToArray();
    }

    public ClusterOperationsMetricSnapshot CaptureMetrics()
        => new(
            Volatile.Read(ref s_aliveNodeCount),
            Volatile.Read(ref s_suspectNodeCount),
            Interlocked.Read(ref _assignments),
            Interlocked.Read(ref _rebalances),
            Interlocked.Read(ref _leaseAcquireSuccess),
            Interlocked.Read(ref _leaseAcquireFailure),
            Interlocked.Read(ref _leaseRenewFailure),
            Interlocked.Read(ref _migrations),
            Interlocked.Read(ref _failures));

    private static IEnumerable<Measurement<long>> ObserveAliveNodes()
        => [new Measurement<long>(Volatile.Read(ref s_aliveNodeCount))];

    private static IEnumerable<Measurement<long>> ObserveSuspectNodes()
        => [new Measurement<long>(Volatile.Read(ref s_suspectNodeCount))];

    private void Enqueue(
        ClusterOperationsEventKind kind,
        string state,
        string reason,
        string? nodeId,
        string? responsibilityId,
        string? sourceNodeId,
        string? targetNodeId)
    {
        string? traceId = Activity.Current is { } activity
            ? activity.TraceId.ToHexString()
            : null;
        _events.Enqueue(new ClusterOperationsEvent(
            Interlocked.Increment(ref _sequence),
            timeProvider.GetUtcNow(),
            kind,
            state,
            reason,
            nodeId,
            responsibilityId,
            sourceNodeId,
            targetNodeId,
            traceId));
        while (_events.Count > EventCapacity)
        {
            _events.TryDequeue(out _);
        }
    }
}

public sealed class AdaptiveSchedulerControlState
{
    private int _schedulingAllowed = 1;

    public bool SchedulingAllowed => Volatile.Read(ref _schedulingAllowed) == 1;

    public void SetSchedulingAllowed(bool allowed)
        => Volatile.Write(ref _schedulingAllowed, allowed ? 1 : 0);
}

public sealed record ClusterHealthSnapshot(
    string Status,
    string Code,
    int AliveNodes,
    int SuspectNodes,
    int DeadNodes,
    int DrainingNodes,
    int MaintenanceNodes,
    int UnassignedResponsibilities);

public sealed record ClusterOperationsSnapshot(
    bool Enabled,
    string Mode,
    string CurrentNodeId,
    bool SchedulingAllowed,
    ClusterHealthSnapshot Health,
    IReadOnlyList<NodeDescriptor> Nodes,
    ResponsibilityAssignmentSnapshot Scheduler,
    IReadOnlyList<DistributedLeaseDiagnostic> Leases,
    IReadOnlyList<DistributedTaskDiagnostic> Tasks,
    IReadOnlyList<ClusterOperationsEvent> Events,
    ClusterOperationsMetricSnapshot Metrics);

public sealed class ClusterOperationsService(
    IClusterMembershipStore membership,
    IResponsibilityAssignmentSnapshotProvider assignments,
    IDistributedStateControlDiagnostics stateControl,
    ClusterMembershipOptions cluster,
    AdaptiveSchedulerControlState schedulerControl,
    IClusterOperationsTelemetry telemetry,
    TimeProvider timeProvider)
{
    public async ValueTask<ClusterOperationsSnapshot> CaptureAsync(
        CancellationToken cancellationToken)
    {
        IReadOnlyList<NodeDescriptor> nodes =
            await membership.ListNodesAsync(cancellationToken).ConfigureAwait(false);
        if (cluster.Mode == ClusterRuntimeMode.Single && nodes.Count == 0)
        {
            nodes =
            [
                NodeDescriptor.Create(
                    cluster.NodeId,
                    cluster.InstanceId,
                    cluster.Version,
                    cluster.StartedAt,
                    cluster.Mode,
                    ClusterCapabilities.All.ToArray()) with
                {
                    LastHeartbeatAt = timeProvider.GetUtcNow()
                }
            ];
        }
        telemetry.RecordNodeCounts(nodes);
        ResponsibilityAssignmentSnapshot scheduler = assignments.Capture();
        IReadOnlyList<DistributedLeaseDiagnostic> leases =
            await stateControl.ListLeasesAsync(200, cancellationToken).ConfigureAwait(false);
        IReadOnlyList<DistributedTaskDiagnostic> tasks =
            await stateControl.ListTasksAsync(200, cancellationToken).ConfigureAwait(false);
        ClusterHealthSnapshot health = BuildHealth(nodes, scheduler);
        return new ClusterOperationsSnapshot(
            cluster.Enabled,
            ClusterMembershipWireNames.Mode(cluster.Mode),
            cluster.NodeId.Value,
            schedulerControl.SchedulingAllowed,
            health,
            nodes,
            scheduler,
            leases,
            tasks,
            telemetry.RecentEvents(200),
            telemetry.CaptureMetrics());
    }

    public async ValueTask<NodeDescriptor> SetNodeStateAsync(
        NodeId nodeId,
        ClusterMemberStatus status,
        string reason,
        CancellationToken cancellationToken)
    {
        if (status is not ClusterMemberStatus.Alive
            and not ClusterMemberStatus.Draining
            and not ClusterMemberStatus.Maintenance)
        {
            throw new ArgumentOutOfRangeException(nameof(status));
        }
        if (cluster.Mode == ClusterRuntimeMode.Single)
        {
            throw new InvalidOperationException("cluster_operation_not_applicable_single");
        }
        NodeDescriptor node = (await membership.ListNodesAsync(cancellationToken).ConfigureAwait(false))
            .SingleOrDefault(candidate => candidate.NodeId == nodeId)
            ?? throw new KeyNotFoundException("cluster_node_not_found");
        await membership.SetNodeStatusAsync(
            node.NodeId,
            node.InstanceId,
            status,
            cancellationToken).ConfigureAwait(false);
        NodeDescriptor updated = node with
        {
            Status = status
        };
        telemetry.RecordNodeLifecycle(
            updated,
            ClusterMembershipWireNames.Status(status),
            NormalizeReason(reason));
        telemetry.RecordOperatorAction(
            ClusterMembershipWireNames.Status(status),
            NormalizeReason(reason),
            nodeId.Value);
        return updated;
    }

    public bool SetSchedulingAllowed(bool allowed, string reason)
    {
        schedulerControl.SetSchedulingAllowed(allowed);
        telemetry.RecordOperatorAction(
            allowed ? "scheduling-enabled" : "scheduling-disabled",
            NormalizeReason(reason));
        return schedulerControl.SchedulingAllowed;
    }

    public async ValueTask<bool> ReleaseExpiredLeaseAsync(
        LeaseId leaseId,
        string reason,
        CancellationToken cancellationToken)
    {
        bool released = await stateControl
            .ReleaseExpiredLeaseAsync(leaseId, cancellationToken)
            .ConfigureAwait(false);
        telemetry.RecordOperatorAction(
            released ? "expired-lease-released" : "expired-lease-not-found",
            NormalizeReason(reason));
        return released;
    }

    private static ClusterHealthSnapshot BuildHealth(
        IReadOnlyList<NodeDescriptor> nodes,
        ResponsibilityAssignmentSnapshot scheduler)
    {
        int alive = nodes.Count(static node => node.Status == ClusterMemberStatus.Alive);
        int suspect = nodes.Count(static node => node.Status == ClusterMemberStatus.Suspect);
        int dead = nodes.Count(static node => node.Status == ClusterMemberStatus.Dead);
        int draining = nodes.Count(static node => node.Status == ClusterMemberStatus.Draining);
        int maintenance = nodes.Count(static node => node.Status == ClusterMemberStatus.Maintenance);
        int unassigned = scheduler.Unassigned.Count;
        (string status, string code) = alive == 0
            ? ("unhealthy", "cluster_no_alive_nodes")
            : dead > 0 || suspect > 0 || unassigned > 0
                ? ("degraded", "cluster_attention_required")
                : ("healthy", "cluster_ready");
        return new ClusterHealthSnapshot(
            status,
            code,
            alive,
            suspect,
            dead,
            draining,
            maintenance,
            unassigned);
    }

    private static string NormalizeReason(string reason)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(reason);
        string normalized = reason.Trim();
        if (normalized.Length > 160 || normalized.Any(char.IsControl))
        {
            throw new ArgumentOutOfRangeException(nameof(reason));
        }
        return normalized;
    }
}
