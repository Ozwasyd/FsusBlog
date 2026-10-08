using System.Collections.Concurrent;
using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

using FsusBlog.Server.Infrastructure.Cache;

using StackExchange.Redis.Profiling;

namespace FsusBlog.Server.Infrastructure.Testing;

internal sealed partial class RuntimeCacheEvidenceObservation : IDisposable
{
    private static readonly AsyncLocal<RuntimeCacheEvidenceObservation?> s_current = new();
    private readonly RuntimeCacheEvidenceObservation? _parent = s_current.Value;
    private readonly RuntimeCacheDatabaseObservationLimits _databaseLimits;
    private readonly QueryPlanCommandCapture? _queryPlanCapture;
    private readonly object _databaseGate = new();
    private readonly List<RuntimeCacheBuildObservation> _cacheEvents = [];
    private readonly List<string> _databaseFingerprints = [];
    private readonly List<RuntimeCacheRedisFailureObservation> _redisFailureEvents = [];
    private readonly ConcurrentQueue<string> _redisCommands = new();
    private readonly long _startedAt = Stopwatch.GetTimestamp();
    private readonly long _allocatedBytesAtStart = GC.GetAllocatedBytesForCurrentThread();
    private Action<RuntimeCacheRequestObservation>? _completionSink;
    private string _layerSource = "database";
    private string[] _completedRedisCommands = [];
    private string _completedPayloadDigest = string.Empty;
    private int _completedStatusCode;
    private double _completedLatencyMs;
    private long _completedAllocatedBytes;
    private int _databaseCommandCount;
    private int _databaseDroppedCommandCount;
    private int _databaseLateCommandCount;
    private int _databaseActiveCommandCount;
    private long _cacheEventSequence;
    private long _redisFailureSequence;
    private bool _databaseTruncated;
    private bool _databaseLate;
    private bool _completed;
    private bool _disposed;

    private RuntimeCacheEvidenceObservation(
        string requestId,
        string method,
        string path,
        RuntimeCacheDatabaseObservationLimits databaseLimits,
        QueryPlanCommandCapture? queryPlanCapture)
    {
        RequestId = requestId;
        Method = method;
        Path = path;
        _databaseLimits = databaseLimits;
        _queryPlanCapture = queryPlanCapture;
    }

    internal static RuntimeCacheEvidenceObservation? Current => s_current.Value;
    internal QueryPlanCommandCapture? QueryPlanCapture => _queryPlanCapture;
    internal string RequestId
    {
        get;
    }
    internal string Method
    {
        get;
    }
    internal string Path
    {
        get;
    }
    internal ProfilingSession RedisProfile { get; } = new();

    internal static RuntimeCacheEvidenceObservation Begin(
        string requestId,
        string method,
        string path,
        RuntimeCacheDatabaseObservationLimits? databaseLimits = null,
        QueryPlanCommandCapture? queryPlanCapture = null)
    {
        RuntimeCacheDatabaseActivityObserver.EnsureStarted();
        var observation = new RuntimeCacheEvidenceObservation(
            requestId,
            method,
            path,
            databaseLimits ?? RuntimeCacheDatabaseObservationLimits.Default,
            queryPlanCapture);
        s_current.Value = observation;
        return observation;
    }

    internal bool TryBeginDatabaseActivity()
    {
        lock (_databaseGate)
        {
            if (_completed)
            {
                _databaseLate = true;
                _databaseLateCommandCount++;
                PublishUpdateLocked();
                return false;
            }

            if (_databaseActiveCommandCount >= _databaseLimits.MaxInFlightCommands)
            {
                _databaseCommandCount++;
                MarkDatabaseTruncatedLocked();
                return false;
            }

            _databaseActiveCommandCount++;
            return true;
        }
    }

    internal void RejectDatabaseActivity()
    {
        lock (_databaseGate)
        {
            if (_databaseActiveCommandCount > 0)
            {
                _databaseActiveCommandCount--;
            }
            _databaseCommandCount++;
            MarkDatabaseTruncatedLocked();
            PublishUpdateLocked();
        }
    }

