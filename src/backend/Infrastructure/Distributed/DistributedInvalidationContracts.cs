using System.Collections.Concurrent;
using System.Diagnostics;

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
    string? Detail);

public interface IDistributedInvalidationPublisher
{
    Task<DistributedInvalidationPublishResult> PublishAsync(
        DistributedInvalidationRequest request,
        CancellationToken cancellationToken = default);
}

public interface IDistributedInvalidationTransport
{
    Task PublishAsync(string payload, CancellationToken cancellationToken = default);

    IAsyncEnumerable<string> ReadAllAsync(CancellationToken cancellationToken = default);
}

public interface IDistributedInvalidationLocalApplier
{
    Task ApplyAsync(DistributedInvalidationEvent invalidation, CancellationToken cancellationToken = default);
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
    public int DedupeCapacity { get; init; } = 4096;

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
        return new DistributedInvalidationOptions
        {
            RuntimeMode = runtime.ResolveMode(),
            NodeId = nodeId,
            Channel = channel,
            ApplyRetryCount = Math.Clamp(section.GetValue("ApplyRetryCount", 3), 1, 10),
            ApplyRetryDelay = TimeSpan.FromMilliseconds(
                Math.Clamp(section.GetValue("ApplyRetryDelayMilliseconds", 25), 1, 5000)),
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
    string? LastDetail);

public sealed class DistributedInvalidationRuntimeState(TimeProvider timeProvider)
{
    private readonly object _gate = new();
    private DistributedInvalidationRuntimeSnapshot _snapshot = new(
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
        null);

    public DistributedInvalidationRuntimeSnapshot Snapshot()
    {
        lock (_gate)
        {
            return _snapshot;
        }
    }

    public void RecordPublished(DistributedInvalidationEvent invalidation)
        => Update("published", invalidation, published: 1);

    public void RecordApplied(DistributedInvalidationEvent invalidation)
        => Update("applied", invalidation, applied: 1);

    public void RecordDuplicate(DistributedInvalidationEvent invalidation)
        => Update("duplicate", invalidation, duplicate: 1);

    public void RecordSelfIgnored(DistributedInvalidationEvent invalidation)
        => Update("self-ignored", invalidation, selfIgnored: 1);

    public void RecordDegraded(DistributedInvalidationEvent? invalidation, string detail)
        => Update("degraded", invalidation, degraded: 1, detail: detail);

    private void Update(
        string status,
        DistributedInvalidationEvent? invalidation,
        long published = 0,
        long applied = 0,
        long duplicate = 0,
        long selfIgnored = 0,
        long degraded = 0,
        string? detail = null)
    {
        lock (_gate)
        {
            _snapshot = _snapshot with
            {
                PublishedCount = _snapshot.PublishedCount + published,
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
                LastDetail = detail
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
