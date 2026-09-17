using System.Collections.Concurrent;
using System.Globalization;
using System.Threading.Channels;

namespace FsusBlog.Server.Infrastructure.PublicAot;

public sealed record PublicAotBackfillQueueSnapshot(
    int QueuedCount,
    int InFlightCount,
    int ReservationCount,
    int DurablePendingCount,
    long TargetGeneration,
    long TerminalFailureCount,
    string? LastDisposition,
    string? LastFailureReason,
    string? LastItemReference)
{
    public int OutstandingCount => QueuedCount + InFlightCount + DurablePendingCount;
}

public sealed class PublicAotBackfillScheduler : IPublicAotBackfillScheduler
{
    private readonly Channel<PublicAotBackfillRequest> _channel;
    private readonly ConcurrentDictionary<string, long> _inFlight = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, long> _inFlightRouteKeys = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, PublicAotBackfillRequest> _durablePending = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, long> _committedVersions = new(StringComparer.Ordinal);
    private readonly PublicAotSsrRuntimeState _runtimeState;
    private readonly int _queueCapacity;
    private int _queuedCount;
    private int _processingCount;
    private long _targetGeneration;
    private long _terminalFailureCount;
    private string? _lastDisposition;
    private string? _lastFailureReason;
    private string? _lastItemReference;
    internal int InFlightCount => _inFlight.Count;
    internal int InFlightRouteKeyCount => _inFlightRouteKeys.Count;
    internal int DurablePendingCount => _durablePending.Count;

    public PublicAotBackfillScheduler(IConfiguration configuration)
        : this(configuration, new PublicAotSsrRuntimeState(configuration))
    {
    }

    public PublicAotBackfillScheduler(IConfiguration configuration, PublicAotSsrRuntimeState runtimeState)
    {
        _runtimeState = runtimeState;
        int queueCapacity = Math.Clamp(configuration.GetValue<int?>("PublicAot:BackfillQueueCapacity") ?? 512, 32, 4096);
        _queueCapacity = queueCapacity;
        _channel = Channel.CreateBounded<PublicAotBackfillRequest>(
            new BoundedChannelOptions(queueCapacity)
            {
                SingleReader = false,
                SingleWriter = false,
                FullMode = BoundedChannelFullMode.Wait,
                AllowSynchronousContinuations = false
            });
    }

    internal int QueueCapacity => _queueCapacity;

    public bool TrySchedule(PublicAotBackfillRequest request)
    {
        if (!_runtimeState.TryBeginBackfill(request, out string blockReason))
        {
            _runtimeState.RecordBackfillDropped(request, blockReason, InFlightCount);
            return false;
        }

        string routeIdentity = BuildRouteIdentity(request);
        if (!TryReserve(_inFlightRouteKeys, routeIdentity, request.ScheduledInvalidationVersion))
        {
            _runtimeState.RecordBackfillDropped(request, "duplicate-route-key", InFlightCount);
            return false;
        }

        if (!TryReserve(_inFlight, request.CacheKey, request.ScheduledInvalidationVersion))
        {
            RemoveReservation(_inFlightRouteKeys, routeIdentity, request.ScheduledInvalidationVersion);
            _runtimeState.RecordBackfillDropped(request, "duplicate-cache-key", InFlightCount);
            return false;
        }

        if (_channel.Writer.TryWrite(request))
        {
            Interlocked.Increment(ref _queuedCount);
            RememberTarget(request);
            SetDisposition("queued", ItemReference(request));
            _runtimeState.RecordBackfillScheduled(request, InFlightCount);
            return true;
        }

        RemoveReservation(_inFlight, request.CacheKey, request.ScheduledInvalidationVersion);
        RemoveReservation(_inFlightRouteKeys, routeIdentity, request.ScheduledInvalidationVersion);
        RetainDurablePending(request, "queue-full");
        _runtimeState.RecordBackfillDropped(request, "queue-full", InFlightCount);
        return false;
    }

    internal IAsyncEnumerable<PublicAotBackfillRequest> ReadAllAsync(CancellationToken cancellationToken)
        => _channel.Reader.ReadAllAsync(cancellationToken);

    internal void Begin(PublicAotBackfillRequest request)
    {
        Decrement(ref _queuedCount);
        Interlocked.Increment(ref _processingCount);
        SetDisposition("in-flight", ItemReference(request));
    }

    internal bool ShouldProcess(PublicAotBackfillRequest request)
    {
        if (HasNewerTarget(request))
        {
            SetDisposition("coalesced-to-newer", ItemReference(request));
            return false;
        }

        return true;
    }

    internal void RetainDurablePending(PublicAotBackfillRequest request, string reason)
    {
        string key = BuildRouteIdentity(request);
        _durablePending.AddOrUpdate(
            key,
            request,
            (_, existing) => existing.ScheduledInvalidationVersion >= request.ScheduledInvalidationVersion
                ? existing
                : request);
        RememberTarget(request);
        SetDisposition("durable-pending", ItemReference(request), reason);
    }

