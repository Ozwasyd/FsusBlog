using FsusBlog.Server.Infrastructure.Distributed.Cluster;
using FsusBlog.Server.Infrastructure.Distributed.StateControl;
using FsusBlog.Server.Infrastructure.Plugins;

namespace FsusBlog.Server.Tests;

public sealed class PluginHookDispatcherTests
{
    [Fact]
    public async Task NoRegistration_UsesAllocationLightFastPathWithoutPermissionOrRuntimeCall()
    {
        Fixture fixture = CreateFixture();

        PluginHookDispatchResult result = await fixture.Dispatcher.DispatchAsync(
            Context("comment.beforeCreate"));

        Assert.True(result.Continue);
        Assert.Equal("input", result.Value);
        Assert.Equal(0, result.ExecutedCount);
        Assert.Equal(0, fixture.Runtime.CallCount);
        Assert.Equal(0, fixture.Permissions.DemandCount);
    }

    [Fact]
    public async Task RegisteredHooks_RunByPriorityAndRecheckCapabilityBeforeEveryInvocation()
    {
        Fixture fixture = CreateFixture();
        fixture.Grant("plugin.low", PluginCapability.CommentCreate);
        fixture.Grant("plugin.high", PluginCapability.CommentCreate);
        fixture.Registry.ReplacePlugin(
            "plugin.low", PluginRuntimeType.Lua, [Descriptor(priority: 10)]);
        fixture.Registry.ReplacePlugin(
            "plugin.high", PluginRuntimeType.JavaScript, [Descriptor(priority: 100)]);
        fixture.Runtime.Handler = invocation =>
        {
            string prior = (string)invocation.Context.Payload!;
            return PluginHookResult.Next($"{prior}>{invocation.PluginId}");
        };

        PluginHookDispatchResult result = await fixture.Dispatcher.DispatchAsync(
            Context("comment.beforeCreate"));

        Assert.Equal("input>plugin.high>plugin.low", result.Value);
        Assert.Equal(["plugin.high", "plugin.low"], fixture.Runtime.PluginIds);
        Assert.Equal(2, fixture.Permissions.DemandCount);
        Assert.Equal(2, result.ExecutedCount);
    }

    [Fact]
    public async Task MissingCapability_FollowsFailClosedAndDoesNotEnterRuntime()
    {
        Fixture fixture = CreateFixture();
        fixture.Registry.ReplacePlugin(
            "plugin.guard",
            PluginRuntimeType.Lua,
            [Descriptor(failPolicy: "fail-closed")]);

        PluginHookDispatchException exception = await Assert.ThrowsAsync<PluginHookDispatchException>(
            async () => await fixture.Dispatcher.DispatchAsync(Context("comment.beforeCreate")));

        Assert.Contains("blocked", exception.Message, StringComparison.Ordinal);
        Assert.Equal(0, fixture.Runtime.CallCount);
        Assert.Equal(1, fixture.Permissions.DemandCount);
    }

    [Theory]
    [InlineData("fail-open", PluginIsolationState.Healthy)]
    [InlineData("ignore", PluginIsolationState.Healthy)]
    [InlineData("quarantine", PluginIsolationState.Quarantined)]
    public async Task RuntimeFailure_UsesDeclaredNonBlockingPolicy(
        string failPolicy,
        PluginIsolationState expectedState)
    {
        Fixture fixture = CreateFixture();
        fixture.Grant("plugin.guard", PluginCapability.CommentCreate);
        fixture.Registry.ReplacePlugin(
            "plugin.guard", PluginRuntimeType.Lua, [Descriptor(failPolicy: failPolicy)]);
        fixture.Runtime.Exception = new InvalidOperationException("plugin failure");

        PluginHookDispatchResult result = await fixture.Dispatcher.DispatchAsync(
            Context("comment.beforeCreate"));

        Assert.True(result.Continue);
        Assert.Equal(1, result.FailedCount);
        Assert.Equal(expectedState, fixture.Isolation.GetSnapshot("plugin.guard").State);
    }

    [Fact]
    public async Task GuardResult_StopsRemainingHooks()
    {
        Fixture fixture = CreateFixture();
        fixture.Grant("plugin.first", PluginCapability.ArticleWriteDraft);
        fixture.Grant("plugin.second", PluginCapability.ArticleWriteDraft);
        fixture.Registry.ReplacePlugin(
            "plugin.first",
            PluginRuntimeType.Lua,
            [Descriptor("article.beforePublish", priority: 100)]);
        fixture.Registry.ReplacePlugin(
            "plugin.second",
            PluginRuntimeType.Lua,
            [Descriptor("article.beforePublish", priority: 10)]);
        fixture.Runtime.Handler = static _ => PluginHookResult.Stop("denied");

        PluginHookDispatchResult result = await fixture.Dispatcher.DispatchAsync(
            Context("article.beforePublish"));

        Assert.False(result.Continue);
        Assert.Equal("denied", result.Value);
        Assert.Equal(1, fixture.Runtime.CallCount);
    }

