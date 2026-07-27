using System.Collections.Concurrent;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Infrastructure.Cache;

namespace FsusBlog.Server.Infrastructure.Distributed;

public sealed record DistributedInvalidationRequest(
    string Kind,
    IReadOnlyList<string> CacheTags,
    IReadOnlyList<string> RouteKeys,
    IReadOnlyList<string> ArtifactKeys);

public enum DistributedInvalidationPublishStatus
{
    LocalOnly = 0,
    Published = 1,
    Degraded = 2
}

public sealed record DistributedInvalidationPublishResult(
    DistributedInvalidationPublishStatus Status,
    string? EventId,
    string? Detail,
    DistributedInvalidationEvent? Event = null,
    DistributedInvalidationTransportPublishResult? TransportReceipt = null);

public enum DistributedInvalidationConvergenceState
{
    Pending = 0,
    PartiallyAcked = 1,
    Complete = 2,
    TerminalFailed = 3
}

/// <summary>Source-side durable obligation only. Inbox, ACK and replay ownership belongs to the reconciliation worker.</summary>
public sealed record DistributedInvalidationConvergenceObligation(
    string ObligationId,
    string EventId,
    string Kind,
    string SourceNodeId,
    string RuntimeScope,
    string SourceMutationIdentity,
    string RequiredTopologyDigest,
    DistributedInvalidationPublishStatus PublishStatus,
    DistributedInvalidationTransportStatus? TransportStatus,
    DateTimeOffset CreatedAt,
    DistributedInvalidationConvergenceState State,
    int AttemptCount,
    string? LastFailureKind,
    string PayloadDigest = "",
    IReadOnlyList<string>? RequiredNodeIds = null,
    IReadOnlyList<string>? AckedNodeIds = null);

public sealed record DistributedInvalidationConvergenceSnapshot(
    int PendingCount,
    int TerminalFailedCount,
    TimeSpan? OldestPendingAge,
    bool Degraded,
    int AckGapCount = 0,
    bool LedgerAvailable = true);

public sealed class DistributedInvalidationConvergenceRuntimeState
{
    private readonly object _gate = new();
    private DistributedInvalidationConvergenceSnapshot _snapshot = new(0, 0, null, false);

    public DistributedInvalidationConvergenceSnapshot Snapshot()
    {
        lock (_gate)
        {
            return _snapshot;
        }
    }

    public void Record(DistributedInvalidationConvergenceSnapshot value)
    {
        lock (_gate)
        {
            _snapshot = value;
        }
    }

    public void RecordUnavailable()
        => Record(new DistributedInvalidationConvergenceSnapshot(0, 0, null, true, 0, false));
}

public interface IDistributedInvalidationObligationStore
{
    Task<DistributedInvalidationConvergenceObligation> UpsertAsync(
        DistributedInvalidationPublishResult publishResult,
        CancellationToken cancellationToken = default);
    Task<DistributedInvalidationConvergenceSnapshot> SnapshotAsync(CancellationToken cancellationToken = default);
}

/// <summary>PostgreSQL is the only recovery truth; Pub/Sub only wakes the target quickly.</summary>
public interface IDistributedInvalidationDeliveryLedger
{
    Task PrepareOutboxAsync(
        DistributedInvalidationEvent invalidation,
        DistributedInvalidationTopologyManifest topology,
        CancellationToken cancellationToken = default);

    Task RecordPublishAttemptAsync(
        DistributedInvalidationPublishResult result,
        CancellationToken cancellationToken = default);

    Task<DistributedInvalidationInboxReceipt> ReceiveAsync(
        DistributedInvalidationEvent invalidation,
        string targetNodeId,
        CancellationToken cancellationToken = default);

    Task<bool> TryBeginApplyAsync(
        DistributedInvalidationEvent invalidation,
        string targetNodeId,
        CancellationToken cancellationToken = default);

    Task RecordApplyAsync(
        DistributedInvalidationEvent invalidation,
        string targetNodeId,
        DistributedInvalidationInboxApplyState state,
        string? failureKind,
        long? generation,
        CancellationToken cancellationToken = default);

    Task RecoverInterruptedAsync(
        string runtimeScope,
        string targetNodeId,
        CancellationToken cancellationToken = default);

    Task<IReadOnlyList<DistributedInvalidationEvent>> ReadPendingForNodeAsync(
        string runtimeScope,
        string targetNodeId,
        CancellationToken cancellationToken = default);