    internal void RecordDatabaseActivity(string? sql)
    {
        lock (_databaseGate)
        {
            if (_databaseActiveCommandCount > 0)
            {
                _databaseActiveCommandCount--;
            }

            _databaseCommandCount++;
            if (_completed)
            {
                _databaseLate = true;
            }

            if (string.IsNullOrWhiteSpace(sql) ||
                Encoding.UTF8.GetByteCount(sql) > _databaseLimits.MaxSqlUtf8Bytes ||
                _databaseFingerprints.Count >= _databaseLimits.MaxCommands)
            {
                MarkDatabaseTruncatedLocked();
            }
            else
            {
                _databaseFingerprints.Add(FingerprintSql(sql));
            }

            PublishUpdateLocked();
        }
    }

    internal void RecordRedisCommands(IEnumerable<string> commands)
    {
        foreach (string command in commands)
        {
            _redisCommands.Enqueue(command);
        }
    }

    internal void RecordRedisFailure(
        RedisOperationClass operationClass,
        RedisOperationFailureKind failureKind,
        string failAction)
    {
        lock (_databaseGate)
        {
            _redisFailureEvents.Add(new RuntimeCacheRedisFailureObservation(
                Sequence: ++_redisFailureSequence,
                ElapsedMilliseconds: Stopwatch.GetElapsedTime(_startedAt).TotalMilliseconds,
                OperationClass: operationClass,
                FailureKind: failureKind,
                FailAction: failAction));
            PublishUpdateLocked();
        }
    }

    internal void RecordCacheEvent(string family, string identity, string outcome)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(family);
        ArgumentException.ThrowIfNullOrWhiteSpace(identity);
        ArgumentException.ThrowIfNullOrWhiteSpace(outcome);
        string identityDigest = $"sha256:{Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(identity)))}";
        lock (_databaseGate)
        {
            _cacheEvents.Add(new RuntimeCacheBuildObservation(
                Sequence: ++_cacheEventSequence,
                ElapsedMilliseconds: Stopwatch.GetElapsedTime(_startedAt).TotalMilliseconds,
                Family: family,
                IdentityDigest: identityDigest,
                Outcome: outcome));
            PublishUpdateLocked();
        }
    }

    internal void MarkLayerSource(string layerSource)
    {
        if (!string.IsNullOrWhiteSpace(layerSource))
        {
            _layerSource = layerSource;
        }
    }

    internal RuntimeCacheRequestObservation Complete(int statusCode, string payloadDigest)
    {
        string[] redisCommands = RedisProfile.FinishProfiling()
            .Select(static command => command.Command.ToString().ToUpperInvariant())
            .ToArray();
        RecordRedisCommands(redisCommands);

        lock (_databaseGate)
        {
            if (_completed)
            {
                throw new InvalidOperationException("Runtime cache evidence observation was already completed.");
            }

            _completed = true;
            _completedStatusCode = statusCode;
            _completedPayloadDigest = payloadDigest;
            _completedLatencyMs = Stopwatch.GetElapsedTime(_startedAt).TotalMilliseconds;
            _completedAllocatedBytes = Math.Max(
                0,
                GC.GetAllocatedBytesForCurrentThread() - _allocatedBytesAtStart);
            _completedRedisCommands = _redisCommands.ToArray();
            if (_databaseActiveCommandCount > 0)
            {
                _databaseLate = true;
                _databaseLateCommandCount += _databaseActiveCommandCount;
            }

            return CreateSnapshotLocked();
        }
    }

    internal void AttachCompletionSink(Action<RuntimeCacheRequestObservation> completionSink)
    {
        ArgumentNullException.ThrowIfNull(completionSink);
        lock (_databaseGate)
        {
            if (!_completed)
            {
                throw new InvalidOperationException("Runtime cache evidence observation is not completed.");
            }

            _completionSink = completionSink;
            RuntimeCacheRequestObservation snapshot = CreateSnapshotLocked();
            completionSink(snapshot);
            _queryPlanCapture?.Publish(snapshot);
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        s_current.Value = _parent;
    }

    internal static string FingerprintSql(string sql)
    {
        string normalized = OperatorSpacing().Replace(Whitespace().Replace(
            StringLiteral().Replace(NumericLiteral().Replace(sql, "?"), "?"),
            " "), "$1").Trim().ToLowerInvariant();
        return $"sha256:{Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(normalized)))}";
    }

    private void MarkDatabaseTruncatedLocked()
    {
        _databaseTruncated = true;
        _databaseDroppedCommandCount++;
    }

    private void PublishUpdateLocked()
    {
        if (_completed && _completionSink is not null)
        {
            RuntimeCacheRequestObservation snapshot = CreateSnapshotLocked();
            _completionSink(snapshot);
            _queryPlanCapture?.Publish(snapshot);
        }
    }

    private RuntimeCacheRequestObservation CreateSnapshotLocked()
    {
        bool complete = !_databaseTruncated && !_databaseLate;
        string status = (_databaseLate, _databaseTruncated) switch
        {
            (false, false) => "complete",
            (false, true) => "truncated",
            (true, false) => "late",
            (true, true) => "late-and-truncated"
        };
        return new RuntimeCacheRequestObservation(
            RequestId,
            Method,
            Path,
            _completedStatusCode,
            _completedPayloadDigest,
            _layerSource,
            _completedLatencyMs,
            _completedAllocatedBytes,
            _completedRedisCommands,
            [.. _redisFailureEvents],
            [.. _cacheEvents],
            [.. _databaseFingerprints],
            _databaseCommandCount,
            _databaseDroppedCommandCount,
            _databaseLateCommandCount,
            status,
            complete);
    }

    [GeneratedRegex(@"\b\d+(?:\.\d+)?\b", RegexOptions.CultureInvariant)]
    private static partial Regex NumericLiteral();

    [GeneratedRegex(@"'(?:''|[^'])*'", RegexOptions.CultureInvariant)]
    private static partial Regex StringLiteral();

    [GeneratedRegex(@"\s+", RegexOptions.CultureInvariant)]
    private static partial Regex Whitespace();

    [GeneratedRegex(@"\s*([=<>(),])\s*", RegexOptions.CultureInvariant)]
    private static partial Regex OperatorSpacing();
}

