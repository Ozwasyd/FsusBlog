using System.Text.Json;

using FsusBlog.Server.Infrastructure.Plugins;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests;

public sealed class PluginSecurityTests
{
    [Fact]
    public void CapabilityCatalog_IsClosedTypedAndClassified()
    {
        Assert.Equal(16, Enum.GetValues<PluginCapability>().Length);
        Assert.Equal(
            PluginCapabilityRisk.Safe,
            PluginCapabilityCatalog.GetRisk(PluginCapability.PluginStorageKv));
        Assert.Equal(
            PluginCapabilityRisk.Sensitive,
            PluginCapabilityCatalog.GetRisk(PluginCapability.CommentModerate));
        Assert.False(PluginCapabilityCatalog.TryParse("database.raw", out _));
        Assert.False(PluginCapabilityCatalog.TryParse("clr.unrestricted", out _));
    }

    [Fact]
    public void PermissionManager_DefaultDeniesAndSensitiveGrantRequiresConfirmation()
    {
        var store = new InMemoryPluginPermissionGrantStore();
        var manager = new PluginPermissionManager(store);
        const string PluginId = "fsusblog.plugin.guard";
        PluginPermissionPlan plan = PluginPermissionPlanner.Create(CreateManifest(
            ["plugin.log.write", "comment.moderate"],
            DeniedRawPermissions()));

        Assert.Throws<PluginCapabilityDeniedException>(
            () => manager.Demand(PluginId, PluginCapability.PluginLogWrite));
        Assert.Throws<PluginPermissionApprovalException>(
            () => manager.ReplaceGrants(
                plan,
                [PluginCapability.CommentModerate],
                administratorConfirmedSensitive: false));
        Assert.Throws<PluginPermissionApprovalException>(
            () => manager.ReplaceGrants(
                plan,
                [PluginCapability.ArticleRead],
                administratorConfirmedSensitive: true));

        manager.ReplaceGrants(
            plan,
            [PluginCapability.PluginLogWrite, PluginCapability.CommentModerate],
            administratorConfirmedSensitive: true);

        manager.Demand(PluginId, PluginCapability.PluginLogWrite);
        manager.Demand(PluginId, PluginCapability.CommentModerate);
        Assert.Throws<PluginCapabilityDeniedException>(
            () => manager.Demand(PluginId, PluginCapability.ArticleWriteDraft));
    }

    [Fact]
    public async Task HostApiProxy_ChecksGrantBeforeEveryInvocation()
    {
        var store = new InMemoryPluginPermissionGrantStore();
        var manager = new PluginPermissionManager(store);
        var proxy = new PluginHostApiProxy("fsusblog.plugin.guard", manager);
        int calls = 0;
        PluginPermissionPlan plan = PluginPermissionPlanner.Create(CreateManifest(
            ["comment.read"],
            DeniedRawPermissions()));

        manager.ReplaceGrants(
            plan,
            [PluginCapability.CommentRead],
            administratorConfirmedSensitive: true);
        await proxy.InvokeAsync(
            PluginCapability.CommentRead,
            _ =>
            {
                calls++;
                return ValueTask.CompletedTask;
            });

        manager.ReplaceGrants(
            plan,
            [],
            administratorConfirmedSensitive: true);
        await Assert.ThrowsAsync<PluginCapabilityDeniedException>(
            () => proxy.InvokeAsync(
                    PluginCapability.CommentRead,
                    _ =>
                    {
                        calls++;
                        return ValueTask.CompletedTask;
                    })
                .AsTask());

        Assert.Equal(1, calls);
        Assert.Equal(2, manager.DemandCount);
    }

    [Fact]
    public void PermissionPlan_ExposesRequestsAndFailClosedRawAccess()
    {
        PluginManifest manifest = CreateManifest(
            capabilities: ["plugin.storage.kv", "comment.moderate"],
            permissions: new PluginPermissionDescriptor
            {
                Network = true,
                Filesystem = true,
                Database = "read"
            });

        PluginPermissionPlan plan = PluginPermissionPlanner.Create(manifest);

        Assert.Collection(
            plan.Capabilities,
            item =>
            {
                Assert.Equal(PluginCapability.CommentModerate, item.Capability);
                Assert.True(item.RequiresAdministratorConfirmation);
            },
            item =>
            {
                Assert.Equal(PluginCapability.PluginStorageKv, item.Capability);
                Assert.False(item.RequiresAdministratorConfirmation);
            });
        Assert.Equal(
            ["database.raw", "filesystem.raw", "network.unrestricted"],
            plan.DeniedRawPermissions);
        Assert.False(plan.CanEnable);
        Assert.Throws<PluginPermissionApprovalException>(
            () => new PluginPermissionManager(new InMemoryPluginPermissionGrantStore())
                .ReplaceGrants(
                    plan,
                    [PluginCapability.PluginStorageKv],
                    administratorConfirmedSensitive: true));
    }

