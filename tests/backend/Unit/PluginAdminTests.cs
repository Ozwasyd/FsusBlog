using System.Text.Json;

using FsusBlog.Server.Infrastructure.Distributed.Cluster;
using FsusBlog.Server.Infrastructure.Plugins;

namespace FsusBlog.Server.Tests;

public sealed class PluginAdminTests
{
    [Fact]
    public void ConfigSchemaValidator_RejectsMissingUnknownAndOutOfRangeValues()
    {
        using JsonDocument schema = JsonDocument.Parse(
            """
            {
              "type": "object",
              "additionalProperties": false,
              "required": ["threshold"],
              "properties": {
                "threshold": { "type": "integer", "minimum": 1, "maximum": 10 },
                "mode": { "type": "string", "enum": ["observe", "enforce"] }
              }
            }
            """);

        using JsonDocument valid = JsonDocument.Parse("""{"threshold":5,"mode":"observe"}""");
        PluginConfigSchemaValidator.Validate(schema.RootElement, valid.RootElement);

        using JsonDocument missing = JsonDocument.Parse("""{"mode":"observe"}""");
        Assert.Throws<PluginAdminValidationException>(
            () => PluginConfigSchemaValidator.Validate(schema.RootElement, missing.RootElement));

        using JsonDocument unknown = JsonDocument.Parse("""{"threshold":5,"secret":"x"}""");
        Assert.Throws<PluginAdminValidationException>(
            () => PluginConfigSchemaValidator.Validate(schema.RootElement, unknown.RootElement));

        using JsonDocument outOfRange = JsonDocument.Parse("""{"threshold":11}""");
        Assert.Throws<PluginAdminValidationException>(
            () => PluginConfigSchemaValidator.Validate(schema.RootElement, outOfRange.RootElement));
    }

    [Fact]
    public void ConfigStore_UsesCompareAndSwapAndTracksReloadState()
    {
        var store = new PluginAdminConfigStore(TimeProvider.System);
        using JsonDocument schema = JsonDocument.Parse(
            """
            {
              "type": "object",
              "additionalProperties": false,
              "properties": {
                "enabled": { "type": "boolean", "default": true }
              }
            }
            """);
        PluginAdminConfigSnapshot initial = store.GetOrCreate("fsusblog.plugin.test", schema.RootElement);
        Assert.Equal(1, initial.Version);
        Assert.True(initial.Value.GetProperty("enabled").GetBoolean());

        using JsonDocument updated = JsonDocument.Parse("""{"enabled":false}""");
        PluginAdminConfigSnapshot result = store.Update(
            "fsusblog.plugin.test",
            schema.RootElement,
            updated.RootElement,
            expectedVersion: 1);
        Assert.Equal(2, result.Version);
        Assert.Equal("pending", result.ReloadState);

        Assert.Throws<PluginAdminConflictException>(() => store.Update(
            "fsusblog.plugin.test",
            schema.RootElement,
            updated.RootElement,
            expectedVersion: 1));
    }

    [Fact]
    public void ObservabilityStore_BoundsLogsAndPreservesRequiredExecutionDimensions()
    {
        var cluster = new ClusterMembershipOptions(
            new NodeId("node-admin"),
            Guid.NewGuid(),
            "tests",
            DateTimeOffset.UtcNow,
            ClusterRuntimeMode.Single,
            [],
            TimeSpan.FromSeconds(10),
            TimeSpan.FromSeconds(30),
            TimeSpan.FromSeconds(90));
        var store = new PluginObservabilityStore(TimeProvider.System, cluster);
        const string PluginId = "fsusblog.plugin.test";
        store.RecordRuntimeLoad(
            PluginId,
            "1.2.3",
            PluginRuntimeType.JavaScript,
            ["comment.beforeCreate"],
            success: true);
        for (int index = 0; index < 205; index++)
        {
            store.RecordLog(
                PluginId,
                PluginRuntimeType.JavaScript,
                "comment.beforeCreate",
                "trace-1",
                "info",
                $"message-{index}");
        }
        store.RecordExecution(
            PluginId,
            PluginRuntimeType.JavaScript,
            "comment.beforeCreate",
            durationMilliseconds: 4.5,
            success: false,
            errorCode: "hook_failed",
            timeout: true,
            memoryUsedBytes: 1024,
            memoryBudgetBytes: 2048,
            traceId: "trace-1",
            failPolicy: "quarantine",
            scope: "per-node");

        PluginNodeObservabilitySnapshot snapshot = store.Capture(PluginId);
        Assert.Equal(200, snapshot.RecentLogs.Count);
        Assert.Equal("message-204", snapshot.RecentLogs[0].Message);
        Assert.Equal(1, snapshot.Metrics.ExecutionCount);
        Assert.Equal(1, snapshot.Metrics.TimeoutCount);
        Assert.Collection(
            snapshot.RecentExecutions,
            execution =>
            {
                Assert.Equal(PluginId, execution.PluginId);
                Assert.Equal("1.2.3", execution.PluginVersion);
                Assert.Equal("comment.beforeCreate", execution.HookName);
                Assert.Equal("node-admin", execution.NodeId);
                Assert.Equal("trace-1", execution.TraceId);
                Assert.Equal("per-node", execution.Scope);
                Assert.Equal(1024, execution.MemoryUsedBytes);
                Assert.Equal(2048, execution.MemoryBudgetBytes);
            });
    }

