using System.Reflection;

namespace FsusBlog.Server.Infrastructure.Distributed.Cluster;

public sealed record ClusterMembershipOptions(
    NodeId NodeId,
    Guid InstanceId,
    string Version,
    DateTimeOffset StartedAt,
    ClusterRuntimeMode Mode,
    IReadOnlyList<CapabilityId> Capabilities,
    TimeSpan HeartbeatInterval,
    TimeSpan SuspectAfter,
    TimeSpan DeadAfter)
{
    public const string SectionName = "Runtime:Cluster";

    public bool Enabled => Mode != ClusterRuntimeMode.Single;

    public static ClusterMembershipOptions FromConfiguration(
        IConfiguration configuration,
        TimeProvider? timeProvider = null)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        timeProvider ??= TimeProvider.System;
        string modeValue = (configuration["RuntimeMode:Mode"]
            ?? configuration["Runtime:Mode"])?.Trim().ToLowerInvariant()
            ?? RuntimeModeNames.Single;
        ClusterRuntimeMode mode = modeValue switch
        {
            RuntimeModeNames.Single => ClusterRuntimeMode.Single,
            RuntimeModeNames.StaticRole => ClusterRuntimeMode.StaticRole,
            RuntimeModeNames.Adaptive => ClusterRuntimeMode.Adaptive,
            _ => throw new InvalidOperationException($"cluster_runtime_mode_invalid:{modeValue}")
        };
        string configuredNodeId = configuration[$"{SectionName}:NodeId"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_NODE_ID")
            ?? $"{Environment.MachineName}-{Environment.ProcessId}";
        string[] configuredCapabilities =
            configuration.GetSection($"{SectionName}:Capabilities").Get<string[]?>() ?? [];
        CapabilityId[] capabilities = mode switch
        {
            ClusterRuntimeMode.Single => [],
            ClusterRuntimeMode.StaticRole when configuredCapabilities.Length == 0
                => ResolveStaticRoleCapabilities(
                    configuration.GetSection("RuntimeMode:StaticRoles").Get<string[]?>()
                    ?? configuration.GetSection("Runtime:StaticRoles").Get<string[]?>()
                    ?? []),
            _ => configuredCapabilities
                .Select(ParseCapability)
                .Distinct()
                .OrderBy(static capability => capability.Value, StringComparer.Ordinal)
                .ToArray()
        };
        if (mode != ClusterRuntimeMode.Single && capabilities.Length == 0)
        {
            throw new InvalidOperationException("cluster_capabilities_required");
        }

        int heartbeatSeconds = Math.Clamp(
            configuration.GetValue($"{SectionName}:HeartbeatSeconds", 10),
            1,
            300);
        int suspectSeconds = Math.Clamp(
            configuration.GetValue($"{SectionName}:SuspectAfterSeconds", heartbeatSeconds * 3),
            heartbeatSeconds + 1,
            1800);
        int deadSeconds = Math.Clamp(
            configuration.GetValue($"{SectionName}:DeadAfterSeconds", suspectSeconds * 3),
            suspectSeconds + 1,
            86400);
        string version = Assembly.GetEntryAssembly()?.GetCustomAttribute<AssemblyInformationalVersionAttribute>()
            ?.InformationalVersion
            ?? "unknown";
        return new ClusterMembershipOptions(
            new NodeId(configuredNodeId),
            Guid.NewGuid(),
            version,
            timeProvider.GetUtcNow(),
            mode,
            capabilities,
            TimeSpan.FromSeconds(heartbeatSeconds),
            TimeSpan.FromSeconds(suspectSeconds),
            TimeSpan.FromSeconds(deadSeconds));
    }

    private static CapabilityId ParseCapability(string value)
        => CapabilityId.TryParse(value, out CapabilityId capability)
            ? capability
            : throw new InvalidOperationException($"cluster_capability_invalid:{value}");

    private static CapabilityId[] ResolveStaticRoleCapabilities(IReadOnlyList<string> roles)
        => roles
            .SelectMany(static role => role.Trim().ToLowerInvariant() switch
            {
                "web" => new[]
                {
                    ClusterCapabilities.WebApi,
                    ClusterCapabilities.AdminUi,
                    ClusterCapabilities.CommentApi,
                    ClusterCapabilities.SearchQuery
                },
                "content" =>
                [
                    ClusterCapabilities.SearchIndexer,
                    ClusterCapabilities.MediaProcessor
                ],
                "security" =>
                [
                    ClusterCapabilities.CommentAudit,
                    ClusterCapabilities.AntispamInference
                ],
                "audit" => [ClusterCapabilities.CommentAudit],
                "maintenance" =>
                [
                    ClusterCapabilities.MediaProcessor,
                    ClusterCapabilities.SchedulerWorker
                ],
                _ => throw new InvalidOperationException($"cluster_static_role_invalid:{role}")
            })
            .Distinct()
            .OrderBy(static capability => capability.Value, StringComparer.Ordinal)
            .ToArray();
}