internal readonly record struct RuntimeCacheDatabaseObservationLimits(
    int MaxCommands,
    int MaxSqlUtf8Bytes,
    int MaxInFlightCommands)
{
    internal static RuntimeCacheDatabaseObservationLimits Default
    {
        get;
    } = new(
        MaxCommands: 1024,
        MaxSqlUtf8Bytes: 256 * 1024,
        MaxInFlightCommands: 256);
}

internal static class RuntimeCacheDatabaseActivityObserver
{
    private const int GlobalInFlightCapacity = 8192;
    private static readonly ConcurrentDictionary<Activity, RuntimeCacheEvidenceObservation> s_inFlight = new();
    private static readonly object s_startGate = new();
    private static ActivityListener? s_listener;
    private static int s_inFlightCount;

    internal static void EnsureStarted()
    {
        if (Volatile.Read(ref s_listener) is not null)
        {
            return;
        }

        lock (s_startGate)
        {
            if (s_listener is not null)
            {
                return;
            }

            var listener = new ActivityListener
            {
                ShouldListenTo = static source => string.Equals(source.Name, "Npgsql", StringComparison.Ordinal),
                Sample = static (ref ActivityCreationOptions<ActivityContext> _) => ActivitySamplingResult.AllDataAndRecorded,
                SampleUsingParentId = static (ref ActivityCreationOptions<string> _) => ActivitySamplingResult.AllDataAndRecorded,
                ActivityStarted = OnActivityStarted,
                ActivityStopped = OnActivityStopped
            };
            ActivitySource.AddActivityListener(listener);
            Volatile.Write(ref s_listener, listener);
        }
    }

    private static void OnActivityStarted(Activity activity)
    {
        // Npgsql uses the same source for optional physical-open spans. They are not SQL commands.
        if (activity.DisplayName.StartsWith("CONNECT ", StringComparison.Ordinal))
        {
            return;
        }

        RuntimeCacheEvidenceObservation? observation = RuntimeCacheEvidenceObservation.Current;
        if (observation is null || !observation.TryBeginDatabaseActivity())
        {
            return;
        }

        if (Interlocked.Increment(ref s_inFlightCount) > GlobalInFlightCapacity)
        {
            Interlocked.Decrement(ref s_inFlightCount);
            observation.RejectDatabaseActivity();
            return;
        }

        if (!s_inFlight.TryAdd(activity, observation))
        {
            Interlocked.Decrement(ref s_inFlightCount);
            observation.RejectDatabaseActivity();
        }
    }

