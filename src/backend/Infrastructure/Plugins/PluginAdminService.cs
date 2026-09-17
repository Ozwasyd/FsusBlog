using System.Collections.Concurrent;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Distributed.Cluster;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Infrastructure.Plugins;

public sealed record PluginAdminConfigSnapshot(
    long Version,
    JsonElement Value,
    DateTimeOffset UpdatedAtUtc,
    string ReloadState);

public sealed class PluginAdminConfigStore(TimeProvider timeProvider)
{
    private readonly ConcurrentDictionary<string, Entry> _entries = new(StringComparer.Ordinal);

    public PluginAdminConfigSnapshot GetOrCreate(string pluginId, JsonElement schema)
    {
        Entry entry = _entries.GetOrAdd(
            pluginId,
            _ => new Entry(
                version: 1,
                PluginConfigSchemaValidator.CreateDefault(schema),
                timeProvider.GetUtcNow(),
                "not-required"));
        lock (entry.Gate)
        {
            return entry.Snapshot();
        }
    }

    public PluginAdminConfigSnapshot Update(
        string pluginId,
        JsonElement schema,
        JsonElement value,
        long expectedVersion)
    {
        PluginConfigSchemaValidator.Validate(schema, value);
        Entry entry = _entries.GetOrAdd(
            pluginId,
            _ => new Entry(
                version: 1,
                PluginConfigSchemaValidator.CreateDefault(schema),
                timeProvider.GetUtcNow(),
                "not-required"));
        lock (entry.Gate)
        {
            if (entry.Version != expectedVersion)
            {
                throw new PluginAdminConflictException("plugin_config_version_conflict");
            }
            entry.Version++;
            entry.Value = value.Clone();
            entry.UpdatedAtUtc = timeProvider.GetUtcNow();
            entry.ReloadState = "pending";
            return entry.Snapshot();
        }
    }

    public void SetReloadState(string pluginId, string state)
    {
        if (!_entries.TryGetValue(pluginId, out Entry? entry))
        {
            return;
        }
        lock (entry.Gate)
        {
            entry.ReloadState = state;
            entry.UpdatedAtUtc = timeProvider.GetUtcNow();
        }
    }

    private sealed class Entry(
        long version,
        JsonElement value,
        DateTimeOffset updatedAtUtc,
        string reloadState)
    {
        public object Gate { get; } = new();

        public long Version { get; set; } = version;

        public JsonElement Value { get; set; } = value;

        public DateTimeOffset UpdatedAtUtc { get; set; } = updatedAtUtc;

        public string ReloadState { get; set; } = reloadState;

        public PluginAdminConfigSnapshot Snapshot()
            => new(Version, Value.Clone(), UpdatedAtUtc, ReloadState);
    }
}

public static class PluginConfigSchemaValidator
{
    public static void Validate(JsonElement schema, JsonElement value)
        => ValidateNode(schema, value, "$");

    public static JsonElement CreateDefault(JsonElement schema)
    {
        if (schema.TryGetProperty("default", out JsonElement direct))
        {
            return direct.Clone();
        }
        if (schema.TryGetProperty("type", out JsonElement type)
            && type.ValueKind == JsonValueKind.String
            && type.GetString() == "object")
        {
            var values = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
            if (schema.TryGetProperty("properties", out JsonElement properties)
                && properties.ValueKind == JsonValueKind.Object)
            {
                foreach (JsonProperty property in properties.EnumerateObject())
                {
                    if (property.Value.TryGetProperty("default", out JsonElement propertyDefault))
                    {
                        values[property.Name] = propertyDefault.Clone();
                    }
                }
            }
            return JsonSerializer.SerializeToElement(values);
        }
        return JsonSerializer.SerializeToElement(new Dictionary<string, object?>());
    }