    internal void Complete(PublicAotBackfillRequest request, bool committed = true)
    {
        string routeIdentity = BuildRouteIdentity(request);
        RemoveReservation(_inFlight, request.CacheKey, request.ScheduledInvalidationVersion);
        RemoveReservation(_inFlightRouteKeys, routeIdentity, request.ScheduledInvalidationVersion);
        if (committed)
        {
            _committedVersions.AddOrUpdate(
                routeIdentity,
                request.ScheduledInvalidationVersion,
                (_, existing) => Math.Max(existing, request.ScheduledInvalidationVersion));
            SetDisposition("committed", ItemReference(request));
        }

        if (Volatile.Read(ref _processingCount) > 0)
        {
            Decrement(ref _processingCount);
        }
        else
        {
            Decrement(ref _queuedCount);
        }

        if (committed)
        {
            ReplayDurablePending();
        }
    }

    internal void ReplayDurablePending()
        => ReplayDurablePendingCore();

    internal void MarkTerminalFailure(PublicAotBackfillRequest request, string reason)
    {
        Interlocked.Increment(ref _terminalFailureCount);
        SetDisposition("terminal-failed", ItemReference(request), reason);
    }

    internal PublicAotBackfillQueueSnapshot Snapshot()
        => new(
            Math.Max(0, Volatile.Read(ref _queuedCount)),
            Math.Max(0, Volatile.Read(ref _processingCount)),
            _inFlight.Count,
            _durablePending.Count,
            Volatile.Read(ref _targetGeneration),
            Volatile.Read(ref _terminalFailureCount),
            Volatile.Read(ref _lastDisposition),
            Volatile.Read(ref _lastFailureReason),
            Volatile.Read(ref _lastItemReference));

    private void ReplayDurablePendingCore()
    {
        foreach (KeyValuePair<string, PublicAotBackfillRequest> pair in _durablePending.ToArray())
        {
            if (!_durablePending.TryRemove(pair.Key, out PublicAotBackfillRequest? pending))
            {
                continue;
            }

            if (HasNewerTarget(pending))
            {
                SetDisposition("coalesced-to-newer", ItemReference(pending));
                continue;
            }

            if (!TrySchedule(pending))
            {
                _durablePending.TryAdd(pair.Key, pending);
            }
        }
    }

    private bool HasNewerTarget(PublicAotBackfillRequest request)
    {
        string routeIdentity = BuildRouteIdentity(request);
        if (_inFlight.TryGetValue(request.CacheKey, out long cacheVersion)
            && cacheVersion > request.ScheduledInvalidationVersion)
        {
            return true;
        }

        if (_inFlightRouteKeys.TryGetValue(routeIdentity, out long routeVersion)
            && routeVersion > request.ScheduledInvalidationVersion)
        {
            return true;
        }

        if (_durablePending.TryGetValue(routeIdentity, out PublicAotBackfillRequest? pending)
            && pending.ScheduledInvalidationVersion > request.ScheduledInvalidationVersion)
        {
            return true;
        }

        return _committedVersions.TryGetValue(routeIdentity, out long committed)
            && committed > request.ScheduledInvalidationVersion;
    }

    private void RememberTarget(PublicAotBackfillRequest request)
    {
        long current = Volatile.Read(ref _targetGeneration);
        while (request.ScheduledInvalidationVersion > current)
        {
            long observed = Interlocked.CompareExchange(ref _targetGeneration, request.ScheduledInvalidationVersion, current);
            if (observed == current)
            {
                return;
            }

            current = observed;
        }
    }

    private void SetDisposition(string disposition, string? itemReference, string? failureReason = null)
    {
        Volatile.Write(ref _lastDisposition, disposition);
        if (itemReference is not null)
        {
            Volatile.Write(ref _lastItemReference, itemReference);
        }

        if (failureReason is not null)
        {
            Volatile.Write(ref _lastFailureReason, failureReason);
        }
    }

    private static string ItemReference(PublicAotBackfillRequest request)
        => $"{request.Kind}:{request.RouteKey}:{request.ScheduledInvalidationVersion}";

    private static void Decrement(ref int value)
    {
        int current;
        do
        {
            current = Volatile.Read(ref value);
            if (current <= 0)
            {
                return;
            }
        }
        while (Interlocked.CompareExchange(ref value, current - 1, current) != current);
    }

    private static bool TryReserve(ConcurrentDictionary<string, long> reservations, string key, long version)
    {
        while (true)
        {
            if (!reservations.TryGetValue(key, out long existingVersion))
            {
                if (reservations.TryAdd(key, version))
                {
                    return true;
                }

                continue;
            }

            if (existingVersion >= version)
            {
                return false;
            }

            if (reservations.TryUpdate(key, version, existingVersion))
            {
                return true;
            }
        }
    }

    private static void RemoveReservation(ConcurrentDictionary<string, long> reservations, string key, long version)
        => ((ICollection<KeyValuePair<string, long>>)reservations).Remove(new KeyValuePair<string, long>(key, version));

    private static string BuildRouteIdentity(PublicAotBackfillRequest request)
        => string.Create(
            CultureInfo.InvariantCulture,
            $"{request.TestSessionId ?? string.Empty}|{request.Kind}|{request.RouteKey}");
}
