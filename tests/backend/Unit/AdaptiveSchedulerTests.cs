using System.Text.Json;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Distributed.Cluster;
using FsusBlog.Server.Infrastructure.Distributed.Modules;
using FsusBlog.Server.Infrastructure.Distributed.Scheduling;
using FsusBlog.Server.Infrastructure.Distributed.StateControl;
using FsusBlog.Server.Modules.Endpoints;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AdaptiveSchedulerTests
{
    private static readonly DateTimeOffset s_now =
        new(2026, 7, 24, 4, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Catalog_UsesStableResponsibilityModelsAndClosedCapabilities()
    {
        Assert.Equal(7, CoreResponsibilityCatalog.All.Count);
        Assert.Equal(7, CoreResponsibilityCatalog.All.Select(static item => item.Id).Distinct().Count());
        Assert.All(CoreResponsibilityCatalog.All, descriptor =>
        {
            descriptor.Validate();
            Assert.Contains(descriptor.RequiredCapability, ClusterCapabilities.All);
            Assert.InRange(descriptor.MinReplicas, 1, descriptor.MaxReplicas);
        });
        Assert.Equal(
            ResponsibilityKind.Consumer,
            CoreResponsibilityCatalog.CommentAuditConsumer.Kind);
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            new ResponsibilityResourceProfile(
                double.NaN, 1, 1, 1, 1, 1).Validate());
        Assert.Throws<ArgumentOutOfRangeException>(() =>
            new SchedulingPolicy(
                TimeSpan.Zero,
                TimeSpan.Zero,
                double.PositiveInfinity,
                0,
                0.8,
                0.4).Validate());
    }

    [Fact]
    public async Task SingleMode_AssignsEverythingLocallyWithoutMembershipLookup()
    {
        var membership = new MembershipStore();
        var clock = new ManualTimeProvider(s_now);
        AdaptiveResponsibilityScheduler scheduler = Scheduler(
            Cluster(ClusterRuntimeMode.Single),
            membership,
            clock);

        ResponsibilityAssignmentSnapshot snapshot = await scheduler.PlanAsync(
            Empty(ClusterRuntimeMode.Single),
            CancellationToken.None);

        Assert.Equal(0, membership.ListCalls);
        Assert.Equal(CoreResponsibilityCatalog.All.Count, snapshot.Assignments.Count);
        Assert.All(snapshot.Assignments, assignment =>
            Assert.Equal(new NodeId("local"), assignment.NodeId));
        Assert.All(snapshot.Assignments, assignment =>
            Assert.Equal("single-local-fast-path", assignment.Reason));
    }

    [Fact]
    public async Task HotDisable_EmptiesAssignmentsWithoutMembershipLookup()
    {
        var membership = new MembershipStore(
            Node("node-a", ClusterCapabilities.WebApi));
        var scheduler = new AdaptiveResponsibilityScheduler(
            membership,
            Cluster(ClusterRuntimeMode.Adaptive),
            new FixedOptionsSource(enabled: false),
            new ManualTimeProvider(s_now));

        ResponsibilityAssignmentSnapshot snapshot = await scheduler.PlanAsync(
            Empty(ClusterRuntimeMode.Adaptive),
            CancellationToken.None);

        Assert.False(snapshot.Enabled);
        Assert.Empty(snapshot.Assignments);
        Assert.Equal(0, membership.ListCalls);
    }

    [Fact]
    public async Task StaticRole_ReflectsFixedHealthyCapabilitiesWithoutLoadMigration()
    {
        NodeDescriptor overloaded = Node(
            "node-a",
            ClusterCapabilities.CommentAudit,
            cpu: 99);
        NodeDescriptor healthy = Node(
            "node-b",
            ClusterCapabilities.CommentAudit,
            cpu: 2);
        NodeDescriptor draining = Node(
            "node-c",
            ClusterCapabilities.CommentAudit,
            status: ClusterMemberStatus.Draining);
        AdaptiveResponsibilityScheduler scheduler = Scheduler(
            Cluster(ClusterRuntimeMode.StaticRole),
            new MembershipStore(overloaded, healthy, draining),
            new ManualTimeProvider(s_now));

        ResponsibilityAssignmentSnapshot snapshot = await scheduler.PlanAsync(
            Empty(ClusterRuntimeMode.StaticRole),
            CancellationToken.None);

        ResponsibilityAssignment[] audit = snapshot.Assignments
            .Where(assignment =>
                assignment.ResponsibilityId == CoreResponsibilityCatalog.CommentAuditConsumer.Id)
            .ToArray();
        Assert.Equal(["node-a", "node-b"], audit.Select(static item => item.NodeId.Value));
        Assert.DoesNotContain(snapshot.Assignments, assignment => assignment.NodeId.Value == "node-c");
    }

    [Fact]
    public async Task Adaptive_UsesCapabilityHealthAndWeightedLoad()
    {
        NodeDescriptor highLoad = Node(
            "node-a",
            ClusterCapabilities.SearchIndexer,
            cpu: 88,
            memory: 91,
            queue: 700,
            p99: 1400);
        NodeDescriptor lowLoad = Node(
            "node-b",
            ClusterCapabilities.SearchIndexer,
            cpu: 9,
            memory: 15,
            queue: 4,
            p99: 20);
        NodeDescriptor suspect = Node(
            "node-c",
            ClusterCapabilities.SearchIndexer,
            status: ClusterMemberStatus.Suspect);
        NodeDescriptor wrongCapability = Node(
            "node-d",
            ClusterCapabilities.MediaProcessor);
        AdaptiveResponsibilityScheduler scheduler = Scheduler(
            Cluster(ClusterRuntimeMode.Adaptive),
            new MembershipStore(highLoad, lowLoad, suspect, wrongCapability),
            new ManualTimeProvider(s_now));

        ResponsibilityAssignmentSnapshot snapshot = await scheduler.PlanAsync(
            Empty(ClusterRuntimeMode.Adaptive),
            CancellationToken.None);

        ResponsibilityAssignment search = Assert.Single(
            snapshot.Assignments,
            assignment =>
                assignment.ResponsibilityId == CoreResponsibilityCatalog.SearchIndexerWorker.Id);
        Assert.Equal("node-b", search.NodeId.Value);
    }

    [Fact]
    public async Task CooldownAndHysteresis_PreventSmallOrEarlyMigration()
    {
        var clock = new ManualTimeProvider(s_now);
        NodeDescriptor current = Node(
            "node-a",
            ClusterCapabilities.MediaProcessor,
            cpu: 35,
            memory: 35);
        NodeDescriptor slightlyBetter = Node(
            "node-b",
            ClusterCapabilities.MediaProcessor,
            cpu: 25,
            memory: 25);
        AdaptiveResponsibilityScheduler scheduler = Scheduler(
            Cluster(ClusterRuntimeMode.Adaptive),
            new MembershipStore(current, slightlyBetter),
            clock);
        ResponsibilityDescriptor descriptor = CoreResponsibilityCatalog.MediaProcessorWorker;
        ResponsibilityAssignmentSnapshot previous = Snapshot(
            new ResponsibilityAssignment(
                descriptor.Id,
                descriptor.RequiredCapability,
                0,
                current.NodeId,
                s_now,
                0.4,
                "previous"));

        ResponsibilityAssignmentSnapshot duringCooldown =
            await scheduler.PlanAsync(previous, CancellationToken.None);
        clock.Advance(TimeSpan.FromMinutes(2));
        ResponsibilityAssignmentSnapshot afterCooldown =
            await scheduler.PlanAsync(duringCooldown, CancellationToken.None);

        Assert.Equal(
            "node-a",
            Assignment(duringCooldown, descriptor.Id).NodeId.Value);
        Assert.Equal(
            "node-a",
            Assignment(afterCooldown, descriptor.Id).NodeId.Value);
    }

    [Fact]
    public async Task MaterialImprovementAfterCooldown_MigratesButDeadNodeReassignsImmediately()
    {
        var clock = new ManualTimeProvider(s_now.AddMinutes(2));
        ResponsibilityDescriptor descriptor = CoreResponsibilityCatalog.AntispamInferenceWorker;
        ResponsibilityAssignment previousAssignment = new(
            descriptor.Id,
            descriptor.RequiredCapability,
            0,
            new NodeId("node-a"),
            s_now,
            0.95,
            "previous");
        NodeDescriptor overloaded = Node(
            "node-a",
            descriptor.RequiredCapability,
            cpu: 100,
            memory: 100,
            queue: 1000,
            p99: 2000,
            error: 1,
            io: 100);
        NodeDescriptor healthy = Node("node-b", descriptor.RequiredCapability);
        AdaptiveResponsibilityScheduler scheduler = Scheduler(
            Cluster(ClusterRuntimeMode.Adaptive),
            new MembershipStore(overloaded, healthy),
            clock);

        ResponsibilityAssignmentSnapshot migrated = await scheduler.PlanAsync(
            Snapshot(previousAssignment),
            CancellationToken.None);
        Assert.Equal("node-b", Assignment(migrated, descriptor.Id).NodeId.Value);

        NodeDescriptor dead = overloaded with
        {
            Status = ClusterMemberStatus.Dead
        };
        AdaptiveResponsibilityScheduler failureScheduler = Scheduler(
            Cluster(ClusterRuntimeMode.Adaptive),
            new MembershipStore(dead, healthy),
            new ManualTimeProvider(s_now.AddSeconds(1)));
        ResponsibilityAssignmentSnapshot reassigned = await failureScheduler.PlanAsync(
            Snapshot(previousAssignment),
            CancellationToken.None);
        Assert.Equal("node-b", Assignment(reassigned, descriptor.Id).NodeId.Value);
    }

    [Fact]
    public async Task PressureScalesOutAndLowPressureScalesInAfterCooldown()
    {
        ResponsibilityDescriptor descriptor = CoreResponsibilityCatalog.SearchIndexerWorker;
        var clock = new ManualTimeProvider(s_now);
        NodeDescriptor hotA = Node(
            "node-a",
            descriptor.RequiredCapability,
            cpu: 100,
            memory: 100,
            queue: 1000,
            p99: 2000,
            error: 1,
            io: 100);
        NodeDescriptor hotB = Node(
            "node-b",
            descriptor.RequiredCapability,
            cpu: 100,
            memory: 100,
            queue: 1000,
            p99: 2000,
            error: 1,
            io: 100);
        AdaptiveResponsibilityScheduler hotScheduler = Scheduler(
            Cluster(ClusterRuntimeMode.Adaptive),
            new MembershipStore(hotA, hotB),
            clock);

        ResponsibilityAssignmentSnapshot scaledOut = await hotScheduler.PlanAsync(
            Empty(ClusterRuntimeMode.Adaptive),
            CancellationToken.None);
        Assert.Equal(2, scaledOut.Assignments.Count(
            assignment => assignment.ResponsibilityId == descriptor.Id));

        clock.Advance(TimeSpan.FromMinutes(2));
        AdaptiveResponsibilityScheduler coolScheduler = Scheduler(
            Cluster(ClusterRuntimeMode.Adaptive),
            new MembershipStore(
                Node("node-a", descriptor.RequiredCapability),
                Node("node-b", descriptor.RequiredCapability)),
            clock);
        ResponsibilityAssignmentSnapshot scaledIn = await coolScheduler.PlanAsync(
            scaledOut,
            CancellationToken.None);
        Assert.Single(
            scaledIn.Assignments,
            assignment => assignment.ResponsibilityId == descriptor.Id);
    }

    [Fact]
    public async Task Runtime_UsesLeaseFencingAndReleaseToControlModuleActivation()
    {
        var clock = new ManualTimeProvider(s_now);
        var state = new InMemoryDistributedStateControlStore(clock);
        ClusterMembershipOptions cluster = Cluster(ClusterRuntimeMode.Adaptive);
        var runtime = new LeasedModuleResponsibilityRuntime(
            state,
            cluster,
            new FixedOptionsSource(),
            clock);
        ResponsibilityDescriptor descriptor = CoreResponsibilityCatalog.CommentAuditConsumer;
        ResponsibilityAssignment assignment = new(
            descriptor.Id,
            descriptor.RequiredCapability,
            0,
            cluster.NodeId,
            s_now,
            0,
            "test");

        await runtime.ActivateAsync(assignment, CancellationToken.None);
        ActiveResponsibility active = Assert.Single(
            await runtime.ListActiveAsync(CancellationToken.None));
        Assert.NotNull(active.Assignment.FencingToken);
        Assert.True(runtime.IsCapabilityActive(descriptor.RequiredCapability));

        await runtime.DeactivateAsync(descriptor.Id, CancellationToken.None);
        Assert.Empty(await runtime.ListActiveAsync(CancellationToken.None));
        Assert.False(runtime.IsCapabilityActive(descriptor.RequiredCapability));

        LeaseAcquireResult reacquired = await state.TryAcquireAsync(
            new LeaseKey("responsibility", $"{descriptor.Id.Value}.0"),
            new NodeId("node-b"),
            TimeSpan.FromSeconds(30),
            CancellationToken.None);
        Assert.True(reacquired.Acquired);
        Assert.True(reacquired.Lease!.FencingToken.Value > active.Assignment.FencingToken!.Value.Value);
    }

    [Fact]
    public async Task Reconcile_ActivatesLocalAssignmentsAndHotDisableDeactivates()
    {
        ResponsibilityDescriptor descriptor = CoreResponsibilityCatalog.SseFanoutWorker;
        ClusterMembershipOptions cluster = Cluster(ClusterRuntimeMode.Adaptive);
        var options = new MutableOptionsSource();
        var runtime = new RecordingRuntime();
        var state = new ResponsibilityAssignmentState(cluster, new ManualTimeProvider(s_now));
        var planner = new ScriptedPlanner(
            Snapshot(new ResponsibilityAssignment(
                descriptor.Id,
                descriptor.RequiredCapability,
                0,
                cluster.NodeId,
                s_now,
                0,
                "test")),
            new ResponsibilityAssignmentSnapshot(
                2,
                s_now.AddSeconds(10),
                "adaptive",
                false,
                [],
                []),
            Snapshot(new ResponsibilityAssignment(
                descriptor.Id,
                descriptor.RequiredCapability,
                0,
                cluster.NodeId,
                s_now.AddSeconds(20),
                0,
                "test-reactivated")));
        var hosted = new ResponsibilityAssignmentHostedService(
            planner,
            runtime,
            state,
            cluster,
            options,
            new ManualTimeProvider(s_now),
            NullLogger<ResponsibilityAssignmentHostedService>.Instance);

        await hosted.ReconcileOnceAsync(CancellationToken.None);
        Assert.True(runtime.IsCapabilityActive(descriptor.RequiredCapability));
        await hosted.ReconcileOnceAsync(CancellationToken.None);
        Assert.False(runtime.IsCapabilityActive(descriptor.RequiredCapability));
        Assert.False(state.Capture().Enabled);
        await hosted.ReconcileOnceAsync(CancellationToken.None);
        Assert.True(runtime.IsCapabilityActive(descriptor.RequiredCapability));
        await hosted.StopAsync(CancellationToken.None);
        Assert.False(runtime.IsCapabilityActive(descriptor.RequiredCapability));
    }

    [Fact]
    public async Task AdaptiveModuleRouting_RequiresAssignmentWhileSingleRemainsLocalFastPath()
    {
        ResponsibilityDescriptor descriptor = CoreResponsibilityCatalog.WebApiListener;
        ClusterMembershipOptions adaptive = Cluster(ClusterRuntimeMode.Adaptive);
        NodeDescriptor local = Node("local", ClusterCapabilities.WebApi);
        var activation = new RecordingRuntime();
        var resolver = new ClusterModuleRouteResolver(
            adaptive,
            new MembershipStore(local),
            activation);

        await Assert.ThrowsAsync<ModuleRouteUnavailableException>(async () =>
            await resolver.ResolveAsync(
                CoreModuleContracts.Notification,
                ModuleDeliveryKind.RequestResponse,
                CancellationToken.None));

        await activation.ActivateAsync(
            new ResponsibilityAssignment(
                descriptor.Id,
                descriptor.RequiredCapability,
                0,
                adaptive.NodeId,
                s_now,
                0,
                "test"),
            CancellationToken.None);
        ModuleInvocationRoute route = await resolver.ResolveAsync(
            CoreModuleContracts.Notification,
            ModuleDeliveryKind.RequestResponse,
            CancellationToken.None);
        Assert.Equal(ModuleInvocationPathKind.Local, route.Path);

        var singleMembership = new MembershipStore();
        var single = new ClusterModuleRouteResolver(
            Cluster(ClusterRuntimeMode.Single),
            singleMembership,
            new RecordingRuntime());
        Assert.Equal(
            ModuleInvocationPathKind.Local,
            (await single.ResolveAsync(
                CoreModuleContracts.Notification,
                ModuleDeliveryKind.RequestResponse,
                CancellationToken.None)).Path);
        Assert.Equal(0, singleMembership.ListCalls);
    }

    [Theory]
    [InlineData("single", false)]
    [InlineData("static-role", true)]
    [InlineData("adaptive", true)]
    public void DependencyInjection_RegistersRuntimeAndOnlyStartsCoordinatorWhenNeeded(
        string mode,
        bool expectedHosted)
    {
        var services = new ServiceCollection();
        IConfiguration configuration = Configuration(
            ("RuntimeMode:Mode", mode),
            ("RuntimeMode:StaticRoles:0", "web"),
            ("Runtime:Cluster:Capabilities:0", "web.api"));
        services.AddFsusDistributedStateControl(configuration);
        services.AddSingleton<IClusterMembershipStore>(new MembershipStore());
        services.AddFsusAdaptiveScheduler(configuration);

        Assert.Contains(services, descriptor =>
            descriptor.ServiceType == typeof(IResponsibilityRuntime));
        Assert.Equal(
            expectedHosted,
            services.Any(descriptor =>
                descriptor.ServiceType == typeof(IHostedService)
                && descriptor.ImplementationType == typeof(ResponsibilityAssignmentHostedService)));
    }

    [Fact]
    public async Task OperationalEndpoint_EmitsAssignmentGraphWithoutChangingSecurityBoundary()
    {
        ResponsibilityDescriptor descriptor = CoreResponsibilityCatalog.SearchIndexerWorker;
        ResponsibilityAssignmentSnapshot snapshot = Snapshot(
            new ResponsibilityAssignment(
                descriptor.Id,
                descriptor.RequiredCapability,
                0,
                new NodeId("node-a"),
                s_now,
                0.125,
                "adaptive-initial",
                new FencingToken(7)));
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        builder.Services.AddSingleton<IClusterMembershipStore>(
            new MembershipStore(Node("node-a", descriptor.RequiredCapability)));
        builder.Services.AddSingleton(Cluster(ClusterRuntimeMode.Adaptive));
        builder.Services.AddSingleton<IResponsibilityAssignmentSnapshotProvider>(
            new FixedSnapshotProvider(snapshot));
        await using WebApplication application = builder.Build();
        application.MapClusterMembershipEndpoints();
        RouteEndpoint endpoint = Assert.Single(
            ((IEndpointRouteBuilder)application).DataSources
                .SelectMany(static source => source.Endpoints)
                .OfType<RouteEndpoint>());
        var context = new DefaultHttpContext
        {
            RequestServices = application.Services,
            Response =
            {
                Body = new MemoryStream()
            }
        };

        await endpoint.RequestDelegate!(context);
        context.Response.Body.Position = 0;
        using JsonDocument body = await JsonDocument.ParseAsync(context.Response.Body);
        JsonElement scheduler = body.RootElement.GetProperty("scheduler");
        JsonElement assignment = Assert.Single(
            scheduler.GetProperty("assignments").EnumerateArray());

        Assert.Equal("adaptive", scheduler.GetProperty("mode").GetString());
        Assert.Equal(descriptor.Id.Value, assignment.GetProperty("responsibilityId").GetString());
        Assert.Equal("node-a", assignment.GetProperty("nodeId").GetString());
        Assert.Equal(7, assignment.GetProperty("fencingToken").GetInt64());
        Assert.Equal(
            "/api/ops/cluster/nodes",
            endpoint.RoutePattern.RawText);
    }

    private static AdaptiveResponsibilityScheduler Scheduler(
        ClusterMembershipOptions cluster,
        MembershipStore membership,
        TimeProvider clock)
        => new(membership, cluster, new FixedOptionsSource(), clock);

    private static ClusterMembershipOptions Cluster(ClusterRuntimeMode mode)
        => new(
            new NodeId("local"),
            Guid.Parse("11111111-1111-1111-1111-111111111111"),
            "test",
            s_now,
            mode,
            mode == ClusterRuntimeMode.Single
                ? []
                : ClusterCapabilities.All.ToArray(),
            TimeSpan.FromSeconds(10),
            TimeSpan.FromSeconds(30),
            TimeSpan.FromSeconds(90));

    private static NodeDescriptor Node(
        string id,
        CapabilityId capability,
        double cpu = 0,
        double memory = 0,
        long queue = 0,
        double p99 = 0,
        double error = 0,
        double io = 0,
        ClusterMemberStatus status = ClusterMemberStatus.Alive)
        => NodeDescriptor.Create(
            new NodeId(id),
            Guid.NewGuid(),
            "test",
            s_now,
            ClusterRuntimeMode.Adaptive,
            [capability]) with
        {
            Status = status,
            Resources = NodeResourceHints.Empty with
            {
                CpuUsagePercent = cpu,
                MemoryPressurePercent = memory,
                QueueLength = queue,
                P99LatencyMilliseconds = p99,
                RecentErrorRate = error,
                IoPressurePercent = io
            }
        };

    private static ResponsibilityAssignmentSnapshot Empty(ClusterRuntimeMode mode)
        => ResponsibilityAssignmentSnapshot.Empty(mode, s_now, true);

    private static ResponsibilityAssignmentSnapshot Snapshot(
        params ResponsibilityAssignment[] assignments)
        => new(1, s_now, "adaptive", true, assignments, []);

    private static ResponsibilityAssignment Assignment(
        ResponsibilityAssignmentSnapshot snapshot,
        ResponsibilityId id)
        => Assert.Single(
            snapshot.Assignments,
            item => item.ResponsibilityId == id && item.Replica == 0);

    private static IConfiguration Configuration(params (string Key, string Value)[] values)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(values.ToDictionary(
                static item => item.Key,
                static item => (string?)item.Value,
                StringComparer.Ordinal))
            .Build();

    private sealed class MembershipStore(params NodeDescriptor[] nodes) : IClusterMembershipStore
    {
        public int ListCalls
        {
            get; private set;
        }

        public ValueTask<IReadOnlyList<NodeDescriptor>> ListAliveNodesAsync(CancellationToken cancellationToken)
            => ValueTask.FromResult<IReadOnlyList<NodeDescriptor>>(nodes.Where(
                static node => node.Status == ClusterMemberStatus.Alive).ToArray());

        public ValueTask<IReadOnlyList<NodeDescriptor>> ListNodesAsync(CancellationToken cancellationToken)
        {
            ListCalls++;
            return ValueTask.FromResult<IReadOnlyList<NodeDescriptor>>(nodes);
        }

        public ValueTask UpsertNodeAsync(NodeDescriptor node, CancellationToken cancellationToken) => ValueTask.CompletedTask;
        public ValueTask MarkHeartbeatAsync(NodeHeartbeat heartbeat, CancellationToken cancellationToken) => ValueTask.CompletedTask;
        public ValueTask MarkNodeSuspectAsync(NodeId nodeId, CancellationToken cancellationToken) => ValueTask.CompletedTask;
        public ValueTask MarkNodeDeadAsync(NodeId nodeId, CancellationToken cancellationToken) => ValueTask.CompletedTask;
        public ValueTask SetNodeStatusAsync(NodeId nodeId, ClusterMemberStatus status, CancellationToken cancellationToken) => ValueTask.CompletedTask;
        public ValueTask SetNodeStatusAsync(NodeId nodeId, Guid expectedInstanceId, ClusterMemberStatus status, CancellationToken cancellationToken) => ValueTask.CompletedTask;
        public ValueTask DetectFailuresAsync(DateTimeOffset observedAt, TimeSpan suspectAfter, TimeSpan deadAfter, CancellationToken cancellationToken) => ValueTask.CompletedTask;
    }

    private sealed class FixedOptionsSource(bool enabled = true) : IAdaptiveSchedulerRuntimeOptionsSource
    {
        public AdaptiveSchedulerRuntimeOptions Current()
            => new(enabled, TimeSpan.FromSeconds(10), TimeSpan.FromSeconds(30));
    }

    private sealed class MutableOptionsSource : IAdaptiveSchedulerRuntimeOptionsSource
    {
        public AdaptiveSchedulerRuntimeOptions Current()
            => new(true, TimeSpan.FromSeconds(10), TimeSpan.FromSeconds(30));
    }

    private sealed class ManualTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => now;

        public void Advance(TimeSpan duration) => now += duration;
    }

    private sealed class ScriptedPlanner(params ResponsibilityAssignmentSnapshot[] snapshots)
        : IResponsibilityAssignmentPlanner
    {
        private int _index;

        public ValueTask<ResponsibilityAssignmentSnapshot> PlanAsync(
            ResponsibilityAssignmentSnapshot previous,
            CancellationToken cancellationToken)
            => ValueTask.FromResult(snapshots[_index++]);
    }

    private sealed class FixedSnapshotProvider(ResponsibilityAssignmentSnapshot snapshot)
        : IResponsibilityAssignmentSnapshotProvider
    {
        public ResponsibilityAssignmentSnapshot Capture() => snapshot;
    }

    private sealed class RecordingRuntime : IResponsibilityRuntime, IResponsibilityActivationView
    {
        private readonly Dictionary<(ResponsibilityId, int), ActiveResponsibility> _active = [];

        public ValueTask ActivateAsync(
            ResponsibilityAssignment assignment,
            CancellationToken cancellationToken)
        {
            _active[(assignment.ResponsibilityId, assignment.Replica)] =
                new ActiveResponsibility(assignment, s_now, s_now);
            return ValueTask.CompletedTask;
        }

        public ValueTask DeactivateAsync(
            ResponsibilityId responsibilityId,
            CancellationToken cancellationToken)
        {
            foreach ((ResponsibilityId Id, int Replica) key in _active.Keys
                .Where(key => key.Item1 == responsibilityId)
                .ToArray())
            {
                _active.Remove(key);
            }
            return ValueTask.CompletedTask;
        }

        public ValueTask<IReadOnlyList<ActiveResponsibility>> ListActiveAsync(
            CancellationToken cancellationToken)
            => ValueTask.FromResult<IReadOnlyList<ActiveResponsibility>>(
                _active.Values.ToArray());

        public bool IsCapabilityActive(CapabilityId capability)
            => _active.Values.Any(item => item.Assignment.Capability == capability);
    }
}