    private static void OnActivityStopped(Activity activity)
    {
        if (!s_inFlight.TryRemove(activity, out RuntimeCacheEvidenceObservation? observation))
        {
            return;
        }

        Interlocked.Decrement(ref s_inFlightCount);
        string? sql = activity.GetTagItem("db.query.text")?.ToString()
            ?? activity.GetTagItem("db.statement")?.ToString();
        observation.RecordDatabaseActivity(sql);
    }
}

internal sealed record RuntimeCacheRequestObservation(
    string RequestId,
    string Method,
    string Path,
    int Status,
    string PayloadDigest,
    string LayerSource,
    double LatencyMs,
    long AllocatedBytes,
    IReadOnlyList<string> RedisCommands,
    IReadOnlyList<RuntimeCacheRedisFailureObservation> RedisFailureEvents,
    IReadOnlyList<RuntimeCacheBuildObservation> CacheEvents,
    IReadOnlyList<string> DatabaseFingerprints,
    int DatabaseCommandCount,
    int DatabaseDroppedCommandCount,
    int DatabaseLateCommandCount,
    string DatabaseObservationStatus,
    bool DatabaseAttributionComplete);

internal sealed record RuntimeCacheRedisFailureObservation(
    long Sequence,
    double ElapsedMilliseconds,
    [property: JsonConverter(typeof(JsonStringEnumConverter<RedisOperationClass>))]
    RedisOperationClass OperationClass,
    [property: JsonConverter(typeof(JsonStringEnumConverter<RedisOperationFailureKind>))]
    RedisOperationFailureKind FailureKind,
    string FailAction);

internal sealed record RuntimeCacheBuildObservation(
    long Sequence,
    double ElapsedMilliseconds,
    string Family,
    string IdentityDigest,
    string Outcome);

internal sealed class RuntimeCacheEvidenceStore(int capacity = 4096)
{
    private readonly object _gate = new();
    private readonly Dictionary<string, StoredObservation> _observations = new(StringComparer.Ordinal);
    private readonly LinkedList<StoredObservation> _order = new();

    internal void Store(
        RuntimeCacheEvidenceObservation owner,
        int statusCode,
        string payloadDigest)
    {
        var stored = new StoredObservation(owner, owner.Complete(statusCode, payloadDigest));
        lock (_gate)
        {
            if (_observations.Remove(stored.Snapshot.RequestId, out StoredObservation? replaced))
            {
                _order.Remove(replaced.OrderNode);
            }

            stored.OrderNode = _order.AddLast(stored);
            _observations[stored.Snapshot.RequestId] = stored;
            while (_observations.Count > capacity && _order.First is { } oldestNode)
            {
                _order.RemoveFirst();
                _observations.Remove(oldestNode.Value.Snapshot.RequestId);
            }
        }

        owner.AttachCompletionSink(updated => UpdateIfPresent(owner, updated));
    }

    internal bool TryTake(string requestId, out RuntimeCacheRequestObservation? observation)
    {
        lock (_gate)
        {
            if (_observations.Remove(requestId, out StoredObservation? stored))
            {
                _order.Remove(stored.OrderNode);
                observation = stored.Snapshot;
                return true;
            }

            observation = null;
            return false;
        }
    }

    private void UpdateIfPresent(
        RuntimeCacheEvidenceObservation owner,
        RuntimeCacheRequestObservation observation)
    {
        lock (_gate)
        {
            if (_observations.TryGetValue(observation.RequestId, out StoredObservation? current) &&
                ReferenceEquals(current.Owner, owner))
            {
                current.Snapshot = observation;
            }
        }
    }

    private sealed class StoredObservation(
        RuntimeCacheEvidenceObservation owner,
        RuntimeCacheRequestObservation snapshot)
    {
        internal RuntimeCacheEvidenceObservation Owner { get; } = owner;
        internal RuntimeCacheRequestObservation Snapshot { get; set; } = snapshot;
        internal LinkedListNode<StoredObservation> OrderNode { get; set; } = null!;
    }
}
