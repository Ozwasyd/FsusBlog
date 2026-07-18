namespace FsusBlog.Server.Infrastructure.PublicAot;

public enum PublicAotSsrCircuitState
{
    Closed = 0,
    Open = 1,
    HalfOpen = 2
}

public enum PublicAotSsrFailureClass
{
    Unknown = 0,
    WorkerTimeout = 1,
    WorkerFailure = 2,
    RendererContract = 3,
    DbGateTimeout = 4,
    DocumentComposeFailure = 5,
    CacheWriteFailure = 6
}

public sealed record PublicAotSsrCircuitSnapshot(
    PublicAotSsrCircuitState State,
    int ConsecutiveWorkerFailures,
    DateTimeOffset? OpenedAtUtc,
    DateTimeOffset? NextProbeAtUtc,
    string? LastTransitionReason);

public sealed record PublicAotSsrFailureSnapshot(
    PublicPageKind Kind,
    string RouteKey,
    PublicAotSsrFailureClass FailureClass,
    string Message,
    DateTimeOffset OccurredAtUtc);

public sealed record PublicAotRouteQuarantineSnapshot(
    PublicPageKind Kind,
    string RouteKey,
    PublicAotSsrFailureClass FailureClass,
    string LastFailureReason,
    int FailureCount,
    DateTimeOffset QuarantinedUntilUtc);

public sealed record PublicAotSsrRuntimeSnapshot(
    DateTimeOffset CheckedAtUtc,
    int QueueDepth,
    int QueueCapacity,
    long ScheduledBackfills,
    long DroppedBackfills,
    string? LastDropReason,
    long CompletedBackfills,
    long FailedBackfills,
    long TimeoutCount,
    long RendererContractFailureCount,
    long DbGateTimeoutCount,
    long DocumentComposeFailureCount,
    long CacheWriteFailureCount,
    long WorkerRestartCount,
    DateTimeOffset? LastWorkerStartUtc,
    long StderrWarningCount,
    string? LastStderrWarning,
    PublicAotSsrCircuitSnapshot Circuit,
    PublicAotSsrFailureSnapshot? LastFailure,
    IReadOnlyList<PublicAotRouteQuarantineSnapshot> RouteQuarantines);

public sealed class PublicAotSsrRuntimeState
{
    private readonly object _sync = new();
    private readonly TimeProvider _clock;
    private readonly int _circuitFailureThreshold;
    private readonly TimeSpan _circuitCooldown;
    private readonly int _routeQuarantineFailureThreshold;
    private readonly TimeSpan _routeQuarantineTtl;
    private readonly Dictionary<RouteKey, RouteFailureState> _routeFailures = new();
    private PublicAotSsrCircuitState _circuitState = PublicAotSsrCircuitState.Closed;
    private int _consecutiveWorkerFailures;
    private bool _halfOpenProbeInFlight;
    private DateTimeOffset? _circuitOpenedAtUtc;
    private DateTimeOffset? _nextProbeAtUtc;
    private string? _lastTransitionReason;
    private long _scheduledBackfills;
    private long _droppedBackfills;
    private string? _lastDropReason;
    private long _completedBackfills;
    private long _failedBackfills;
    private long _timeoutCount;
    private long _rendererContractFailureCount;
    private long _dbGateTimeoutCount;
    private long _documentComposeFailureCount;
    private long _cacheWriteFailureCount;
    private long _workerRestartCount;
    private DateTimeOffset? _lastWorkerStartUtc;
    private long _stderrWarningCount;
    private string? _lastStderrWarning;
    private PublicAotSsrFailureSnapshot? _lastFailure;
    private PublicAotSsrWorkerResourceStatus? _workerResourceSnapshot;

    public PublicAotSsrRuntimeState(IConfiguration configuration)
        : this(configuration, TimeProvider.System)
    {
    }

