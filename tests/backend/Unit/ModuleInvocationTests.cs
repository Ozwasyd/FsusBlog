using System.Diagnostics;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Distributed.Cluster;
using FsusBlog.Server.Infrastructure.Distributed.Modules;

using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ModuleInvocationTests
{
    [Fact]
    public async Task SingleMode_UsesLocalFastPathWithoutMembershipLookup()
    {
        var membership = new MembershipStore();
        ClusterMembershipOptions cluster = Cluster(ClusterRuntimeMode.Single);
        var resolver = new ClusterModuleRouteResolver(cluster, membership);

        ModuleInvocationRoute route = await resolver.ResolveAsync(
            CoreModuleContracts.Comment,
            ModuleDeliveryKind.RequestResponse,
            CancellationToken.None);

        Assert.Equal(ModuleInvocationPathKind.Local, route.Path);
        Assert.Equal(0, membership.ListAliveCalls);
    }

    [Fact]
    public async Task MultiNode_PrefersLocalCapabilityThenAssignedRemote()
    {
        ClusterMembershipOptions cluster = Cluster(ClusterRuntimeMode.Adaptive);
        var local = Node(cluster.NodeId, ClusterCapabilities.WebApi, queue: 0);
        var remoteLowerQueue = Node(new NodeId("remote-b"), ClusterCapabilities.CommentApi, queue: 9);
        var remoteAssigned = Node(
            new NodeId("remote-a"),
            ClusterCapabilities.CommentApi,
            queue: 20,
            active: true);
        var resolver = new ClusterModuleRouteResolver(
            cluster,
            new MembershipStore(local, remoteLowerQueue, remoteAssigned));

        ModuleInvocationRoute localRoute = await resolver.ResolveAsync(
            CoreModuleContracts.Notification,
            ModuleDeliveryKind.RequestResponse,
            CancellationToken.None);
        ModuleInvocationRoute remoteRoute = await resolver.ResolveAsync(
            CoreModuleContracts.Comment,
            ModuleDeliveryKind.RequestResponse,
            CancellationToken.None);

        Assert.Equal(ModuleInvocationPathKind.Local, localRoute.Path);
        Assert.Equal(ModuleInvocationPathKind.Remote, remoteRoute.Path);
        Assert.Equal("remote-a", remoteRoute.TargetNode?.Value);
    }

    [Theory]
    [InlineData(ModuleDeliveryKind.Queue, ModuleInvocationPathKind.Queue)]
    [InlineData(ModuleDeliveryKind.Event, ModuleInvocationPathKind.Event)]
    public async Task AsyncDelivery_RoutesWithoutNodeLocation(
        ModuleDeliveryKind delivery,
        ModuleInvocationPathKind expected)
    {
        var resolver = new ClusterModuleRouteResolver(
            Cluster(ClusterRuntimeMode.Adaptive),
            new MembershipStore());

        ModuleInvocationRoute route = await resolver.ResolveAsync(
            CoreModuleContracts.Audit,
            delivery,
            CancellationToken.None);

        Assert.Equal(expected, route.Path);
        Assert.Null(route.TargetNode);
    }

    [Fact]
    public async Task LocalInvocation_PreservesTypedContractWithoutSerialization()
    {
        var operation = new EchoOperation();
        var invoker = new ModuleInvoker(
            new FixedResolver(ModuleInvocationPathKind.Local),
            [new LocalModuleInvocationPath([operation])]);
        var request = new EchoRequest("hello");

        EchoResponse response = await invoker.InvokeAsync(
            new ModuleCall<EchoRequest, EchoResponse>(
                CoreModuleContracts.Comment,
                "echo",
                request),
            CancellationToken.None);

        Assert.Same(request, operation.Observed);
        Assert.Equal("hello-ok", response.Value);
    }

    [Fact]
    public void Envelope_PropagatesTraceContextAndBaggage()
    {
        using var source = new ActivitySource("module-test");
        using var listener = new ActivityListener
        {
            ShouldListenTo = activitySource => activitySource.Name == source.Name,
            Sample = static (ref ActivityCreationOptions<ActivityContext> _) =>
                ActivitySamplingResult.AllData
        };
        ActivitySource.AddActivityListener(listener);
        using Activity? activity = source.StartActivity("parent");
        activity!.AddBaggage("tenant", "public");

        ModuleInvocationEnvelope envelope = ModuleInvocationEnvelope.Create(
            new ModuleCall<EchoRequest, EchoResponse>(
                CoreModuleContracts.Comment,
                "echo",
                new EchoRequest("hello")));

        Assert.Equal(activity.Id, envelope.TraceParent);
        Assert.Equal("public", envelope.Baggage["tenant"]);
    }

    [Fact]
    public async Task RemoteInvocation_RetriesOnlyWhenIdempotent()
    {
        var transport = new ScriptedRemoteTransport(
            new IOException("first"),
            new EchoResponse("ok"));
        var path = RemotePath(transport, attempts: 3);

        object? result = await path.InvokeAsync(
            RemoteRoute(),
            Envelope(idempotencyKey: "comment:1:create"),
            CancellationToken.None);

        Assert.Equal("ok", Assert.IsType<EchoResponse>(result).Value);
        Assert.Equal(2, transport.Calls);

        var unsafeTransport = new ScriptedRemoteTransport(new IOException("fail"));
        var unsafePath = RemotePath(unsafeTransport, attempts: 3);
        await Assert.ThrowsAsync<IOException>(async () =>
            await unsafePath.InvokeAsync(
                RemoteRoute(),
                Envelope(idempotencyKey: null),
                CancellationToken.None));
        Assert.Equal(1, unsafeTransport.Calls);
    }

    [Fact]
    public async Task RemoteInvocation_EnforcesTimeoutAndCircuitBreaker()
    {
        var timeoutTransport = new BlockingRemoteTransport();
        var path = RemotePath(timeoutTransport, threshold: 1);
        ModuleInvocationEnvelope envelope = Envelope(idempotencyKey: null) with
        {
            Timeout = TimeSpan.FromMilliseconds(20)
        };

        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            await path.InvokeAsync(RemoteRoute(), envelope, CancellationToken.None));
        await Assert.ThrowsAsync<ModuleCircuitOpenException>(async () =>
            await path.InvokeAsync(RemoteRoute(), envelope, CancellationToken.None));
    }

    [Fact]
    public async Task RemoteInvocation_RejectsWhenCapacityIsFull()
    {
        var transport = new BlockingRemoteTransport();
        var path = RemotePath(transport, concurrency: 1);
        ValueTask<object?> first = path.InvokeAsync(
            RemoteRoute(),
            Envelope(idempotencyKey: null),
            CancellationToken.None);
        await transport.Started.Task.WaitAsync(CancellationToken.None);

        await Assert.ThrowsAsync<ModuleBackpressureException>(async () =>
            await path.InvokeAsync(
                RemoteRoute(),
                Envelope(idempotencyKey: null),
                CancellationToken.None));
        transport.Release.TrySetResult();
        await first;
    }

    [Fact]
    public void Contracts_EnforceVersionAndOwnershipRules()
    {
        var host = new ModuleContractVersion(2, 3);
        Assert.True(host.Accepts(new ModuleContractVersion(2, 0)));
        Assert.False(host.Accepts(new ModuleContractVersion(2, 4)));
        Assert.False(host.Accepts(new ModuleContractVersion(1, 9)));

        Assert.Equal(CoreModuleContracts.All.Count, CoreModuleContracts.All.Select(x => x.Id).Distinct().Count());
        Assert.All(CoreModuleContracts.All, contract => Assert.NotEmpty(contract.OwnedStoragePrefixes));
        Assert.DoesNotContain(
            CoreModuleContracts.All
                .SelectMany(contract => contract.OwnedStoragePrefixes.Select(prefix => (contract.Id, prefix)))
                .GroupBy(static value => value.prefix, StringComparer.Ordinal),
            static group => group.Select(value => value.Id).Distinct().Count() > 1);
    }

    [Fact]
    public void QueueCall_RequiresIdempotencyKey()
    {
        Assert.Throws<InvalidOperationException>(() => ModuleInvocationEnvelope.Create(
            new ModuleCall<EchoRequest, EchoResponse>(
                CoreModuleContracts.Comment,
                "audit",
                new EchoRequest("hello"),
                ModuleDeliveryKind.Queue)));
    }

    [Fact]
    public void DependencyInjection_ActivatesOnlyExplicitTransportPaths()
    {
        var services = new ServiceCollection();
        services.AddSingleton<IClusterMembershipStore>(new MembershipStore());
        services.AddFsusModuleInvocation(new ConfigurationBuilder().Build());
        services.AddFsusRemoteModuleTransport<PassThroughTransport>();
        services.AddFsusQueueModuleTransport<PassThroughTransport>();
        services.AddFsusEventModuleTransport<PassThroughTransport>();

        using ServiceProvider provider = services.BuildServiceProvider(validateScopes: true);
        using IServiceScope scope = provider.CreateScope();
        IModuleInvocationPath[] paths =
            scope.ServiceProvider.GetRequiredService<IEnumerable<IModuleInvocationPath>>().ToArray();

        Assert.Equal(
            [
                ModuleInvocationPathKind.Local,
                ModuleInvocationPathKind.Remote,
                ModuleInvocationPathKind.Queue,
                ModuleInvocationPathKind.Event
            ],
            paths.Select(static path => path.Kind));
        Assert.NotNull(scope.ServiceProvider.GetRequiredService<IModuleInvoker>());
    }

    private static ResilientRemoteModuleInvocationPath RemotePath(
        IRemoteModuleTransport transport,
        int concurrency = 8,
        int attempts = 1,
        int threshold = 5)
        => new(
            transport,
            new RemoteModuleInvocationOptions(
                concurrency,
                attempts,
                threshold,
                TimeSpan.FromMinutes(1),
                TimeSpan.Zero),
            TimeProvider.System);

    private static ModuleInvocationEnvelope Envelope(string? idempotencyKey)
        => ModuleInvocationEnvelope.Create(
            new ModuleCall<EchoRequest, EchoResponse>(
                CoreModuleContracts.Comment,
                "echo",
                new EchoRequest("hello"),
                IdempotencyKey: idempotencyKey));

    private static ModuleInvocationRoute RemoteRoute()
        => new(ModuleInvocationPathKind.Remote, new NodeId("remote"));

    private static ClusterMembershipOptions Cluster(ClusterRuntimeMode mode)
        => new(
            new NodeId("local"),
            Guid.NewGuid(),
            "test",
            DateTimeOffset.UtcNow,
            mode,
            [ClusterCapabilities.WebApi],
            TimeSpan.FromSeconds(10),
            TimeSpan.FromSeconds(30),
            TimeSpan.FromSeconds(90));

    private static NodeDescriptor Node(
        NodeId id,
        CapabilityId capability,
        long queue,
        bool active = false)
        => NodeDescriptor.Create(
            id,
            Guid.NewGuid(),
            "test",
            DateTimeOffset.UtcNow,
            ClusterRuntimeMode.Adaptive,
            [capability]) with
        {
            Resources = NodeResourceHints.Empty with
            {
                QueueLength = queue
            },
            ActiveResponsibilities = active ? [capability] : []
        };

    private sealed record EchoRequest(string Value);

    private sealed record EchoResponse(string Value);

    private sealed class EchoOperation : LocalModuleOperation<EchoRequest, EchoResponse>
    {
        public EchoOperation() : base(CoreModuleContracts.Comment, "echo")
        {
        }

        public EchoRequest? Observed
        {
            get; private set;
        }

        public override ValueTask<EchoResponse> InvokeTypedAsync(
            EchoRequest request,
            CancellationToken cancellationToken)
        {
            Observed = request;
            return ValueTask.FromResult(new EchoResponse($"{request.Value}-ok"));
        }
    }

    private sealed class FixedResolver(ModuleInvocationPathKind path) : IModuleRouteResolver
    {
        public ValueTask<ModuleInvocationRoute> ResolveAsync(
            ModuleContractDescriptor contract,
            ModuleDeliveryKind delivery,
            CancellationToken cancellationToken)
            => ValueTask.FromResult(new ModuleInvocationRoute(path, null));
    }

    private sealed class MembershipStore(params NodeDescriptor[] nodes) : IClusterMembershipStore
    {
        public int ListAliveCalls
        {
            get; private set;
        }

        public ValueTask<IReadOnlyList<NodeDescriptor>> ListAliveNodesAsync(CancellationToken cancellationToken)
        {
            ListAliveCalls++;
            return ValueTask.FromResult<IReadOnlyList<NodeDescriptor>>(nodes);
        }

        public ValueTask<IReadOnlyList<NodeDescriptor>> ListNodesAsync(CancellationToken cancellationToken)
            => ValueTask.FromResult<IReadOnlyList<NodeDescriptor>>(nodes);
        public ValueTask UpsertNodeAsync(NodeDescriptor node, CancellationToken cancellationToken) => ValueTask.CompletedTask;
        public ValueTask MarkHeartbeatAsync(NodeHeartbeat heartbeat, CancellationToken cancellationToken) => ValueTask.CompletedTask;
        public ValueTask MarkNodeSuspectAsync(NodeId nodeId, CancellationToken cancellationToken) => ValueTask.CompletedTask;
        public ValueTask MarkNodeDeadAsync(NodeId nodeId, CancellationToken cancellationToken) => ValueTask.CompletedTask;
        public ValueTask SetNodeStatusAsync(NodeId nodeId, ClusterMemberStatus status, CancellationToken cancellationToken) => ValueTask.CompletedTask;
        public ValueTask SetNodeStatusAsync(NodeId nodeId, Guid expectedInstanceId, ClusterMemberStatus status, CancellationToken cancellationToken) => ValueTask.CompletedTask;
        public ValueTask DetectFailuresAsync(DateTimeOffset observedAt, TimeSpan suspectAfter, TimeSpan deadAfter, CancellationToken cancellationToken) => ValueTask.CompletedTask;
    }

    private sealed class ScriptedRemoteTransport(params object[] outcomes) : IRemoteModuleTransport
    {
        public int Calls
        {
            get; private set;
        }

        public ValueTask<object?> SendAsync(
            RemoteModuleInvocationRequest request,
            CancellationToken cancellationToken)
        {
            object outcome = outcomes[Calls++];
            return outcome is Exception exception
                ? ValueTask.FromException<object?>(exception)
                : ValueTask.FromResult<object?>(outcome);
        }
    }

    private sealed class BlockingRemoteTransport : IRemoteModuleTransport
    {
        public TaskCompletionSource Started
        {
            get;
        } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);
        public TaskCompletionSource Release
        {
            get;
        } =
            new(TaskCreationOptions.RunContinuationsAsynchronously);

        public async ValueTask<object?> SendAsync(
            RemoteModuleInvocationRequest request,
            CancellationToken cancellationToken)
        {
            Started.TrySetResult();
            await Release.Task.WaitAsync(cancellationToken);
            return new EchoResponse("ok");
        }
    }

    private sealed class PassThroughTransport :
        IRemoteModuleTransport,
        IModuleQueueTransport,
        IModuleEventTransport
    {
        public ValueTask<object?> SendAsync(
            RemoteModuleInvocationRequest request,
            CancellationToken cancellationToken)
            => ValueTask.FromResult<object?>(new EchoResponse("remote"));

        public ValueTask<object?> EnqueueAsync(
            ModuleInvocationEnvelope envelope,
            CancellationToken cancellationToken)
            => ValueTask.FromResult<object?>(new EchoResponse("queued"));

        public ValueTask<object?> PublishAsync(
            ModuleInvocationEnvelope envelope,
            CancellationToken cancellationToken)
            => ValueTask.FromResult<object?>(new EchoResponse("published"));
    }
}