    Task RetireNodeAsync(
        string runtimeScope,
        string retiredNodeId,
        DistributedInvalidationTopologyManifest replacementTopology,
        string reason,
        CancellationToken cancellationToken = default);

    Task RecordReconcileCoverageAsync(
        string runtimeScope,
        string targetNodeId,
        string kind,
        long generation,
        string proofIdentity,
        CancellationToken cancellationToken = default);

    Task<int> CompactCompletedAsync(
        string runtimeScope,
        long generationWatermark,
        DateTimeOffset retainAfter,
        CancellationToken cancellationToken = default);
}

public enum DistributedInvalidationInboxApplyState
{
    Pending = 0,
    Applying = 1,
    Applied = 2,
    RetryableFailed = 3,
    TerminalFailed = 4
}

public sealed record DistributedInvalidationInboxReceipt(
    bool IsAppliedDuplicate,
    bool IsPayloadMismatch,
    bool IsTerminal,
    DistributedInvalidationInboxApplyState State);

public interface IDistributedInvalidationPublisher
{
    Task<DistributedInvalidationPublishResult> PublishAsync(
        DistributedInvalidationRequest request,
        CancellationToken cancellationToken = default);
}

public interface IDistributedInvalidationTransport
{
    Task<DistributedInvalidationTransportPublishResult> PublishAsync(
        string payload,
        CancellationToken cancellationToken = default);

    IAsyncEnumerable<string> ReadAllAsync(CancellationToken cancellationToken = default);
}

public enum DistributedInvalidationTransportStatus
{
    Delivered = 0,
    UnderDelivered = 1,
    TransportFailed = 2
}

public sealed record DistributedInvalidationTopologyManifest(
    string Channel,
    IReadOnlyList<string> SubscriberNodeIds,
    string Digest)
{
    public static DistributedInvalidationTopologyManifest Create(
        string? channel,
        IEnumerable<string>? subscriberNodeIds)
    {
        if (string.IsNullOrWhiteSpace(channel))
        {
            throw new InvalidOperationException("distributed_invalidation_topology_channel_required");
        }

        string[] nodes = subscriberNodeIds?
            .Where(static value => !string.IsNullOrWhiteSpace(value))
            .Select(static value => value.Trim())
            .Distinct(StringComparer.Ordinal)
            .Order(StringComparer.Ordinal)
            .ToArray()
            ?? [];
        if (nodes.Length == 0)
        {
            throw new InvalidOperationException("distributed_invalidation_topology_manifest_required");
        }
        if (subscriberNodeIds is not null && subscriberNodeIds.Count() != nodes.Length)
        {
            throw new InvalidOperationException("distributed_invalidation_topology_subscribers_invalid");
        }

        string canonical = string.Join('\n', new[] { channel.Trim() }.Concat(nodes));
        string digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(canonical)))
            .ToLowerInvariant();
        return new DistributedInvalidationTopologyManifest(channel.Trim(), nodes, digest);
    }
}

public sealed record DistributedInvalidationTransportPublishResult(
    string Channel,
    long? SubscriberCount,
    int ExpectedMinimumSubscribers,
    bool PublisherNodeSubscribed,
    DateTimeOffset ObservedAt,
    DistributedInvalidationTransportStatus TransportStatus,
    string? TopologyDigest,
    string? FailureReason)
{
    public static DistributedInvalidationTransportPublishResult Observe(
        string channel,
        long? subscriberCount,
        DistributedInvalidationTopologyManifest topology,
        bool publisherNodeSubscribed,
        TimeProvider timeProvider)
    {
        ArgumentNullException.ThrowIfNull(topology);
        ArgumentNullException.ThrowIfNull(timeProvider);
        bool delivered = subscriberCount is >= 0 && subscriberCount >= topology.SubscriberNodeIds.Count;
        return new DistributedInvalidationTransportPublishResult(
            channel,
            subscriberCount,
            topology.SubscriberNodeIds.Count,
            publisherNodeSubscribed,
            timeProvider.GetUtcNow(),
            delivered
                ? DistributedInvalidationTransportStatus.Delivered
                : DistributedInvalidationTransportStatus.UnderDelivered,
            topology.Digest,
            subscriberCount is null or < 0 ? "invalid-subscriber-count" : null);
    }

    public static DistributedInvalidationTransportPublishResult Failed(
        string channel,
        DistributedInvalidationTopologyManifest topology,
        bool publisherNodeSubscribed,
        TimeProvider timeProvider,
        string reason)
        => new(
            channel,
            null,
            topology.SubscriberNodeIds.Count,
            publisherNodeSubscribed,
            timeProvider.GetUtcNow(),
            DistributedInvalidationTransportStatus.TransportFailed,
            topology.Digest,
            reason);
}