    internal PublicAotSsrRuntimeState(IConfiguration configuration, TimeProvider clock)
    {
        _clock = clock;
        _circuitFailureThreshold = Math.Clamp(configuration.GetValue<int?>("PublicAot:SsrCircuitFailureThreshold") ?? 3, 1, 100);
        _circuitCooldown = TimeSpan.FromSeconds(Math.Clamp(configuration.GetValue<int?>("PublicAot:SsrCircuitCooldownSeconds") ?? 30, 1, 3600));
        _routeQuarantineFailureThreshold = Math.Clamp(configuration.GetValue<int?>("PublicAot:SsrRouteQuarantineFailureThreshold") ?? 2, 1, 100);
        _routeQuarantineTtl = TimeSpan.FromSeconds(Math.Clamp(configuration.GetValue<int?>("PublicAot:SsrRouteQuarantineTtlSeconds") ?? 120, 1, 86400));
    }

    public bool TryBeginBackfill(PublicAotBackfillRequest request, out string reason)
    {
        lock (_sync)
        {
            DateTimeOffset now = _clock.GetUtcNow();
            RemoveExpiredQuarantines(now);
            RouteKey routeKey = RouteKey.FromRequest(request);
            if (_routeFailures.TryGetValue(routeKey, out RouteFailureState? route) &&
                route.QuarantinedUntilUtc is { } quarantinedUntil &&
                quarantinedUntil > now)
            {
                reason = "route-quarantined";
                return false;
            }

            if (_circuitState == PublicAotSsrCircuitState.Open)
            {
                if (_nextProbeAtUtc is { } nextProbeAt && now < nextProbeAt)
                {
                    reason = "circuit-open";
                    return false;
                }

                if (_halfOpenProbeInFlight)
                {
                    reason = "circuit-half-open-probe-in-flight";
                    return false;
                }

                _circuitState = PublicAotSsrCircuitState.HalfOpen;
                _halfOpenProbeInFlight = true;
                _lastTransitionReason = "cooldown-expired";
                reason = "half-open-probe";
                return true;
            }

            if (_circuitState == PublicAotSsrCircuitState.HalfOpen)
            {
                if (_halfOpenProbeInFlight)
                {
                    reason = "circuit-half-open-probe-in-flight";
                    return false;
                }

                _halfOpenProbeInFlight = true;
                reason = "half-open-probe";
                return true;
            }

            reason = string.Empty;
            return true;
        }
    }

    public void RecordBackfillScheduled(PublicAotBackfillRequest request, int queueDepth)
    {
        lock (_sync)
        {
            _scheduledBackfills++;
        }
    }

    public void RecordBackfillDropped(PublicAotBackfillRequest request, string reason, int queueDepth)
    {
        lock (_sync)
        {
            _droppedBackfills++;
            _lastDropReason = reason;
            if (_circuitState == PublicAotSsrCircuitState.HalfOpen &&
                _halfOpenProbeInFlight &&
                (string.Equals(reason, "queue-full", StringComparison.Ordinal) ||
                    string.Equals(reason, "duplicate-cache-key", StringComparison.Ordinal)))
            {
                _halfOpenProbeInFlight = false;
            }
        }
    }

    public void RecordBackfillSuccess(PublicAotBackfillRequest request, TimeSpan duration)
    {
        lock (_sync)
        {
            _completedBackfills++;
            _routeFailures.Remove(RouteKey.FromRequest(request));
            _consecutiveWorkerFailures = 0;
            _halfOpenProbeInFlight = false;
            if (_circuitState != PublicAotSsrCircuitState.Closed)
            {
                _circuitState = PublicAotSsrCircuitState.Closed;
                _circuitOpenedAtUtc = null;
                _nextProbeAtUtc = null;
                _lastTransitionReason = "probe-success";
            }
        }
    }

