using System.Diagnostics.CodeAnalysis;
using System.Text.Json.Serialization;

namespace FsusBlog.Server.Infrastructure.Distributed.Cluster;

public readonly record struct NodeId
{
    [JsonConstructor]
    public NodeId(string value)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(value);
        Value = value.Trim();
    }

    public string Value
    {
        get;
    }

    public override string ToString() => Value;
}

public readonly record struct CapabilityId
{
    [JsonConstructor]
    public CapabilityId(string value)
    {
        if (!ClusterCapabilities.TryGet(value, out CapabilityId capability))
        {
            throw new ArgumentOutOfRangeException(nameof(value), value, "Unknown cluster capability.");
        }
        Value = capability.Value;
    }

    private CapabilityId(string value, bool knownCapability)
    {
        if (!knownCapability)
        {
            throw new ArgumentOutOfRangeException(nameof(knownCapability));
        }
        Value = value;
    }

    public string Value
    {
        get;
    }

    public static bool TryParse(string? value, out CapabilityId capability)
        => ClusterCapabilities.TryGet(value, out capability);

    internal static CapabilityId CreateKnown(string value) => new(value, true);

    public override string ToString() => Value;
}

public static class ClusterCapabilities
{
    public static readonly CapabilityId WebApi = CapabilityId.CreateKnown("web.api");
    public static readonly CapabilityId AdminUi = CapabilityId.CreateKnown("admin.ui");
    public static readonly CapabilityId CommentApi = CapabilityId.CreateKnown("comment.api");
    public static readonly CapabilityId CommentAudit = CapabilityId.CreateKnown("comment.audit");
    public static readonly CapabilityId AntispamInference = CapabilityId.CreateKnown("antispam.inference");
    public static readonly CapabilityId SearchQuery = CapabilityId.CreateKnown("search.query");
    public static readonly CapabilityId SearchIndexer = CapabilityId.CreateKnown("search.indexer");
    public static readonly CapabilityId MediaProcessor = CapabilityId.CreateKnown("media.processor");
    public static readonly CapabilityId SchedulerWorker = CapabilityId.CreateKnown("scheduler.worker");

    private static readonly IReadOnlyDictionary<string, CapabilityId> s_catalog =
        new Dictionary<string, CapabilityId>(StringComparer.Ordinal)
        {
            [WebApi.Value] = WebApi,
            [AdminUi.Value] = AdminUi,
            [CommentApi.Value] = CommentApi,
            [CommentAudit.Value] = CommentAudit,
            [AntispamInference.Value] = AntispamInference,
            [SearchQuery.Value] = SearchQuery,
            [SearchIndexer.Value] = SearchIndexer,
            [MediaProcessor.Value] = MediaProcessor,
            [SchedulerWorker.Value] = SchedulerWorker
        };

    public static IReadOnlyCollection<CapabilityId> All
    {
        get;
    } = s_catalog.Values.ToArray();

    internal static bool TryGet(
        string? value,
        [MaybeNullWhen(false)] out CapabilityId capability)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            capability = default;
            return false;
        }
        return s_catalog.TryGetValue(value.Trim(), out capability);
    }
}

public enum ClusterRuntimeMode
{
    Single = 0,
    StaticRole = 1,
    Adaptive = 2
}

public enum ClusterMemberStatus
{
    Alive = 0,
    Suspect = 1,
    Dead = 2,
    Draining = 3,
    Maintenance = 4
}

public static class ClusterMembershipWireNames
{
    public static string Mode(ClusterRuntimeMode mode)
        => mode switch
        {
            ClusterRuntimeMode.Single => "single",
            ClusterRuntimeMode.StaticRole => "static-role",
            ClusterRuntimeMode.Adaptive => "adaptive",
            _ => throw new ArgumentOutOfRangeException(nameof(mode))
        };

    public static string Status(ClusterMemberStatus status)
        => status switch
        {
            ClusterMemberStatus.Alive => "alive",
            ClusterMemberStatus.Suspect => "suspect",
            ClusterMemberStatus.Dead => "dead",
            ClusterMemberStatus.Draining => "draining",
            ClusterMemberStatus.Maintenance => "maintenance",
            _ => throw new ArgumentOutOfRangeException(nameof(status))
        };
}

public sealed record NodeResourceHints(
    double CpuUsagePercent,
    double MemoryPressurePercent,
    long ManagedHeapBytes,
    long QueueLength,
    double P95LatencyMilliseconds,
    double P99LatencyMilliseconds,
    double RecentErrorRate,
    double IoPressurePercent,
    bool NetworkReachable,
    int ActiveLeaseCount)
{
    public static NodeResourceHints Empty
    {
        get;
    } = new(
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        true,
        0);
}

public sealed record NodeDescriptor(
    NodeId NodeId,
    Guid InstanceId,
    string Version,
    DateTimeOffset StartedAt,
    ClusterRuntimeMode Mode,
    IReadOnlyList<CapabilityId> Capabilities,
    ClusterMemberStatus Status,
    DateTimeOffset LastHeartbeatAt,
    NodeResourceHints Resources,
    IReadOnlyList<CapabilityId> ActiveResponsibilities)
{
    public static NodeDescriptor Create(
        NodeId nodeId,
        Guid instanceId,
        string version,
        DateTimeOffset startedAt,
        ClusterRuntimeMode mode,
        IReadOnlyList<CapabilityId> capabilities)
        => new(
            nodeId,
            instanceId,
            version,
            startedAt,
            mode,
            capabilities.Distinct().OrderBy(static value => value.Value, StringComparer.Ordinal).ToArray(),
            ClusterMemberStatus.Alive,
            startedAt,
            NodeResourceHints.Empty,
            []);
}

public sealed record NodeHeartbeat(
    NodeId NodeId,
    Guid InstanceId,
    DateTimeOffset ObservedAt,
    NodeResourceHints Resources,
    IReadOnlyList<CapabilityId> ActiveResponsibilities)
{
    public static NodeHeartbeat Healthy(NodeId nodeId, Guid instanceId, DateTimeOffset observedAt)
        => new(nodeId, instanceId, observedAt, NodeResourceHints.Empty, []);
}

public interface IClusterMembershipStore
{
    ValueTask UpsertNodeAsync(NodeDescriptor node, CancellationToken cancellationToken);

    ValueTask MarkHeartbeatAsync(NodeHeartbeat heartbeat, CancellationToken cancellationToken);

    ValueTask<IReadOnlyList<NodeDescriptor>> ListAliveNodesAsync(CancellationToken cancellationToken);

    ValueTask<IReadOnlyList<NodeDescriptor>> ListNodesAsync(CancellationToken cancellationToken);

    ValueTask MarkNodeSuspectAsync(NodeId nodeId, CancellationToken cancellationToken);

    ValueTask MarkNodeDeadAsync(NodeId nodeId, CancellationToken cancellationToken);

    ValueTask SetNodeStatusAsync(
        NodeId nodeId,
        ClusterMemberStatus status,
        CancellationToken cancellationToken);

    ValueTask SetNodeStatusAsync(
        NodeId nodeId,
        Guid expectedInstanceId,
        ClusterMemberStatus status,
        CancellationToken cancellationToken);

    ValueTask DetectFailuresAsync(
        DateTimeOffset observedAt,
        TimeSpan suspectAfter,
        TimeSpan deadAfter,
        CancellationToken cancellationToken);
}