public interface IDistributedInvalidationLocalApplier
{
    Task<DistributedInvalidationLocalApplyResult?> ApplyAsync(
        DistributedInvalidationEvent invalidation,
        CancellationToken cancellationToken = default);
}

public enum DistributedInvalidationRebuildObligationStatus
{
    Durable = 0,
    Queued = 1,
    Rejected = 2,
    Failed = 3
}

public enum DistributedInvalidationLocalApplyStatus
{
    Applied = 0,
    DegradedRetryable = 1,
    FailedTerminal = 2
}

public sealed record DistributedInvalidationLocalApplyResult(
    bool MemoryInvalidated,
    bool AotMemoryInvalidated,
    bool AotGenerationMarked,
    bool HotSnapshotRetired,
    DistributedInvalidationRebuildObligationStatus RebuildObligationStatus,
    DistributedInvalidationLocalApplyStatus LocalApplyStatus,
    string? RebuildObligationId,
    long? RebuildGeneration,
    long? AotGeneration)
{
    public bool IsApplied
        => MemoryInvalidated
            && AotMemoryInvalidated
            && AotGenerationMarked
            && HotSnapshotRetired
            && (RebuildObligationStatus is DistributedInvalidationRebuildObligationStatus.Durable
                or DistributedInvalidationRebuildObligationStatus.Queued)
            && LocalApplyStatus == DistributedInvalidationLocalApplyStatus.Applied
            && RebuildGeneration is > 0
            && AotGeneration is > 0
            && (RebuildObligationStatus != DistributedInvalidationRebuildObligationStatus.Durable
                || !string.IsNullOrWhiteSpace(RebuildObligationId));

    public bool HasCompletedLocalInvalidation
        => MemoryInvalidated
            && AotMemoryInvalidated
            && AotGenerationMarked
            && HotSnapshotRetired
            && AotGeneration is > 0;

    public bool HasRebuildObligation
        => (RebuildObligationStatus is DistributedInvalidationRebuildObligationStatus.Durable
            or DistributedInvalidationRebuildObligationStatus.Queued)
            && RebuildGeneration is > 0
            && (RebuildObligationStatus != DistributedInvalidationRebuildObligationStatus.Durable
                || !string.IsNullOrWhiteSpace(RebuildObligationId));
}

public sealed class DistributedInvalidationOptions
{
    public const string SectionName = "Runtime:DistributedInvalidation";
    public const string DefaultChannel = "fsus:distributed-invalidation:v1";

    public required RuntimeModeKind RuntimeMode
    {
        get; init;
    }
    public required string NodeId
    {
        get; init;
    }
    public string Channel { get; init; } = DefaultChannel;
    public int ApplyRetryCount { get; init; } = 3;
    public TimeSpan ApplyRetryDelay { get; init; } = TimeSpan.FromMilliseconds(25);
    public TimeSpan RecoveryReplayInterval { get; init; } = TimeSpan.FromSeconds(5);
    public int DedupeCapacity { get; init; } = 4096;
    public DistributedInvalidationTopologyManifest? Topology
    {
        get; init;
    }

    public bool Enabled => RuntimeMode != RuntimeModeKind.Single;