    public void RecordBackfillFailure(
        PublicAotBackfillRequest request,
        PublicAotSsrFailureClass failureClass,
        string message,
        TimeSpan duration)
    {
        lock (_sync)
        {
            DateTimeOffset now = _clock.GetUtcNow();
            _failedBackfills++;
            IncrementFailureCounter(failureClass);
            _lastFailure = new PublicAotSsrFailureSnapshot(
                request.Kind,
                request.RouteKey,
                failureClass,
                message,
                now);

            if (ShouldQuarantineRoute(failureClass))
            {
                RouteKey routeKey = RouteKey.FromRequest(request);
                if (!_routeFailures.TryGetValue(routeKey, out RouteFailureState? state))
                {
                    state = new RouteFailureState(request.Kind, request.RouteKey);
                    _routeFailures[routeKey] = state;
                }

                state.RecordFailure(failureClass, message);
                if (state.FailureCount >= _routeQuarantineFailureThreshold)
                {
                    state.QuarantinedUntilUtc = now.Add(_routeQuarantineTtl);
                }
            }

            if (IsWorkerFailure(failureClass))
            {
                _consecutiveWorkerFailures++;
                if (_circuitState == PublicAotSsrCircuitState.HalfOpen ||
                    _consecutiveWorkerFailures >= _circuitFailureThreshold)
                {
                    OpenCircuit(now, message);
                }
            }

            if (_circuitState == PublicAotSsrCircuitState.HalfOpen)
            {
                _halfOpenProbeInFlight = false;
            }
        }
    }

    public void RecordWorkerStart()
    {
        lock (_sync)
        {
            _workerRestartCount++;
            _lastWorkerStartUtc = _clock.GetUtcNow();
        }
    }

    public void RecordWorkerStderrWarning(string message)
    {
        lock (_sync)
        {
            _stderrWarningCount++;
            _lastStderrWarning = message;
        }
    }

    public PublicAotSsrWorkerResourceStatus GetOrCreateWorkerResourceSnapshot(Func<PublicAotSsrWorkerResourceStatus> factory)
    {
        lock (_sync)
        {
            if (_workerResourceSnapshot is not null)
            {
                return _workerResourceSnapshot;
            }

            _workerResourceSnapshot = factory();
            return _workerResourceSnapshot;
        }
    }

    public void RecordWorkerResourceSnapshot(PublicAotSsrWorkerResourceStatus status)
    {
        lock (_sync)
        {
            _workerResourceSnapshot = status;
        }
    }

    public void ClearRouteQuarantine(PublicPageKind kind, string routeKey)
    {
        lock (_sync)
        {
            _routeFailures.Remove(new RouteKey(kind, routeKey));
        }
    }

    public void ClearAllRouteQuarantines()
    {
        lock (_sync)
        {
            _routeFailures.Clear();
        }
    }

    public PublicAotSsrRuntimeSnapshot CreateSnapshot(int queueDepth, int queueCapacity)
    {
        lock (_sync)
        {
            DateTimeOffset now = _clock.GetUtcNow();
            RemoveExpiredQuarantines(now);
            PublicAotRouteQuarantineSnapshot[] quarantines =
            [
                .. _routeFailures.Values
                    .Where(static route => route.QuarantinedUntilUtc is not null)
                    .OrderBy(static route => route.Kind)
                    .ThenBy(static route => route.RouteKey, StringComparer.Ordinal)
                    .Select(static route => new PublicAotRouteQuarantineSnapshot(
                        route.Kind,
                        route.RouteKey,
                        route.LastFailureClass,
                        route.LastFailureReason,
                        route.FailureCount,
                        route.QuarantinedUntilUtc!.Value))
            ];

            return new PublicAotSsrRuntimeSnapshot(
                now,
                queueDepth,
                queueCapacity,
                _scheduledBackfills,
                _droppedBackfills,
                _lastDropReason,
                _completedBackfills,
                _failedBackfills,
                _timeoutCount,
                _rendererContractFailureCount,
                _dbGateTimeoutCount,
                _documentComposeFailureCount,
                _cacheWriteFailureCount,
                _workerRestartCount,
                _lastWorkerStartUtc,
                _stderrWarningCount,
                _lastStderrWarning,
                new PublicAotSsrCircuitSnapshot(
                    _circuitState,
                    _consecutiveWorkerFailures,
                    _circuitOpenedAtUtc,
                    _nextProbeAtUtc,
                    _lastTransitionReason),
                _lastFailure,
                quarantines);
        }
    }

