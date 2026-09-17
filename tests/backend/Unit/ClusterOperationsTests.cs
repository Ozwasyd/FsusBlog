using FsusBlog.Server.Infrastructure.Distributed.Cluster;
using FsusBlog.Server.Infrastructure.Distributed.Scheduling;
using FsusBlog.Server.Infrastructure.Distributed.StateControl;
using FsusBlog.Server.Modules.Endpoints;

using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ClusterOperationsTests
{
    private static readonly DateTimeOffset s_now =
        new(2026, 7, 24, 8, 0, 0, TimeSpan.Zero);

    [Fact]
    public async Task SingleModeSnapshot_RemainsHealthyWithoutDistributedRegistration()
    {
        var clock = new ManualTimeProvider(s_now);
        var membership = new InMemoryClusterMembershipStore();
        var stateControl = new InMemoryDistributedStateControlStore(clock);
        ClusterMembershipOptions cluster = Cluster(ClusterRuntimeMode.Single);
        ResponsibilityAssignmentSnapshot scheduler =
            ResponsibilityAssignmentSnapshot.Empty(cluster.Mode, s_now, true);
        ClusterOperationsService operations = Operations(
            membership,
            stateControl,
            cluster,
            scheduler,
            clock,
            out _,
            out _);

        ClusterOperationsSnapshot snapshot =
            await operations.CaptureAsync(CancellationToken.None);

        Assert.False(snapshot.Enabled);
        Assert.Equal("single", snapshot.Mode);
        Assert.Equal("healthy", snapshot.Health.Status);
        NodeDescriptor local = Assert.Single(snapshot.Nodes);
        Assert.Equal(cluster.NodeId, local.NodeId);
        Assert.Equal(ClusterMemberStatus.Alive, local.Status);
        Assert.Equal(ClusterCapabilities.All.Count, local.Capabilities.Count);
    }

    [Fact]
    public async Task OperatorControls_DrainMaintainResumeAndHotDisableScheduling()
    {
        var clock = new ManualTimeProvider(s_now);
        var membership = new InMemoryClusterMembershipStore();
        ClusterMembershipOptions cluster = Cluster(ClusterRuntimeMode.Adaptive);
        NodeDescriptor node = NodeDescriptor.Create(
            cluster.NodeId,
            cluster.InstanceId,
            cluster.Version,
            s_now,
            cluster.Mode,
            cluster.Capabilities);
        await membership.UpsertNodeAsync(node, CancellationToken.None);
        var stateControl = new InMemoryDistributedStateControlStore(clock);
        ClusterOperationsService operations = Operations(
            membership,
            stateControl,
            cluster,
            ResponsibilityAssignmentSnapshot.Empty(cluster.Mode, s_now, true),
            clock,
            out AdaptiveSchedulerControlState control,
            out ClusterOperationsTelemetry telemetry);

        NodeDescriptor draining = await operations.SetNodeStateAsync(
            cluster.NodeId,
            ClusterMemberStatus.Draining,
            "planned-drain",
            CancellationToken.None);
        Assert.Equal(ClusterMemberStatus.Draining, draining.Status);
        NodeDescriptor maintenance = await operations.SetNodeStateAsync(
            cluster.NodeId,
            ClusterMemberStatus.Maintenance,
            "storage-maintenance",
            CancellationToken.None);
        Assert.Equal(ClusterMemberStatus.Maintenance, maintenance.Status);
        NodeDescriptor alive = await operations.SetNodeStateAsync(
            cluster.NodeId,
            ClusterMemberStatus.Alive,
            "maintenance-complete",
            CancellationToken.None);
        Assert.Equal(ClusterMemberStatus.Alive, alive.Status);

        Assert.False(operations.SetSchedulingAllowed(false, "incident-containment"));
        Assert.False(control.SchedulingAllowed);
        Assert.True(operations.SetSchedulingAllowed(true, "incident-recovered"));
        Assert.True(control.SchedulingAllowed);
        Assert.Contains(
            telemetry.RecentEvents(20),
            clusterEvent => clusterEvent.Kind == ClusterOperationsEventKind.OperatorAction
                && clusterEvent.State == "scheduling-disabled");
    }

    [Fact]
    public async Task Diagnostics_ExposeLeaseFenceAndCheckpointSummaryWithoutPayload()
    {
        var clock = new ManualTimeProvider(s_now);
        var stateControl = new InMemoryDistributedStateControlStore(clock);
        LeaseAcquireResult acquired = await stateControl.TryAcquireAsync(
            new LeaseKey("search.indexer.worker", "global"),
            new NodeId("node-a"),
            TimeSpan.FromSeconds(30),
            CancellationToken.None);
        DistributedLease lease = Assert.IsType<DistributedLease>(acquired.Lease);
        TaskStartResult started = await stateControl.TryBeginAsync(
            new IdempotencyKey("search-rebuild", "global", "run-7"),
            lease,
            new TaskFailurePolicy(3, TimeSpan.FromSeconds(1), false),
            CancellationToken.None);
        DistributedTaskExecution execution =
            Assert.IsType<DistributedTaskExecution>(started.Execution);
        const string SensitivePayload = """{"cursor":"private-offset-2048"}""";
        await stateControl.SaveCheckpointAsync(
            execution,
            0,
            SensitivePayload,
            CancellationToken.None);

        DistributedLeaseDiagnostic leaseDiagnostic =
            Assert.Single(await stateControl.ListLeasesAsync(10, CancellationToken.None));
        Assert.Equal(lease.FencingToken, leaseDiagnostic.FencingToken);
        Assert.Equal(TimeSpan.FromSeconds(30), leaseDiagnostic.Ttl);
        DistributedTaskDiagnostic taskDiagnostic =
            Assert.Single(await stateControl.ListTasksAsync(10, CancellationToken.None));
        DistributedCheckpointDiagnostic checkpoint =
            Assert.IsType<DistributedCheckpointDiagnostic>(taskDiagnostic.Checkpoint);
        Assert.Equal(1, checkpoint.Version);
        Assert.Equal(64, checkpoint.PayloadSha256.Length);
        Assert.DoesNotContain("private-offset", checkpoint.PayloadSha256, StringComparison.Ordinal);

        clock.Advance(TimeSpan.FromSeconds(31));
        Assert.True(await stateControl.ReleaseExpiredLeaseAsync(
            lease.LeaseId,
            CancellationToken.None));
        Assert.Empty(await stateControl.ListLeasesAsync(10, CancellationToken.None));
    }

    [Fact]
    public void Telemetry_RecordsRebalanceMetricsAndTraceableEvents()
    {
        var telemetry = new ClusterOperationsTelemetry(
            TimeProvider.System,
            NullLogger<ClusterOperationsTelemetry>.Instance);
        ResponsibilityDescriptor descriptor = CoreResponsibilityCatalog.SearchIndexerWorker;
        ResponsibilityAssignment previousAssignment = Assignment(descriptor, "node-a");
        ResponsibilityAssignment currentAssignment = Assignment(descriptor, "node-b");
        var previous = new ResponsibilityAssignmentSnapshot(
            1,
            s_now,
            "adaptive",
            true,
            [previousAssignment],
            []);
        var current = new ResponsibilityAssignmentSnapshot(
            2,
            s_now.AddSeconds(10),
            "adaptive",
            true,
            [currentAssignment],
            []);

        telemetry.RecordSchedulerDecision(previous, current);
        telemetry.RecordResponsibilityTransition(
            currentAssignment,
            "migrating",
            "node-pressure",
            "node-a");
        telemetry.RecordLease("acquire", false, currentAssignment);
        ClusterOperationsMetricSnapshot metrics = telemetry.CaptureMetrics();

        Assert.Equal(1, metrics.SchedulerAssignments);
        Assert.Equal(1, metrics.SchedulerRebalances);
        Assert.Equal(1, metrics.ResponsibilityMigrations);
        Assert.Equal(1, metrics.LeaseAcquireFailure);
        Assert.Contains(
            telemetry.RecentEvents(10),
            clusterEvent => clusterEvent.Kind == ClusterOperationsEventKind.ResponsibilityTransition
                && clusterEvent.SourceNodeId == "node-a"
                && clusterEvent.TargetNodeId == "node-b");
    }

    [Theory]
    [InlineData("alive", ClusterMemberStatus.Alive)]
    [InlineData("draining", ClusterMemberStatus.Draining)]
    [InlineData("maintenance", ClusterMemberStatus.Maintenance)]
    public void OperatorStateParser_AcceptsOnlySafeStates(
        string value,
        ClusterMemberStatus expected)
    {
        Assert.True(ClusterMembershipEndpoints.TryParseOperatorStatus(value, out ClusterMemberStatus status));
        Assert.Equal(expected, status);
        Assert.False(ClusterMembershipEndpoints.TryParseOperatorStatus("dead", out _));
        Assert.False(ClusterMembershipEndpoints.TryParseOperatorStatus("suspect", out _));
    }

    private static ClusterOperationsService Operations(
        IClusterMembershipStore membership,
        IDistributedStateControlDiagnostics stateControl,
        ClusterMembershipOptions cluster,
        ResponsibilityAssignmentSnapshot scheduler,
        TimeProvider clock,
        out AdaptiveSchedulerControlState control,
        out ClusterOperationsTelemetry telemetry)
    {
        control = new AdaptiveSchedulerControlState();
        telemetry = new ClusterOperationsTelemetry(
            clock,
            NullLogger<ClusterOperationsTelemetry>.Instance);
        return new ClusterOperationsService(
            membership,
            new FixedSnapshotProvider(scheduler),
            stateControl,
            cluster,
            control,
            telemetry,
            clock);
    }

    private static ClusterMembershipOptions Cluster(ClusterRuntimeMode mode)
        => new(
            new NodeId("node-local"),
            Guid.Parse("4e3023ee-85cc-4fad-b366-1514cd90c37c"),
            "1.3.0",
            s_now,
            mode,
            mode == ClusterRuntimeMode.Single
                ? []
                : ClusterCapabilities.All.ToArray(),
            TimeSpan.FromSeconds(10),
            TimeSpan.FromSeconds(30),
            TimeSpan.FromSeconds(90));

    private static ResponsibilityAssignment Assignment(
        ResponsibilityDescriptor descriptor,
        string nodeId)
        => new(
            descriptor.Id,
            descriptor.RequiredCapability,
            0,
            new NodeId(nodeId),
            s_now,
            0.2,
            "adaptive-load");

    private sealed class FixedSnapshotProvider(ResponsibilityAssignmentSnapshot snapshot)
        : IResponsibilityAssignmentSnapshotProvider
    {
        public ResponsibilityAssignmentSnapshot Capture() => snapshot;
    }

    private sealed class ManualTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => utcNow;

        public void Advance(TimeSpan duration) => utcNow += duration;
    }
}