    public static DistributedInvalidationOptions FromConfiguration(IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(configuration);
        var runtime = new RuntimeModeOptions();
        configuration.GetSection(RuntimeModeOptions.SectionName).Bind(runtime);
        runtime.Mode = FirstNonEmpty(
            Environment.GetEnvironmentVariable("FSUSBLOG_RUNTIME_MODE"),
            Environment.GetEnvironmentVariable("FSUSBLOG_TEST_RUNTIME_MODE"),
            runtime.Mode);
        IConfigurationSection section = configuration.GetSection(SectionName);
        string nodeId = FirstNonEmpty(
            Environment.GetEnvironmentVariable("FSUSBLOG_NODE_ID"),
            Environment.GetEnvironmentVariable("FSUSBLOG_TEST_NODE_ID"),
            section["NodeId"],
            $"{Environment.MachineName}:{Environment.ProcessId}");
        string channel = FirstNonEmpty(section["Channel"], DefaultChannel);
        RuntimeModeKind runtimeMode = runtime.ResolveMode();
        DistributedInvalidationTopologyManifest? topology = runtimeMode == RuntimeModeKind.Single
            ? null
            : DistributedInvalidationTopologyManifest.Create(
                channel,
                section.GetSection("Topology:SubscriberNodeIds").Get<string[]?>());
        if (topology is not null && !topology.SubscriberNodeIds.Contains(nodeId, StringComparer.Ordinal))
        {
            throw new InvalidOperationException("distributed_invalidation_topology_publisher_not_subscribed");
        }
        return new DistributedInvalidationOptions
        {
            RuntimeMode = runtimeMode,
            NodeId = nodeId,
            Channel = channel,
            Topology = topology,
            ApplyRetryCount = Math.Clamp(section.GetValue("ApplyRetryCount", 3), 1, 10),
            ApplyRetryDelay = TimeSpan.FromMilliseconds(
                Math.Clamp(section.GetValue("ApplyRetryDelayMilliseconds", 25), 1, 5000)),
            RecoveryReplayInterval = TimeSpan.FromMilliseconds(
                Math.Clamp(section.GetValue("RecoveryReplayIntervalMilliseconds", 5000), 100, 60000)),
            DedupeCapacity = Math.Clamp(section.GetValue("DedupeCapacity", 4096), 128, 65536)
        };
    }

    private static string FirstNonEmpty(params string?[] values)
        => values.First(static value => !string.IsNullOrWhiteSpace(value))!.Trim();
}

public sealed class DistributedInvalidationEventFactory(
    DistributedInvalidationOptions options,
    IRuntimeKeyScope runtimeKeyScope,
    TimeProvider timeProvider)
{
    public string RuntimeScope
        => string.IsNullOrWhiteSpace(runtimeKeyScope.ScopeToken) ? "default" : runtimeKeyScope.ScopeToken;

    public DistributedInvalidationEvent Create(DistributedInvalidationRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        string runtimeScope = string.IsNullOrWhiteSpace(runtimeKeyScope.ScopeToken)
            ? "default"
            : runtimeKeyScope.ScopeToken;
        string traceId = Activity.Current?.TraceId.ToString() ?? Guid.NewGuid().ToString("N");
        return DistributedInvalidationEvent.Create(
            Guid.NewGuid().ToString("N"),
            request.Kind,
            options.NodeId,
            runtimeScope,
            request.CacheTags,
            request.RouteKeys,
            request.ArtifactKeys,
            traceId,
            timeProvider);
    }
}

public sealed record DistributedInvalidationRuntimeSnapshot(
    long PublishedCount,
    long ReceivedCount,
    long LocalInvalidatedCount,
    long RebuildObligatedCount,
    long AppliedCount,
    long DuplicateCount,
    long SelfIgnoredCount,
    long DegradedCount,
    DateTimeOffset? LastObservedAt,
    string? LastStatus,
    string? LastEventId,
    string? LastKind,
    string? LastSourceNodeId,
    string? LastTraceId,
    string? LastDetail,
    string? LastChannel,
    long? LastSubscriberCount,
    int? LastExpectedMinimumSubscribers,
    string? LastTopologyDigest,
    DistributedInvalidationLocalApplyStatus? LastLocalApplyStatus,
    DistributedInvalidationRebuildObligationStatus? LastRebuildObligationStatus,
    string? LastRebuildObligationId,
    long? LastRebuildGeneration,
    long? LastAotGeneration);

public sealed class DistributedInvalidationRuntimeState(TimeProvider timeProvider)
{
    private readonly object _gate = new();
    private DistributedInvalidationRuntimeSnapshot _snapshot = new(
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        0,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null);

    public DistributedInvalidationRuntimeSnapshot Snapshot()
    {
        lock (_gate)
        {
            return _snapshot;
        }
    }

    public void RecordPublished(
        DistributedInvalidationEvent invalidation,
        DistributedInvalidationTransportPublishResult receipt)
        => Update("published", invalidation, published: 1, receipt: receipt);

    public void RecordApplied(DistributedInvalidationEvent invalidation)
        => Update("applied", invalidation, applied: 1);

    public void RecordReceived(DistributedInvalidationEvent invalidation)
        => Update("received", invalidation, received: 1);