    public static PublicAotSsrFailureClass ClassifyFailure(string? message)
    {
        if (string.IsNullOrWhiteSpace(message))
        {
            return PublicAotSsrFailureClass.Unknown;
        }

        if (message.Contains("timed out", StringComparison.OrdinalIgnoreCase) ||
            message.Contains("timeout", StringComparison.OrdinalIgnoreCase))
        {
            return PublicAotSsrFailureClass.WorkerTimeout;
        }

        if (message.Contains("db-gate-timeout", StringComparison.OrdinalIgnoreCase))
        {
            return PublicAotSsrFailureClass.DbGateTimeout;
        }

        if (message.Contains("public_aot_document_compose_failed", StringComparison.OrdinalIgnoreCase))
        {
            return PublicAotSsrFailureClass.DocumentComposeFailure;
        }

        if (message.Contains("public_aot_worker_invalid_aeds", StringComparison.OrdinalIgnoreCase) ||
            message.Contains("public_aot_contract", StringComparison.OrdinalIgnoreCase) ||
            message.Contains("AOT", StringComparison.OrdinalIgnoreCase) && message.Contains("invalid", StringComparison.OrdinalIgnoreCase))
        {
            return PublicAotSsrFailureClass.RendererContract;
        }

        if (message.Contains("public_aot_worker", StringComparison.OrdinalIgnoreCase) ||
            message.Contains("SSR worker", StringComparison.OrdinalIgnoreCase))
        {
            return PublicAotSsrFailureClass.WorkerFailure;
        }

        return PublicAotSsrFailureClass.Unknown;
    }

    private void OpenCircuit(DateTimeOffset now, string reason)
    {
        _circuitState = PublicAotSsrCircuitState.Open;
        _halfOpenProbeInFlight = false;
        _circuitOpenedAtUtc = now;
        _nextProbeAtUtc = now.Add(_circuitCooldown);
        _lastTransitionReason = reason;
    }

    private void IncrementFailureCounter(PublicAotSsrFailureClass failureClass)
    {
        switch (failureClass)
        {
            case PublicAotSsrFailureClass.WorkerTimeout:
                _timeoutCount++;
                break;
            case PublicAotSsrFailureClass.RendererContract:
                _rendererContractFailureCount++;
                break;
            case PublicAotSsrFailureClass.DbGateTimeout:
                _dbGateTimeoutCount++;
                break;
            case PublicAotSsrFailureClass.DocumentComposeFailure:
                _documentComposeFailureCount++;
                break;
            case PublicAotSsrFailureClass.CacheWriteFailure:
                _cacheWriteFailureCount++;
                break;
        }
    }

    private static bool IsWorkerFailure(PublicAotSsrFailureClass failureClass)
        => failureClass is PublicAotSsrFailureClass.WorkerTimeout
            or PublicAotSsrFailureClass.WorkerFailure
            or PublicAotSsrFailureClass.RendererContract;

    private static bool ShouldQuarantineRoute(PublicAotSsrFailureClass failureClass)
        => failureClass is PublicAotSsrFailureClass.RendererContract
            or PublicAotSsrFailureClass.DocumentComposeFailure;

    private void RemoveExpiredQuarantines(DateTimeOffset now)
    {
        RouteKey[] expired =
        [
            .. _routeFailures
                .Where(pair => pair.Value.QuarantinedUntilUtc is { } until && until <= now)
                .Select(static pair => pair.Key)
        ];
        foreach (RouteKey key in expired)
        {
            _routeFailures.Remove(key);
        }
    }

    private readonly record struct RouteKey(PublicPageKind Kind, string RouteKeyValue)
    {
        public static RouteKey FromRequest(PublicAotBackfillRequest request)
            => new(request.Kind, request.RouteKey);
    }

    private sealed class RouteFailureState(PublicPageKind kind, string routeKey)
    {
        public PublicPageKind Kind { get; } = kind;
        public string RouteKey { get; } = routeKey;
        public int FailureCount
        {
            get; private set;
        }
        public PublicAotSsrFailureClass LastFailureClass { get; private set; } = PublicAotSsrFailureClass.Unknown;
        public string LastFailureReason { get; private set; } = string.Empty;
        public DateTimeOffset? QuarantinedUntilUtc
        {
            get; set;
        }

        public void RecordFailure(PublicAotSsrFailureClass failureClass, string message)
        {
            FailureCount++;
            LastFailureClass = failureClass;
            LastFailureReason = message;
        }
    }
}