    [Fact]
    public async Task ClusterOnce_IdempotencyAndLeaseExecuteOneOperation()
    {
        var clock = new ManualTimeProvider(DateTimeOffset.Parse("2026-07-24T00:00:00Z"));
        var state = new InMemoryDistributedStateControlStore(clock);
        var options = new ClusterMembershipOptions(
            new NodeId("node-a"),
            Guid.NewGuid(),
            "tests",
            clock.GetUtcNow(),
            ClusterRuntimeMode.Single,
            [],
            TimeSpan.FromSeconds(10),
            TimeSpan.FromSeconds(30),
            TimeSpan.FromSeconds(90));
        var coordinator = new PluginHookScopeCoordinator(state, state, options);
        var registration = new PluginHookRegistration(
            "plugin.worker",
            PluginRuntimeType.Lua,
            Descriptor(
                "scheduler.tick",
                executionMode: "background",
                scope: "cluster-once",
                idempotent: true));
        int calls = 0;

        PluginHookScopeExecution first = await coordinator.ExecuteAsync(
            registration,
            Context("scheduler.tick"),
            _ =>
            {
                calls++;
                return ValueTask.FromResult(PluginHookResult.Next());
            },
            CancellationToken.None);
        PluginHookScopeExecution replay = await coordinator.ExecuteAsync(
            registration,
            Context("scheduler.tick"),
            _ =>
            {
                calls++;
                return ValueTask.FromResult(PluginHookResult.Next());
            },
            CancellationToken.None);

        Assert.True(first.Executed);
        Assert.False(replay.Executed);
        Assert.Equal(1, calls);
    }

    [Fact]
    public void Catalog_ContainsAllCoreDomainsAndClosedExecutionVocabulary()
    {
        Assert.Contains("article.beforeSave", PluginHookCatalog.Names);
        Assert.Contains("comment.beforeAudit", PluginHookCatalog.Names);
        Assert.Contains("search.resultRank", PluginHookCatalog.Names);
        Assert.Contains("media.afterProcess", PluginHookCatalog.Names);
        Assert.Contains("user.beforeLogin", PluginHookCatalog.Names);
        Assert.Contains("scheduler.tick", PluginHookCatalog.Names);
        Assert.Equal(PluginHookScope.Leased, PluginHookWireNames.ParseScope("leased"));
        Assert.Equal(
            PluginHookExecutionMode.Background,
            PluginHookWireNames.ParseExecutionMode("background"));
        Assert.Equal(
            PluginHookFailPolicy.Quarantine,
            PluginHookWireNames.ParseFailPolicy("quarantine"));
    }

    private static Fixture CreateFixture()
    {
        var clock = new ManualTimeProvider(DateTimeOffset.Parse("2026-07-24T00:00:00Z"));
        var registry = new PluginHookRegistry();
        var grants = new InMemoryPluginPermissionGrantStore();
        var permissions = new PluginPermissionManager(grants);
        var isolation = new PluginIsolationController(clock);
        var runtime = new RecordingRuntime();
        var dispatcher = new PluginHookDispatcher(
            registry,
            runtime,
            new DirectScopeCoordinator(),
            permissions,
            isolation,
            clock);
        return new Fixture(registry, grants, permissions, isolation, runtime, dispatcher);
    }

    private static PluginHookContext Context(string name)
        => new(name, "trace-119", "operation-119", "input",
            new Dictionary<string, object?>());

    private static PluginHookDescriptor Descriptor(
        string name = "comment.beforeCreate",
        int priority = 100,
        string failPolicy = "fail-open",
        string executionMode = "sync",
        string scope = "local",
        bool idempotent = true)
        => new()
        {
            Name = name,
            Priority = priority,
            TimeoutMs = 30,
            FailPolicy = failPolicy,
            ExecutionMode = executionMode,
            Scope = scope,
            Idempotent = idempotent
        };

    private sealed record Fixture(
        PluginHookRegistry Registry,
        InMemoryPluginPermissionGrantStore Grants,
        PluginPermissionManager Permissions,
        PluginIsolationController Isolation,
        RecordingRuntime Runtime,
        PluginHookDispatcher Dispatcher)
    {
        public void Grant(string pluginId, PluginCapability capability)
            => Grants.Replace(pluginId, new HashSet<PluginCapability> { capability });
    }

    private sealed class RecordingRuntime : IPluginHookRuntimeInvoker
    {
        public int CallCount
        {
            get; private set;
        }

        public List<string> PluginIds { get; } = [];

        public Func<PluginHookInvocation, PluginHookResult> Handler
        {
            get; set;
        } =
            static invocation => PluginHookResult.Next(invocation.Context.Payload);

        public Exception? Exception
        {
            get; set;
        }

        public ValueTask<PluginHookResult> InvokeAsync(
            PluginHookInvocation invocation,
            CancellationToken cancellationToken)
        {
            CallCount++;
            PluginIds.Add(invocation.PluginId);
            return Exception is null
                ? ValueTask.FromResult(Handler(invocation))
                : ValueTask.FromException<PluginHookResult>(Exception);
        }
    }

    private sealed class DirectScopeCoordinator : IPluginHookScopeCoordinator
    {
        public async ValueTask<PluginHookScopeExecution> ExecuteAsync(
            PluginHookRegistration registration,
            PluginHookContext context,
            Func<CancellationToken, ValueTask<PluginHookResult>> operation,
            CancellationToken cancellationToken)
            => new(true, await operation(cancellationToken));
    }

    private sealed class ManualTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => utcNow;
    }
}