    public void RecordLocalInvalidated(
        DistributedInvalidationEvent invalidation,
        DistributedInvalidationLocalApplyResult result)
        => Update("local-invalidated", invalidation, localInvalidated: 1, result: result);

    public void RecordRebuildObligated(
        DistributedInvalidationEvent invalidation,
        DistributedInvalidationLocalApplyResult result)
        => Update("rebuild-obligated", invalidation, rebuildObligated: 1, result: result);

    public void RecordDuplicate(DistributedInvalidationEvent invalidation)
        => Update("duplicate", invalidation, duplicate: 1);

    public void RecordSelfIgnored(DistributedInvalidationEvent invalidation)
        => Update("self-ignored", invalidation, selfIgnored: 1);

    public void RecordDegraded(
        DistributedInvalidationEvent? invalidation,
        string detail,
        DistributedInvalidationTransportPublishResult? receipt = null)
        => Update("degraded", invalidation, degraded: 1, detail: detail, receipt: receipt);

    private void Update(
        string status,
        DistributedInvalidationEvent? invalidation,
        long published = 0,
        long received = 0,
        long localInvalidated = 0,
        long rebuildObligated = 0,
        long applied = 0,
        long duplicate = 0,
        long selfIgnored = 0,
        long degraded = 0,
        string? detail = null,
        DistributedInvalidationTransportPublishResult? receipt = null,
        DistributedInvalidationLocalApplyResult? result = null)
    {
        lock (_gate)
        {
            _snapshot = _snapshot with
            {
                PublishedCount = _snapshot.PublishedCount + published,
                ReceivedCount = _snapshot.ReceivedCount + received,
                LocalInvalidatedCount = _snapshot.LocalInvalidatedCount + localInvalidated,
                RebuildObligatedCount = _snapshot.RebuildObligatedCount + rebuildObligated,
                AppliedCount = _snapshot.AppliedCount + applied,
                DuplicateCount = _snapshot.DuplicateCount + duplicate,
                SelfIgnoredCount = _snapshot.SelfIgnoredCount + selfIgnored,
                DegradedCount = _snapshot.DegradedCount + degraded,
                LastObservedAt = timeProvider.GetUtcNow(),
                LastStatus = status,
                LastEventId = invalidation?.EventId,
                LastKind = invalidation?.Kind,
                LastSourceNodeId = invalidation?.SourceNodeId,
                LastTraceId = invalidation?.TraceId,
                LastDetail = detail,
                LastChannel = receipt?.Channel,
                LastSubscriberCount = receipt?.SubscriberCount,
                LastExpectedMinimumSubscribers = receipt?.ExpectedMinimumSubscribers,
                LastTopologyDigest = receipt?.TopologyDigest,
                LastLocalApplyStatus = result?.LocalApplyStatus ?? _snapshot.LastLocalApplyStatus,
                LastRebuildObligationStatus = result?.RebuildObligationStatus ?? _snapshot.LastRebuildObligationStatus,
                LastRebuildObligationId = result?.RebuildObligationId ?? _snapshot.LastRebuildObligationId,
                LastRebuildGeneration = result?.RebuildGeneration ?? _snapshot.LastRebuildGeneration,
                LastAotGeneration = result?.AotGeneration ?? _snapshot.LastAotGeneration
            };
        }
    }
}

internal sealed class DistributedInvalidationDeduplicator(int capacity)
{
    private readonly ConcurrentDictionary<string, byte> _entries = new(StringComparer.Ordinal);
    private readonly ConcurrentQueue<string> _order = new();

    public bool TryBegin(string replayIdentity)
    {
        if (!_entries.TryAdd(replayIdentity, 0))
        {
            return false;
        }

        _order.Enqueue(replayIdentity);
        while (_entries.Count > capacity && _order.TryDequeue(out string? expired))
        {
            _entries.TryRemove(expired, out _);
        }
        return true;
    }

    public void Abandon(string replayIdentity)
        => _entries.TryRemove(replayIdentity, out _);
}

public sealed class SingleNodeDistributedInvalidationPublisher : IDistributedInvalidationPublisher
{
    public Task<DistributedInvalidationPublishResult> PublishAsync(
        DistributedInvalidationRequest request,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        cancellationToken.ThrowIfCancellationRequested();
        return Task.FromResult(new DistributedInvalidationPublishResult(
            DistributedInvalidationPublishStatus.LocalOnly,
            null,
            "single-mode-local-invalidation-complete"));
    }
}