    [Fact]
    public void ManifestSchemaCapabilityNames_CannotDriftFromRuntimeCatalog()
    {
        string schemaPath = Path.Combine(
            BackendTestPaths.RepositoryRoot,
            "src",
            "shared",
            "Contracts",
            "Plugins",
            "plugin-manifest.schema.json");
        using JsonDocument schema = JsonDocument.Parse(File.ReadAllBytes(schemaPath));
        string[] schemaNames =
        [
            .. schema.RootElement
                .GetProperty("properties")
                .GetProperty("capabilities")
                .GetProperty("items")
                .GetProperty("enum")
                .EnumerateArray()
                .Select(static item => item.GetString()!)
                .Order(StringComparer.Ordinal)
        ];

        Assert.Equal(PluginCapabilityCatalog.Names, schemaNames);
    }

    [Fact]
    public async Task AdministrativeSnapshot_CombinesVerifiedRequestsGrantsAndIsolation()
    {
        PluginManifest manifest = CreateManifest(
            ["plugin.log.write", "comment.read"],
            DeniedRawPermissions());
        var registry = new FixedPluginRegistry(
            new PluginRegistryEntry(
                manifest,
                PluginInstallState.Enabled,
                Enabled: true,
                PackageBytes: [1],
                PackageSha256: new byte[32],
                InstalledAtUtc: DateTimeOffset.Parse("2026-07-24T00:00:00Z"),
                UpdatedAtUtc: DateTimeOffset.Parse("2026-07-24T00:00:00Z"),
                Version: 2));
        var grants = new PluginPermissionManager(new InMemoryPluginPermissionGrantStore());
        PluginPermissionPlan plan = PluginPermissionPlanner.Create(manifest);
        grants.ReplaceGrants(
            plan,
            [PluginCapability.PluginLogWrite],
            administratorConfirmedSensitive: false);
        var clock = new ManualTimeProvider(DateTimeOffset.Parse("2026-07-24T00:00:00Z"));
        var isolation = new PluginIsolationController(clock);
        for (int count = 0; count < 5; count++)
        {
            isolation.RecordFailure(manifest.Id, criticalHookTimeout: false);
        }
        var service = new PluginSecurityAdministrativeSnapshotService(registry, grants, isolation);

        PluginSecurityAdministrativeSnapshot snapshot = Assert.Single(await service.ListAsync());

        Assert.Equal(PluginInstallState.Enabled, snapshot.InstallState);
        Assert.True(snapshot.Enabled);
        Assert.Equal(PluginRuntimeType.Lua, snapshot.Runtime);
        Assert.Equal(2, snapshot.PermissionPlan.Capabilities.Count);
        Assert.Equal(
            PluginCapability.PluginLogWrite,
            Assert.Single(snapshot.GrantedCapabilities).Capability);
        Assert.Equal(PluginIsolationState.Degraded, snapshot.Isolation.State);
    }

    [Theory]
    [InlineData(PluginRuntimeType.JavaScript)]
    [InlineData(PluginRuntimeType.Lua)]
    public void ScriptSandbox_DefaultProfileNeverExposesClrOrHostInternals(PluginRuntimeType runtime)
    {
        PluginSandboxProfile profile = PluginSandboxPolicy.CreateLevelOne(runtime);

        Assert.Equal(PluginSandboxLevel.Level1, profile.Level);
        Assert.False(profile.AllowClrAccess);
        Assert.False(profile.AllowAssemblyLoad);
        Assert.False(profile.AllowReflection);
        Assert.False(profile.AllowServiceProvider);
        Assert.False(profile.AllowRawFileSystem);
        Assert.False(profile.AllowUnrestrictedNetwork);
        Assert.False(profile.AllowProcessSpawn);
        Assert.Empty(profile.ImportedClrTypes);
    }