    private static void ValidateNode(JsonElement schema, JsonElement value, string path)
    {
        if (schema.TryGetProperty("type", out JsonElement type)
            && type.ValueKind == JsonValueKind.String
            && !MatchesType(type.GetString(), value))
        {
            throw new PluginAdminValidationException($"plugin_config_type_invalid:{path}");
        }
        if (schema.TryGetProperty("enum", out JsonElement enumValues)
            && enumValues.ValueKind == JsonValueKind.Array
            && !enumValues.EnumerateArray().Any(candidate => JsonElement.DeepEquals(candidate, value)))
        {
            throw new PluginAdminValidationException($"plugin_config_enum_invalid:{path}");
        }
        if (value.ValueKind == JsonValueKind.Object)
        {
            ValidateObject(schema, value, path);
        }
        else if (value.ValueKind == JsonValueKind.Array
            && schema.TryGetProperty("items", out JsonElement items))
        {
            int index = 0;
            foreach (JsonElement item in value.EnumerateArray())
            {
                ValidateNode(items, item, $"{path}[{index++}]");
            }
        }
        else if (value.ValueKind == JsonValueKind.String)
        {
            ValidateString(schema, value.GetString() ?? string.Empty, path);
        }
        else if (value.ValueKind == JsonValueKind.Number)
        {
            ValidateNumber(schema, value.GetDouble(), path);
        }
    }

    private static void ValidateObject(JsonElement schema, JsonElement value, string path)
    {
        HashSet<string> known = new(StringComparer.Ordinal);
        if (schema.TryGetProperty("properties", out JsonElement properties)
            && properties.ValueKind == JsonValueKind.Object)
        {
            foreach (JsonProperty property in properties.EnumerateObject())
            {
                known.Add(property.Name);
                if (value.TryGetProperty(property.Name, out JsonElement child))
                {
                    ValidateNode(property.Value, child, $"{path}.{property.Name}");
                }
            }
        }
        if (schema.TryGetProperty("required", out JsonElement required)
            && required.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement item in required.EnumerateArray())
            {
                string name = item.GetString() ?? string.Empty;
                if (!value.TryGetProperty(name, out _))
                {
                    throw new PluginAdminValidationException($"plugin_config_required:{path}.{name}");
                }
            }
        }
        bool additionalAllowed = !schema.TryGetProperty("additionalProperties", out JsonElement additional)
            || additional.ValueKind != JsonValueKind.False;
        if (!additionalAllowed)
        {
            string? unknown = value.EnumerateObject()
                .Select(static property => property.Name)
                .FirstOrDefault(name => !known.Contains(name));
            if (unknown is not null)
            {
                throw new PluginAdminValidationException($"plugin_config_property_unknown:{path}.{unknown}");
            }
        }
    }

    private static void ValidateString(JsonElement schema, string value, string path)
    {
        if (schema.TryGetProperty("minLength", out JsonElement minimum)
            && value.Length < minimum.GetInt32())
        {
            throw new PluginAdminValidationException($"plugin_config_string_too_short:{path}");
        }
        if (schema.TryGetProperty("maxLength", out JsonElement maximum)
            && value.Length > maximum.GetInt32())
        {
            throw new PluginAdminValidationException($"plugin_config_string_too_long:{path}");
        }
        if (schema.TryGetProperty("pattern", out JsonElement pattern)
            && !System.Text.RegularExpressions.Regex.IsMatch(
                value,
                pattern.GetString() ?? string.Empty,
                System.Text.RegularExpressions.RegexOptions.CultureInvariant,
                TimeSpan.FromMilliseconds(100)))
        {
            throw new PluginAdminValidationException($"plugin_config_pattern_invalid:{path}");
        }
    }

    private static void ValidateNumber(JsonElement schema, double value, string path)
    {
        if (schema.TryGetProperty("minimum", out JsonElement minimum)
            && value < minimum.GetDouble())
        {
            throw new PluginAdminValidationException($"plugin_config_number_too_small:{path}");
        }
        if (schema.TryGetProperty("maximum", out JsonElement maximum)
            && value > maximum.GetDouble())
        {
            throw new PluginAdminValidationException($"plugin_config_number_too_large:{path}");
        }
    }

    private static bool MatchesType(string? type, JsonElement value)
        => type switch
        {
            "object" => value.ValueKind == JsonValueKind.Object,
            "array" => value.ValueKind == JsonValueKind.Array,
            "string" => value.ValueKind == JsonValueKind.String,
            "boolean" => value.ValueKind is JsonValueKind.True or JsonValueKind.False,
            "integer" => value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out _),
            "number" => value.ValueKind == JsonValueKind.Number,
            "null" => value.ValueKind == JsonValueKind.Null,
            _ => true
        };
}