    [Fact]
    public async Task Lifecycle_QuarantineAndRestoreUseDurableCasTransitions()
    {
        PluginRegistryEntry original = CreateEntry(
            PluginInstallState.Enabled,
            enabled: true,
            version: 7);
        var store = new FakeRegistryStore(original);
        var lifecycle = new PluginLifecycle(
            new PluginPackageReader(new Version(1, 3, 0)),
            store,
            TimeProvider.System);

        PluginRegistryEntry quarantined =
            await lifecycle.QuarantineAsync(original.Manifest.Id);
        Assert.Equal(PluginInstallState.Quarantined, quarantined.InstallState);
        Assert.False(quarantined.Enabled);
        Assert.Equal(8, quarantined.Version);

        PluginRegistryEntry restored = await lifecycle.RestoreAsync(original.Manifest.Id);
        Assert.Equal(PluginInstallState.Disabled, restored.InstallState);
        Assert.False(restored.Enabled);
        Assert.Equal(9, restored.Version);
    }

    private static PluginRegistryEntry CreateEntry(
        PluginInstallState state,
        bool enabled,
        long version)
    {
        var manifest = new PluginManifest
        {
            Id = "fsusblog.plugin.test",
            Name = "Test",
            Version = "1.0.0",
            Fsusblog = "^1.3.0",
            Author = "tests",
            Description = "test plugin",
            Runtime = new PluginRuntimeDescriptor
            {
                Type = PluginRuntimeType.JavaScript,
                Entry = "dist/main.js"
            },
            Permissions = new PluginPermissionDescriptor
            {
                Database = "none"
            },
            ConfigSchema = "config.schema.json"
        };
        return new PluginRegistryEntry(
            manifest,
            state,
            enabled,
            [1],
            new byte[32],
            DateTimeOffset.UtcNow,
            DateTimeOffset.UtcNow,
            version);
    }

    private sealed class FakeRegistryStore(PluginRegistryEntry entry) : IPluginRegistryStore
    {
        private PluginRegistryEntry _entry = entry;

        public Task<PluginRegistryEntry?> FindAsync(
            string pluginId,
            CancellationToken cancellationToken = default)
            => Task.FromResult<PluginRegistryEntry?>(
                pluginId == _entry.Manifest.Id ? _entry : null);

        public Task<IReadOnlyList<PluginRegistryEntry>> ListAsync(
            CancellationToken cancellationToken = default)
            => Task.FromResult<IReadOnlyList<PluginRegistryEntry>>([_entry]);

        public Task<bool> TryInstallAsync(
            PluginRegistryEntry candidate,
            CancellationToken cancellationToken = default)
            => Task.FromResult(false);

        public Task<PluginRegistryEntry?> TryUpdateAsync(
            PluginRegistryEntry candidate,
            long expectedVersion,
            CancellationToken cancellationToken = default)
        {
            if (_entry.Version != expectedVersion)
            {
                return Task.FromResult<PluginRegistryEntry?>(null);
            }
            _entry = candidate with
            {
                Version = expectedVersion + 1
            };
            return Task.FromResult<PluginRegistryEntry?>(_entry);
        }
    }
}