    [Fact]
    public void ExecutionBudgetGuard_EnforcesEveryDeclaredResourceBoundary()
    {
        var clock = new ManualTimeProvider(DateTimeOffset.Parse("2026-07-24T00:00:00Z"));
        PluginExecutionBudget budget = PluginExecutionBudget.DefaultFor("comment.beforeCreate") with
        {
            Timeout = TimeSpan.FromMilliseconds(20),
            MemoryBytes = 100,
            InstructionCount = 10,
            MaximumCallDepth = 2,
            OutputBytes = 12,
            LogBytes = 8
        };
        using var guard = new PluginExecutionBudgetGuard(budget, clock);

        guard.ReserveMemory(100);
        Assert.Throws<PluginResourceLimitException>(() => guard.ReserveMemory(1));
        guard.ConsumeInstructions(10);
        Assert.Throws<PluginResourceLimitException>(() => guard.ConsumeInstructions(1));
        using IDisposable first = guard.EnterCall();
        using IDisposable second = guard.EnterCall();
        Assert.Throws<PluginResourceLimitException>(() => guard.EnterCall());
        guard.RecordOutput(12);
        Assert.Throws<PluginResourceLimitException>(() => guard.RecordOutput(1));
        guard.RecordLog(8);
        Assert.Throws<PluginResourceLimitException>(() => guard.RecordLog(1));

        clock.Advance(TimeSpan.FromMilliseconds(21));
        Assert.Throws<PluginResourceLimitException>(() => guard.ThrowIfTimeoutExceeded());
        Assert.True(guard.CancellationToken.CanBeCanceled);
    }

    [Fact]
    public void IsolationController_DegradesThenQuarantinesAndRequiresAdministratorRecovery()
    {
        var clock = new ManualTimeProvider(DateTimeOffset.Parse("2026-07-24T00:00:00Z"));
        var controller = new PluginIsolationController(clock);
        const string PluginId = "fsusblog.plugin.guard";

        for (int count = 0; count < 4; count++)
        {
            Assert.Equal(
                PluginIsolationState.Healthy,
                controller.RecordFailure(PluginId, criticalHookTimeout: false).State);
        }
        Assert.Equal(
            PluginIsolationState.Degraded,
            controller.RecordFailure(PluginId, criticalHookTimeout: false).State);
        Assert.Equal(
            PluginIsolationState.Quarantined,
            controller.RecordFailure(PluginId, criticalHookTimeout: false).State);
        Assert.Throws<PluginIsolationException>(() => controller.DemandExecutable(PluginId));
        Assert.Throws<PluginIsolationException>(() => controller.Restore(PluginId, administratorConfirmed: false));

        PluginIsolationSnapshot restored = controller.Restore(PluginId, administratorConfirmed: true);

        Assert.Equal(PluginIsolationState.Healthy, restored.State);
        controller.DemandExecutable(PluginId);
        Assert.Equal(
            PluginIsolationState.Quarantined,
            controller.RecordFailure(PluginId, criticalHookTimeout: true).State);
        Assert.Equal(PluginIsolationState.Disabled, controller.Disable(PluginId).State);
        Assert.Equal(
            PluginIsolationState.Disabled,
            controller.RecordFailure(PluginId, criticalHookTimeout: true).State);
    }

    private static PluginManifest CreateManifest(
        IReadOnlyList<string> capabilities,
        PluginPermissionDescriptor permissions)
        => new()
        {
            Id = "fsusblog.plugin.guard",
            Name = "Guard",
            Version = "1.0.0",
            Fsusblog = ">=1.3.0 <1.4.0",
            Author = "tests",
            Description = "Tests",
            Runtime = new PluginRuntimeDescriptor
            {
                Type = PluginRuntimeType.Lua,
                Entry = "lua/main.lua"
            },
            Capabilities = capabilities,
            Permissions = permissions,
            ConfigSchema = "config/schema.json"
        };

    private static PluginPermissionDescriptor DeniedRawPermissions()
        => new()
        {
            Network = false,
            Filesystem = false,
            Database = "none"
        };

    private sealed class InMemoryPluginPermissionGrantStore : IPluginPermissionGrantStore
    {
        private readonly Dictionary<string, IReadOnlySet<PluginCapability>> _grants = new(StringComparer.Ordinal);

        public IReadOnlySet<PluginCapability> Get(string pluginId)
            => _grants.TryGetValue(pluginId, out IReadOnlySet<PluginCapability>? grants)
                ? grants
                : new HashSet<PluginCapability>();

        public void Replace(string pluginId, IReadOnlySet<PluginCapability> grants)
            => _grants[pluginId] = grants;
    }

    private sealed class FixedPluginRegistry(params PluginRegistryEntry[] entries) : IPluginRegistry
    {
        public Task<PluginRegistryEntry?> FindAsync(
            string pluginId,
            CancellationToken cancellationToken = default)
            => Task.FromResult(entries.SingleOrDefault(entry => entry.Manifest.Id == pluginId));

        public Task<IReadOnlyList<PluginRegistryEntry>> ListAsync(
            CancellationToken cancellationToken = default)
            => Task.FromResult<IReadOnlyList<PluginRegistryEntry>>(entries);
    }

    private sealed class ManualTimeProvider(DateTimeOffset utcNow) : TimeProvider
    {
        private DateTimeOffset _utcNow = utcNow;

        public override DateTimeOffset GetUtcNow() => _utcNow;

        public void Advance(TimeSpan duration) => _utcNow += duration;
    }
}