public sealed class PluginAdminService(
    IPluginRegistry registry,
    IPluginLifecycle lifecycle,
    PluginPackageReader packageReader,
    PluginPermissionManager permissions,
    PluginIsolationController isolation,
    IPluginHookRegistry hooks,
    IJavaScriptPluginRuntime javaScript,
    ILuaPluginRuntime lua,
    PluginObservabilityStore observability,
    PluginAdminConfigStore configs,
    IClusterMembershipStore membership,
    ClusterMembershipOptions cluster,
    TimeProvider timeProvider)
{
    public async Task<PluginAdminOverviewDto> ListAsync(CancellationToken cancellationToken)
    {
        IReadOnlyList<PluginRegistryEntry> entries =
            await registry.ListAsync(cancellationToken).ConfigureAwait(false);
        IReadOnlyList<NodeDescriptor> nodes =
            await membership.ListNodesAsync(cancellationToken).ConfigureAwait(false);
        return new PluginAdminOverviewDto(
            timeProvider.GetUtcNow(),
            cluster.NodeId.Value,
            entries
                .Where(static entry => entry.InstallState != PluginInstallState.Uninstalled)
                .Select(entry => CreateSummary(entry, nodes))
                .OrderBy(static item => item.PluginId, StringComparer.Ordinal)
                .ToArray());
    }

    public async Task<PluginAdminDetailDto?> GetAsync(
        string pluginId,
        CancellationToken cancellationToken)
    {
        PluginRegistryEntry? entry =
            await registry.FindAsync(pluginId, cancellationToken).ConfigureAwait(false);
        if (entry is null || entry.InstallState == PluginInstallState.Uninstalled)
        {
            return null;
        }
        IReadOnlyList<NodeDescriptor> nodes =
            await membership.ListNodesAsync(cancellationToken).ConfigureAwait(false);
        PluginPackage package = await ReadPackageAsync(entry, cancellationToken).ConfigureAwait(false);
        PluginPermissionPlan plan = PluginPermissionPlanner.Create(entry.Manifest);
        IReadOnlySet<PluginCapability> grants = permissions.GetGrants(entry.Manifest.Id);
        PluginAdminConfigSnapshot config = configs.GetOrCreate(
            entry.Manifest.Id,
            package.ConfigSchema.Document);
        PluginNodeObservabilitySnapshot observed = observability.Capture(entry.Manifest.Id);
        return new PluginAdminDetailDto(
            CreateSummary(entry, nodes),
            new PluginAdminManifestSummaryDto(
                entry.Manifest.Id,
                entry.Manifest.Name,
                entry.Manifest.Version,
                entry.Manifest.Author,
                entry.Manifest.Description,
                entry.Manifest.Fsusblog,
                RuntimeName(entry.Manifest.Runtime.Type),
                entry.Manifest.Runtime.Entry,
                entry.Manifest.Capabilities.Order(StringComparer.Ordinal).ToArray(),
                plan.DeniedRawPermissions,
                entry.Manifest.Hooks.Select(static hook => new PluginAdminHookDto(
                    hook.Name,
                    hook.Priority,
                    hook.TimeoutMs,
                    hook.FailPolicy,
                    hook.ExecutionMode,
                    hook.Scope,
                    hook.Idempotent)).ToArray()),
            plan.Capabilities.Select(request => new PluginAdminCapabilityDto(
                request.Name,
                request.Risk.ToString().ToLowerInvariant(),
                grants.Contains(request.Capability),
                request.RequiresAdministratorConfirmation,
                request.RequiresAdministratorConfirmation
                    ? "Touches shared content, runtime, network, scheduler, authentication or admin state."
                    : "Bounded plugin-scoped capability.")).ToArray(),
            new PluginAdminConfigDto(
                config.Version,
                package.ConfigSchema.Document.Clone(),
                config.Value,
                config.UpdatedAtUtc,
                config.ReloadState),
            observed.Metrics,
            observed.RecentExecutions,
            observed.RecentLogs,
            observed.RecentErrors,
            CreateNodeStates(entry, nodes, observed));
    }

    public async Task<PluginRegistryEntry> InstallAsync(
        Stream package,
        CancellationToken cancellationToken)
        => await lifecycle.InstallAsync(package, cancellationToken).ConfigureAwait(false);

    public async Task GrantAsync(
        string pluginId,
        IReadOnlyList<string> capabilityNames,
        bool administratorConfirmed,
        CancellationToken cancellationToken)
    {
        PluginRegistryEntry entry = await RequireEntryAsync(pluginId, cancellationToken).ConfigureAwait(false);
        PluginPermissionPlan plan = PluginPermissionPlanner.Create(entry.Manifest);
        PluginCapability[] requested =
            capabilityNames.Distinct(StringComparer.Ordinal).Select(PluginCapabilityCatalog.Parse).ToArray();
        permissions.ReplaceGrants(plan, requested, administratorConfirmed);
    }

    public async Task EnableAsync(string pluginId, CancellationToken cancellationToken)
    {
        PluginRegistryEntry current = await RequireEntryAsync(pluginId, cancellationToken).ConfigureAwait(false);
        EnsureHookCapabilitiesGranted(current);
        PluginRegistryEntry enabled = await lifecycle.EnableAsync(pluginId, cancellationToken).ConfigureAwait(false);
        try
        {
            await LoadRuntimeAsync(enabled, cancellationToken).ConfigureAwait(false);
            isolation.Restore(pluginId, administratorConfirmed: true);
        }
        catch
        {
            await lifecycle.QuarantineAsync(pluginId, CancellationToken.None).ConfigureAwait(false);
            isolation.RecordFailure(pluginId, criticalHookTimeout: true);
            observability.RecordQuarantine(pluginId);
            throw;
        }
    }

    public async Task DisableAsync(string pluginId, CancellationToken cancellationToken)
    {
        await lifecycle.DisableAsync(pluginId, cancellationToken).ConfigureAwait(false);
        await UnloadRuntimeAsync(pluginId, cancellationToken).ConfigureAwait(false);
        isolation.Disable(pluginId);
    }

    public async Task ReloadAsync(string pluginId, CancellationToken cancellationToken)
    {
        PluginRegistryEntry entry = await RequireEntryAsync(pluginId, cancellationToken).ConfigureAwait(false);
        if (!entry.Enabled || entry.InstallState != PluginInstallState.Enabled)
        {
            throw new PluginLifecycleException($"Plugin '{pluginId}' must be enabled before reload.");
        }
        try
        {
            await LoadRuntimeAsync(entry, cancellationToken).ConfigureAwait(false);
            configs.SetReloadState(pluginId, "applied");
        }
        catch
        {
            configs.SetReloadState(pluginId, "failed");
            await QuarantineAsync(pluginId, CancellationToken.None).ConfigureAwait(false);
            throw;
        }
    }

    public async Task QuarantineAsync(string pluginId, CancellationToken cancellationToken)
    {
        await lifecycle.QuarantineAsync(pluginId, cancellationToken).ConfigureAwait(false);
        await UnloadRuntimeAsync(pluginId, cancellationToken).ConfigureAwait(false);
        PluginRegistryEntry entry = await RequireEntryAsync(pluginId, cancellationToken).ConfigureAwait(false);
        permissions.ReplaceGrants(
            PluginPermissionPlanner.Create(entry.Manifest),
            Array.Empty<PluginCapability>(),
            administratorConfirmedSensitive: true);
        isolation.RecordFailure(pluginId, criticalHookTimeout: true);
        observability.RecordQuarantine(pluginId);
    }

    public async Task RestoreAsync(string pluginId, CancellationToken cancellationToken)
    {
        await lifecycle.RestoreAsync(pluginId, cancellationToken).ConfigureAwait(false);
        isolation.Restore(pluginId, administratorConfirmed: true);
    }

    public async Task UninstallAsync(string pluginId, CancellationToken cancellationToken)
    {
        await UnloadRuntimeAsync(pluginId, cancellationToken).ConfigureAwait(false);
        PluginRegistryEntry entry = await RequireEntryAsync(pluginId, cancellationToken).ConfigureAwait(false);
        permissions.ReplaceGrants(
            PluginPermissionPlanner.Create(entry.Manifest),
            Array.Empty<PluginCapability>(),
            administratorConfirmedSensitive: true);
        await lifecycle.UninstallAsync(pluginId, cancellationToken).ConfigureAwait(false);
        isolation.Disable(pluginId);
    }

    public async Task UpdateConfigAsync(
        string pluginId,
        JsonElement value,
        long expectedVersion,
        CancellationToken cancellationToken)
    {
        PluginRegistryEntry entry = await RequireEntryAsync(pluginId, cancellationToken).ConfigureAwait(false);
        PluginPackage package = await ReadPackageAsync(entry, cancellationToken).ConfigureAwait(false);
        configs.Update(pluginId, package.ConfigSchema.Document, value, expectedVersion);
        if (entry.Enabled)
        {
            await ReloadAsync(pluginId, cancellationToken).ConfigureAwait(false);
        }
        else
        {
            configs.SetReloadState(pluginId, "not-required");
        }
    }

    private async Task LoadRuntimeAsync(PluginRegistryEntry entry, CancellationToken cancellationToken)
    {
        try
        {
            if (entry.Manifest.Runtime.Type == PluginRuntimeType.JavaScript)
            {
                PluginPackage package = await ReadPackageAsync(entry, cancellationToken).ConfigureAwait(false);
                await javaScript.LoadAsync(package, cancellationToken).ConfigureAwait(false);
                hooks.ReplacePlugin(entry.Manifest.Id, entry.Manifest.Runtime.Type, entry.Manifest.Hooks);
            }
            else
            {
                await lua.LoadAsync(entry, cancellationToken).ConfigureAwait(false);
            }
            observability.RecordRuntimeLoad(
                entry.Manifest.Id,
                entry.Manifest.Version,
                entry.Manifest.Runtime.Type,
                entry.Manifest.Hooks.Select(static hook => hook.Name).ToArray(),
                success: true);
        }
        catch (Exception exception)
        {
            observability.RecordRuntimeLoad(
                entry.Manifest.Id,
                entry.Manifest.Version,
                entry.Manifest.Runtime.Type,
                [],
                success: false,
                exception.GetType().Name);
            throw;
        }
    }

    private async Task UnloadRuntimeAsync(string pluginId, CancellationToken cancellationToken)
    {
        hooks.RemovePlugin(pluginId);
        await javaScript.UnloadAsync(pluginId, cancellationToken).ConfigureAwait(false);
        await lua.UnloadAsync(pluginId, cancellationToken).ConfigureAwait(false);
        observability.RecordRuntimeUnload(pluginId);
    }

    private void EnsureHookCapabilitiesGranted(PluginRegistryEntry entry)
    {
        IReadOnlySet<PluginCapability> grants = permissions.GetGrants(entry.Manifest.Id);
        string[] missing =
        [
            .. entry.Manifest.Hooks
                .Select(static hook => PluginHookCatalog.Get(hook.Name).Capability)
                .Distinct()
                .Where(capability => !grants.Contains(capability))
                .Select(PluginCapabilityCatalog.GetName)
                .Order(StringComparer.Ordinal)
        ];
        if (missing.Length > 0)
        {
            throw new PluginPermissionApprovalException(
                $"Plugin '{entry.Manifest.Id}' is missing Hook capabilities: {string.Join(", ", missing)}.");
        }
    }

    private async Task<PluginRegistryEntry> RequireEntryAsync(
        string pluginId,
        CancellationToken cancellationToken)
        => await registry.FindAsync(pluginId, cancellationToken).ConfigureAwait(false)
            ?? throw new PluginLifecycleException($"Plugin '{pluginId}' is not registered.");

    private async Task<PluginPackage> ReadPackageAsync(
        PluginRegistryEntry entry,
        CancellationToken cancellationToken)
    {
        using var stream = new MemoryStream(entry.PackageBytes, writable: false);
        return await packageReader.ReadAsync(stream, cancellationToken).ConfigureAwait(false);
    }

    private PluginAdminSummaryDto CreateSummary(
        PluginRegistryEntry entry,
        IReadOnlyList<NodeDescriptor> nodes)
    {
        PluginPermissionPlan plan = PluginPermissionPlanner.Create(entry.Manifest);
        PluginNodeObservabilitySnapshot observed = observability.Capture(entry.Manifest.Id);
        PluginIsolationSnapshot isolationSnapshot = isolation.GetSnapshot(entry.Manifest.Id);
        bool clusterConsistent = nodes.Count <= 1
            && observed.RuntimeLoaded == entry.Enabled;
        string healthState = entry.InstallState switch
        {
            PluginInstallState.Quarantined => "quarantined",
            PluginInstallState.Failed => "failed",
            PluginInstallState.Disabled or PluginInstallState.Installed => "disabled",
            _ => isolationSnapshot.State.ToString().ToLowerInvariant()
        };
        return new PluginAdminSummaryDto(
            entry.Manifest.Id,
            entry.Manifest.Name,
            entry.Manifest.Version,
            RuntimeName(entry.Manifest.Runtime.Type),
            entry.InstallState.ToString().ToLowerInvariant(),
            healthState,
            entry.Enabled,
            entry.InstalledAtUtc,
            entry.UpdatedAtUtc,
            observed.LastErrorCode,
            entry.Manifest.Hooks.Count,
            permissions.GetGrants(entry.Manifest.Id).Count,
            plan.Capabilities.Count,
            clusterConsistent);
    }

    private IReadOnlyList<PluginAdminNodeStateDto> CreateNodeStates(
        PluginRegistryEntry entry,
        IReadOnlyList<NodeDescriptor> nodes,
        PluginNodeObservabilitySnapshot observed)
    {
        IEnumerable<NodeDescriptor> source = nodes.Count == 0
            ? [NodeDescriptor.Create(
                cluster.NodeId,
                Guid.Empty,
                "local",
                timeProvider.GetUtcNow(),
                cluster.Mode,
                [ClusterCapabilities.AdminUi])]
            : nodes;
        return source
            .OrderBy(static node => node.NodeId.Value, StringComparer.Ordinal)
            .Select(node =>
            {
                bool current = node.NodeId == cluster.NodeId;
                return new PluginAdminNodeStateDto(
                    node.NodeId.Value,
                    ClusterMembershipWireNames.Status(node.Status),
                    current
                        ? observed.RuntimeLoaded ? "loaded" : entry.Enabled ? "load-missing" : "not-loaded"
                        : "not-reported",
                    current && observed.RuntimeLoaded,
                    current ? observed.RegisteredHooks : [],
                    current ? observed.LastErrorCode : null,
                    current ? timeProvider.GetUtcNow() : null);
            })
            .ToArray();
    }

    private static string RuntimeName(PluginRuntimeType runtime)
        => runtime == PluginRuntimeType.JavaScript ? "ts/js" : "lua";
}

public sealed class PluginAdminValidationException(string message) : InvalidOperationException(message);
public sealed class PluginAdminConflictException(string message) : InvalidOperationException(message);
