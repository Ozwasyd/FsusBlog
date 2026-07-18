using System.Net;

using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Services.Telemetry;
using FsusBlog.Server.Services.VisitLog;

using Microsoft.AspNetCore.Mvc;

using HttpResults = Microsoft.AspNetCore.Http.Results;

namespace FsusBlog.Server.Infrastructure.Operations;

public static class DeploymentRuntimeModes
{
    public const string Candidate = "candidate";
    public const string Active = "active";
    public const string Draining = "draining";
}

public static class DeploymentLifecycleStates
{
    public const string Starting = "starting";
    public const string Candidate = "candidate";
    public const string Ready = "ready";
    public const string Active = "active";
    public const string Draining = "draining";
    public const string Stopped = "stopped";
    public const string Failed = "failed";
}

public sealed record DeploymentControlRequest(
    string ReleaseId,
    string Slot,
    long Generation,
    int? TimeoutSeconds = null);

public sealed record DeploymentDrainComponentSnapshot(
    string Name,
    long PendingCount,
    bool Blocking,
    string Status,
    string? Error = null);

public sealed record DeploymentDrainSnapshot(
    bool Requested,
    bool Drained,
    bool TimedOut,
    DateTimeOffset? DeadlineUtc,
    IReadOnlyList<string> Blockers,
    IReadOnlyList<DeploymentDrainComponentSnapshot> Components);

public sealed record DeploymentRuntimeSnapshot(
    string ReleaseId,
    string Slot,
    string Mode,
    string State,
    long Generation,
    DateTimeOffset StartedAtUtc,
    DateTimeOffset? ActivatedAtUtc,
    DateTimeOffset? DrainStartedAtUtc,
    int InFlightHttpRequests,
    int NotificationStreamConnections,
    int ActiveBackgroundClaims,
    DeploymentDrainSnapshot Drain,
    bool CanReceiveTraffic,
    bool CanClaimBackgroundWork,
    bool CanAcceptNotificationStream,
    string? LastFailureStage,
    string? LastErrorCode);

public sealed record DeploymentTransitionResult(
    bool Accepted,
    bool Idempotent,
    string Status,
    string? ErrorCode,
    DeploymentRuntimeSnapshot Snapshot);

public sealed record ProductionDeploymentHealthCheck(
    string Status,
    string ReleaseId,
    string Slot,
    string Mode,
    string State,
    long Generation,
    bool CanReceiveTraffic,
    bool CanClaimBackgroundWork,
    DeploymentDrainSnapshot Drain,
    string? Error = null) : IProductionHealthCheck;

public sealed class DeploymentRuntimeState
{
    private readonly object _transitionGate = new();
    private readonly ReleaseIdentitySnapshot _releaseIdentity;
    private readonly TimeProvider _timeProvider;
    private readonly DateTimeOffset _startedAtUtc;
    private string _mode;
    private string _state;
    private long _generation;
    private DateTimeOffset? _activatedAtUtc;
    private DateTimeOffset? _drainStartedAtUtc;
    private DateTimeOffset? _drainDeadlineUtc;
    private string? _lastFailureStage;
    private string? _lastErrorCode;
    private int _runtimeGatesReady;
    private int _inFlightHttpRequests;
    private int _activeBackgroundClaims;
    private DeploymentDrainSnapshot _drain = new(false, false, false, null, [], []);

    public DeploymentRuntimeState(
        IReleaseIdentityProvider releaseIdentity,
        IConfiguration configuration,
        IWebHostEnvironment environment,
        TimeProvider timeProvider)
    {
        _releaseIdentity = releaseIdentity.Current;
        _timeProvider = timeProvider;
        _startedAtUtc = timeProvider.GetUtcNow();
        _generation = configuration.GetValue<long?>("FSUSBLOG_DEPLOYMENT_GENERATION")
            ?? configuration.GetValue<long?>("Deployment:Generation")
            ?? 0;
        string requestedMode = (configuration["FSUSBLOG_DEPLOYMENT_MODE"]
            ?? configuration["Deployment:Mode"]
            ?? string.Empty).Trim().ToLowerInvariant();
        bool productionSlot = environment.IsProduction()
            || _releaseIdentity.ReleaseSlot is "blue" or "green";

        if (productionSlot)
        {
            _mode = DeploymentRuntimeModes.Candidate;
            _state = DeploymentLifecycleStates.Starting;
            if (requestedMode.Length > 0 && requestedMode != DeploymentRuntimeModes.Candidate)
            {
                FailLocked("deployment-mode", "production_instance_must_start_candidate");
            }
            else if (_generation <= 0)
            {
                FailLocked("deployment-generation", "deployment_generation_missing");
            }
        }
        else
        {
            _mode = DeploymentRuntimeModes.Active;
            _state = DeploymentLifecycleStates.Active;
            _activatedAtUtc = _startedAtUtc;
            Volatile.Write(ref _runtimeGatesReady, 1);
        }
    }

    public bool CanReceiveTraffic
        => string.Equals(Volatile.Read(ref _state), DeploymentLifecycleStates.Active, StringComparison.Ordinal);

    public bool CanClaimBackgroundWork => CanReceiveTraffic;

    public bool CanAcceptNotificationStream => CanReceiveTraffic;

    public bool IsDraining
        => Volatile.Read(ref _state) == DeploymentLifecycleStates.Draining;

    public bool CanServeReadiness
    {
        get
        {
            string state = Volatile.Read(ref _state);
            return Volatile.Read(ref _runtimeGatesReady) == 1
                && (state == DeploymentLifecycleStates.Ready || state == DeploymentLifecycleStates.Active);
        }
    }

    public void MarkStartupCompleted()
    {
        lock (_transitionGate)
        {
            if (_state == DeploymentLifecycleStates.Starting)
            {
                _state = DeploymentLifecycleStates.Candidate;
            }
        }
    }

    public void MarkStartupFailed(string stage, string errorCode)
    {
        lock (_transitionGate)
        {
            FailLocked(stage, errorCode);
        }
    }

    public void ReportReadiness(bool gatesReady)
    {
        lock (_transitionGate)
        {
            Volatile.Write(ref _runtimeGatesReady, gatesReady ? 1 : 0);
            if (_state == DeploymentLifecycleStates.Candidate && gatesReady)
            {
                _state = DeploymentLifecycleStates.Ready;
            }
            else if (_state == DeploymentLifecycleStates.Ready && !gatesReady)
            {
                _state = DeploymentLifecycleStates.Candidate;
            }
        }
    }

    public DeploymentTransitionResult Activate(DeploymentControlRequest request, DeploymentRuntimeSnapshot snapshot)
    {
        lock (_transitionGate)
        {
            string? identityError = ValidateIdentity(request);
            if (identityError is not null)
            {
                return Rejected(identityError, snapshot);
            }
            if (_state == DeploymentLifecycleStates.Active)
            {
                return Accepted("already-active", idempotent: true, snapshot);
            }
            if (_state == DeploymentLifecycleStates.Draining)
            {
                return Rejected("deployment_is_draining", snapshot);
            }
            if (_state != DeploymentLifecycleStates.Ready || Volatile.Read(ref _runtimeGatesReady) != 1)
            {
                return Rejected("candidate_not_ready", snapshot);
            }

            _mode = DeploymentRuntimeModes.Active;
            _state = DeploymentLifecycleStates.Active;
            _activatedAtUtc = _timeProvider.GetUtcNow();
            _lastFailureStage = null;
            _lastErrorCode = null;
            return Accepted("activated", idempotent: false, snapshot);
        }
    }

    public DeploymentTransitionResult BeginDrain(
        DeploymentControlRequest request,
        TimeSpan timeout,
        DeploymentRuntimeSnapshot snapshot)
    {
        lock (_transitionGate)
        {
            string? identityError = ValidateIdentity(request);
            if (identityError is not null)
            {
                return Rejected(identityError, snapshot);
            }
            if (_state == DeploymentLifecycleStates.Draining)
            {
                return Accepted("already-draining", idempotent: true, snapshot);
            }
            if (_state == DeploymentLifecycleStates.Stopped)
            {
                return Accepted("already-stopped", idempotent: true, snapshot);
            }
            if (_state == DeploymentLifecycleStates.Starting)
            {
                return Rejected("deployment_still_starting", snapshot);
            }

            DateTimeOffset now = _timeProvider.GetUtcNow();
            _mode = DeploymentRuntimeModes.Draining;
            _state = DeploymentLifecycleStates.Draining;
            _drainStartedAtUtc = now;
            _drainDeadlineUtc = now.Add(timeout);
            Volatile.Write(ref _runtimeGatesReady, 0);
            _drain = new DeploymentDrainSnapshot(true, false, false, _drainDeadlineUtc, ["snapshot-pending"], []);
            return Accepted("drain-started", idempotent: false, snapshot);
        }
    }

    public bool TryBeginHostDrain(TimeSpan timeout)
    {
        lock (_transitionGate)
        {
            if (_state is DeploymentLifecycleStates.Draining or DeploymentLifecycleStates.Stopped)
            {
                return false;
            }
            DateTimeOffset now = _timeProvider.GetUtcNow();
            _mode = DeploymentRuntimeModes.Draining;
            _state = DeploymentLifecycleStates.Draining;
            _drainStartedAtUtc = now;
            _drainDeadlineUtc = now.Add(timeout);
            Volatile.Write(ref _runtimeGatesReady, 0);
            _drain = new DeploymentDrainSnapshot(true, false, false, _drainDeadlineUtc, ["snapshot-pending"], []);
            return true;
        }
    }

    public bool TryEnterHttpRequest(out IDisposable? lease)
    {
        lease = null;
        if (!CanEnterOrdinaryRequest(Volatile.Read(ref _state)))
        {
            return false;
        }

        Interlocked.Increment(ref _inFlightHttpRequests);
        if (!CanEnterOrdinaryRequest(Volatile.Read(ref _state)))
        {
            Interlocked.Decrement(ref _inFlightHttpRequests);
            return false;
        }

        lease = new CounterLease(this, CounterKind.Http);
        return true;
    }

    public bool TryBeginBackgroundClaim(out IDisposable? lease)
    {
        lease = null;
        if (!CanClaimBackgroundWork)
        {
            return false;
        }

        Interlocked.Increment(ref _activeBackgroundClaims);
        if (!CanClaimBackgroundWork)
        {
            Interlocked.Decrement(ref _activeBackgroundClaims);
            return false;
        }

        lease = new CounterLease(this, CounterKind.Background);
        return true;
    }

    public void PublishDrainSnapshot(IReadOnlyList<DeploymentDrainComponentSnapshot> components, bool timedOut)
    {
        string[] blockers = components
            .Where(static component => component.Blocking
                && (component.PendingCount > 0 || !string.IsNullOrWhiteSpace(component.Error)))
            .Select(static component => component.Name)
            .OrderBy(static name => name, StringComparer.Ordinal)
            .ToArray();
        bool drained = blockers.Length == 0 && !timedOut;
        lock (_transitionGate)
        {
            _drain = new DeploymentDrainSnapshot(
                Requested: _drainStartedAtUtc.HasValue,
                Drained: drained,
                TimedOut: timedOut,
                DeadlineUtc: _drainDeadlineUtc,
                Blockers: blockers,
                Components: components);
            if (timedOut)
            {
                _lastFailureStage = "deployment-drain";
                _lastErrorCode = "deployment_drain_timeout";
            }
        }
    }

    public void MarkStopped(bool complete)
    {
        lock (_transitionGate)
        {
            if (!complete)
            {
                _lastFailureStage = "deployment-stop";
                _lastErrorCode = "deployment_stop_incomplete";
            }
            _state = DeploymentLifecycleStates.Stopped;
            _mode = DeploymentRuntimeModes.Draining;
            Volatile.Write(ref _runtimeGatesReady, 0);
        }
    }

    public DeploymentRuntimeSnapshot CreateSnapshot(
        int notificationStreamConnections,
        IReadOnlyList<DeploymentDrainComponentSnapshot>? components = null)
    {
        lock (_transitionGate)
        {
            DeploymentDrainSnapshot drain = components is null
                ? _drain
                : _drain with
                {
                    Components = components
                };
            return new DeploymentRuntimeSnapshot(
                _releaseIdentity.ReleaseId,
                _releaseIdentity.ReleaseSlot,
                _mode,
                _state,
                _generation,
                _startedAtUtc,
                _activatedAtUtc,
                _drainStartedAtUtc,
                Math.Max(0, Volatile.Read(ref _inFlightHttpRequests)),
                Math.Max(0, notificationStreamConnections),
                Math.Max(0, Volatile.Read(ref _activeBackgroundClaims)),
                drain,
                CanReceiveTraffic,
                CanClaimBackgroundWork,
                CanAcceptNotificationStream,
                _lastFailureStage,
                _lastErrorCode);
        }
    }

    private string? ValidateIdentity(DeploymentControlRequest request)
    {
        if (!string.Equals((request.ReleaseId ?? string.Empty).Trim(), _releaseIdentity.ReleaseId, StringComparison.Ordinal))
        {
            return "deployment_release_mismatch";
        }
        if (!string.Equals((request.Slot ?? string.Empty).Trim(), _releaseIdentity.ReleaseSlot, StringComparison.Ordinal))
        {
            return "deployment_slot_mismatch";
        }
        return request.Generation == _generation && request.Generation > 0
            ? null
            : "deployment_generation_mismatch";
    }

    private static bool CanEnterOrdinaryRequest(string state)
        => state is not DeploymentLifecycleStates.Draining
            and not DeploymentLifecycleStates.Stopped
            and not DeploymentLifecycleStates.Failed;

    private DeploymentTransitionResult Accepted(string status, bool idempotent, DeploymentRuntimeSnapshot snapshot)
        => new(true, idempotent, status, null, SnapshotWithCurrentState(snapshot));

    private DeploymentTransitionResult Rejected(string errorCode, DeploymentRuntimeSnapshot snapshot)
        => new(false, false, "rejected", errorCode, SnapshotWithCurrentState(snapshot));

    private DeploymentRuntimeSnapshot SnapshotWithCurrentState(DeploymentRuntimeSnapshot snapshot)
        => CreateSnapshot(snapshot.NotificationStreamConnections, snapshot.Drain.Components);

    private void FailLocked(string stage, string errorCode)
    {
        _mode = DeploymentRuntimeModes.Candidate;
        _state = DeploymentLifecycleStates.Failed;
        _lastFailureStage = stage;
        _lastErrorCode = errorCode;
        Volatile.Write(ref _runtimeGatesReady, 0);
    }

    private void Release(CounterKind kind)
    {
        ref int counter = ref (kind == CounterKind.Http
            ? ref _inFlightHttpRequests
            : ref _activeBackgroundClaims);
        int remaining = Interlocked.Decrement(ref counter);
        if (remaining < 0)
        {
            Interlocked.Exchange(ref counter, 0);
        }
    }

    private enum CounterKind
    {
        Http,
        Background
    }

    private sealed class CounterLease(DeploymentRuntimeState owner, CounterKind kind) : IDisposable
    {
        private DeploymentRuntimeState? _owner = owner;

        public void Dispose()
        {
            DeploymentRuntimeState? current = Interlocked.Exchange(ref _owner, null);
            current?.Release(kind);
        }
    }
}

public sealed class DeploymentDrainCoordinator(
    DeploymentRuntimeState state,
    IServiceProvider serviceProvider,
    IConfiguration configuration,
    TimeProvider timeProvider,
    ILogger<DeploymentDrainCoordinator> logger)
{
    private readonly object _taskGate = new();
    private Task? _drainTask;

    public DeploymentRuntimeSnapshot CreateSnapshot()
    {
        IReadOnlyList<DeploymentDrainComponentSnapshot> components = CaptureComponents();
        int notificationConnections = serviceProvider.GetService<NotificationStreamConnectionManager>()?.ConnectionCount ?? 0;
        return state.CreateSnapshot(notificationConnections, components);
    }

    public ProductionDeploymentHealthCheck EvaluateReadiness(bool dependencyGatesReady)
    {
        state.ReportReadiness(dependencyGatesReady);
        DeploymentRuntimeSnapshot snapshot = CreateSnapshot();
        bool ready = dependencyGatesReady && state.CanServeReadiness;
        return new ProductionDeploymentHealthCheck(
            ready ? "ok" : "failed",
            snapshot.ReleaseId,
            snapshot.Slot,
            snapshot.Mode,
            snapshot.State,
            snapshot.Generation,
            snapshot.CanReceiveTraffic,
            snapshot.CanClaimBackgroundWork,
            snapshot.Drain,
            ready ? null : ResolveReadinessError(snapshot));
    }

    public ProductionHealthReport ApplyCurrentState(ProductionHealthReport report)
    {
        DeploymentRuntimeSnapshot snapshot = CreateSnapshot();
        var checks = new Dictionary<string, object?>(report.Checks.Count, StringComparer.Ordinal);
        foreach ((string key, object? value) in report.Checks)
        {
            checks[key] = value;
        }
        checks["deployment"] = new ProductionDeploymentHealthCheck(
            state.CanServeReadiness ? "ok" : "failed",
            snapshot.ReleaseId,
            snapshot.Slot,
            snapshot.Mode,
            snapshot.State,
            snapshot.Generation,
            snapshot.CanReceiveTraffic,
            snapshot.CanClaimBackgroundWork,
            snapshot.Drain,
            state.CanServeReadiness ? null : ResolveReadinessError(snapshot));
        return report with
        {
            Status = report.Status == "ready" && state.CanServeReadiness ? "ready" : "not_ready",
            Checks = checks
        };
    }

    public DeploymentTransitionResult Activate(DeploymentControlRequest request)
        => state.Activate(request, CreateSnapshot());

    public DeploymentTransitionResult BeginDrain(DeploymentControlRequest request)
    {
        TimeSpan timeout = ResolveTimeout(request.TimeoutSeconds);
        DeploymentTransitionResult result = state.BeginDrain(request, timeout, CreateSnapshot());
        if (result.Accepted
            && (!result.Idempotent || (!result.Snapshot.Drain.Drained && !result.Snapshot.Drain.TimedOut)))
        {
            EnsureDrainTask(timeout);
        }
        return result with
        {
            Snapshot = CreateSnapshot()
        };
    }

    public async Task<bool> DrainForHostStopAsync(CancellationToken cancellationToken)
    {
        TimeSpan timeout = ResolveTimeout(null);
        state.TryBeginHostDrain(timeout);
        Task task = EnsureDrainTask(timeout);
        try
        {
            await task.WaitAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            state.PublishDrainSnapshot(CaptureComponents(), timedOut: true);
            return false;
        }
        return CreateSnapshot().Drain.Drained;
    }

    public void SignalHostStopping()
        => state.TryBeginHostDrain(ResolveTimeout(null));

    private Task EnsureDrainTask(TimeSpan timeout)
    {
        lock (_taskGate)
        {
            if (_drainTask is null || _drainTask.IsCompleted)
            {
                _drainTask = RunDrainAsync(timeout);
            }
            return _drainTask;
        }
    }

    private async Task RunDrainAsync(TimeSpan timeout)
    {
        DateTimeOffset deadline = timeProvider.GetUtcNow().Add(timeout);
        ReleaseDrainRunResult? participantResult = null;
        try
        {
            if (serviceProvider.GetService<ReleaseDrainParticipantRegistry>() is { } releaseDrainParticipants)
            {
                participantResult = await releaseDrainParticipants
                    .DrainAsync(timeout, CancellationToken.None)
                    .ConfigureAwait(false);
                if (!participantResult.Drained)
                {
                    state.PublishDrainSnapshot(
                        CaptureComponents(participantResult.Participants),
                        timedOut: true);
                    return;
                }
            }
            else if (serviceProvider.GetService<IArticleViewWriteBuffer>() is { } articleViews)
            {
                await articleViews.FlushAsync(CancellationToken.None).ConfigureAwait(false);
            }
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "deployment-drain article view flush failed");
        }

        while (true)
        {
            IReadOnlyList<DeploymentDrainComponentSnapshot> components = CaptureComponents(participantResult?.Participants);
            bool drained = components.All(static component => !component.Blocking
                || (component.PendingCount == 0 && string.IsNullOrWhiteSpace(component.Error)));
            if (drained)
            {
                state.PublishDrainSnapshot(components, timedOut: false);
                return;
            }
            if (timeProvider.GetUtcNow() >= deadline)
            {
                state.PublishDrainSnapshot(components, timedOut: true);
                logger.LogError(
                    "deployment-drain timed out. Blockers={Blockers}",
                    string.Join(',', components
                        .Where(static item => item.Blocking
                            && (item.PendingCount > 0 || !string.IsNullOrWhiteSpace(item.Error)))
                        .Select(static item => item.Name)));
                return;
            }
            await Task.Delay(TimeSpan.FromMilliseconds(100), timeProvider, CancellationToken.None).ConfigureAwait(false);
        }
    }

    private IReadOnlyList<DeploymentDrainComponentSnapshot> CaptureComponents(
        IReadOnlyList<ReleaseDrainParticipantSnapshot>? participantOverrides = null)
    {
        var components = new List<DeploymentDrainComponentSnapshot>(12);
        DeploymentRuntimeSnapshot runtime = state.CreateSnapshot(
            serviceProvider.GetService<NotificationStreamConnectionManager>()?.ConnectionCount ?? 0);
        Add(components, "http-in-flight", runtime.InFlightHttpRequests);
        Add(components, "notification-stream", runtime.NotificationStreamConnections);
        Add(components, "background-claims", runtime.ActiveBackgroundClaims);

        if (serviceProvider.GetService<IArticleViewWriteBuffer>() is ArticleViewWriteBuffer articleViews)
        {
            ArticleViewBufferSnapshot snapshot = articleViews.CreateSnapshot();
            Add(components, "article-view-buffer", snapshot.PendingArticleCount);
        }
        if (serviceProvider.GetService<AuditLogChannel>() is { } audit)
        {
            Add(components, "audit-log", audit.Snapshot().QueuedCount);
        }
        if (serviceProvider.GetService<AdminAuditLogChannel>() is { } adminAudit)
        {
            Add(components, "admin-audit-log", adminAudit.QueuedCount);
        }
        if (serviceProvider.GetService<VisitLogChannel>() is { } visitLog)
        {
            Add(components, "visit-log", visitLog.QueuedCount);
        }
        if (serviceProvider.GetService<RumTelemetryChannel>() is { } rum)
        {
            Add(components, "rum-telemetry", rum.CreateSnapshot().QueuedBatches);
        }
        if (serviceProvider.GetService<SecurityRiskEventWriteQueue>() is { } risk)
        {
            Add(components, "security-risk-events", risk.Snapshot().QueuedCount);
        }
        if (serviceProvider.GetService<ChallengeV2AuditEventQueue>() is { } challenge)
        {
            ChallengeV2AuditEventQueueSnapshot snapshot = challenge.Snapshot();
            Add(components, "challenge-audit-events", snapshot.NormalQueuedCount + snapshot.HighValueQueuedCount);
        }
        if (serviceProvider.GetService<PublicHotArtifactUpdateQueue>() is { } publicHot)
        {
            Add(components, "public-hot-updates", publicHot.QueuedCount);
        }
        if (serviceProvider.GetService<UploadSessionCleanupQueue>() is { } uploadCleanup)
        {
            Add(components, "upload-cleanup-signals", uploadCleanup.PendingSignalCount);
        }
        IReadOnlyList<ReleaseDrainParticipantSnapshot>? participants = participantOverrides
            ?? serviceProvider.GetService<ReleaseDrainParticipantRegistry>()?.Snapshot();
        if (participants is not null)
        {
            foreach (ReleaseDrainParticipantSnapshot participant in participants)
            {
                components.Add(new DeploymentDrainComponentSnapshot(
                    participant.Name,
                    Math.Max(0, participant.PendingCount),
                    Blocking: true,
                    participant.Status,
                    participant.ErrorCode));
            }
        }
        return components;
    }

    private static void Add(List<DeploymentDrainComponentSnapshot> components, string name, long pending)
        => components.Add(new DeploymentDrainComponentSnapshot(
            name,
            Math.Max(0, pending),
            Blocking: true,
            pending <= 0 ? "drained" : "pending"));

    private TimeSpan ResolveTimeout(int? requestedSeconds)
    {
        int configured = configuration.GetValue<int?>("Deployment:DrainTimeoutSeconds")
            ?? configuration.GetValue<int?>("FSUSBLOG_DRAIN_TIMEOUT_SECONDS")
            ?? 45;
        int seconds = Math.Clamp(requestedSeconds ?? configured, 5, 300);
        return TimeSpan.FromSeconds(seconds);
    }

    private static string ResolveReadinessError(DeploymentRuntimeSnapshot snapshot)
        => snapshot.State switch
        {
            DeploymentLifecycleStates.Starting => "deployment_starting",
            DeploymentLifecycleStates.Candidate => "candidate_runtime_gates_not_ready",
            DeploymentLifecycleStates.Draining => "deployment_draining",
            DeploymentLifecycleStates.Stopped => "deployment_stopped",
            DeploymentLifecycleStates.Failed => snapshot.LastErrorCode ?? "deployment_failed",
            _ => "deployment_not_ready"
        };
}

public sealed class DeploymentLifecycleHostedService(
    DeploymentRuntimeState state,
    DeploymentDrainCoordinator drainCoordinator,
    IHostApplicationLifetime applicationLifetime,
    ILogger<DeploymentLifecycleHostedService> logger) : IHostedService
{
    private CancellationTokenRegistration _stoppingRegistration;

    public Task StartAsync(CancellationToken cancellationToken)
    {
        _stoppingRegistration = applicationLifetime.ApplicationStopping.Register(() =>
        {
            drainCoordinator.SignalHostStopping();
            logger.LogInformation("deployment-runtime entered draining from host ApplicationStopping");
        });
        return Task.CompletedTask;
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        bool complete = await drainCoordinator.DrainForHostStopAsync(cancellationToken).ConfigureAwait(false);
        state.MarkStopped(complete);
        _stoppingRegistration.Dispose();
        if (!complete)
        {
            logger.LogError("deployment-runtime stopped with incomplete drain evidence");
        }
    }
}

public sealed class DeploymentRequestTrackingMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext context, DeploymentRuntimeState deployment)
    {
        if (IsControlPlane(context.Request.Path) || IsNotificationStream(context.Request.Path))
        {
            await next(context).ConfigureAwait(false);
            return;
        }

        if (!deployment.TryEnterHttpRequest(out IDisposable? lease))
        {
            context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
            context.Response.Headers.RetryAfter = "5";
            context.Response.Headers.CacheControl = "no-store";
            await context.Response.WriteAsJsonAsync(new
            {
                status = "draining",
                retryable = true
            }, context.RequestAborted);
            return;
        }

        using (lease)
        {
            await next(context).ConfigureAwait(false);
        }
    }

    internal static bool IsControlPlane(PathString path)
        => path.StartsWithSegments("/health", StringComparison.OrdinalIgnoreCase)
            || path.StartsWithSegments("/api/ops", StringComparison.OrdinalIgnoreCase);

    internal static bool IsNotificationStream(PathString path)
        => path.StartsWithSegments("/api/notifications/stream", StringComparison.OrdinalIgnoreCase);
}

public static class DeploymentControlEndpoints
{
    public static IEndpointRouteBuilder MapDeploymentControlEndpoints(this IEndpointRouteBuilder endpoints)
    {
        endpoints.MapGet("/api/ops/deployment/status", (
            HttpContext context,
            [FromServices] DeploymentDrainCoordinator deployment) =>
        {
            if (!IsTrustedHostControl(context))
            {
                return HttpResults.Json(new
                {
                    status = "rejected",
                    errorCode = "trusted_host_required"
                }, statusCode: StatusCodes.Status403Forbidden);
            }
            return HttpResults.Json(deployment.CreateSnapshot());
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig)
        .RequireRateLimiting("fixed_ip");

        endpoints.MapPost("/api/ops/deployment/activate", async Task<IResult> (
            HttpContext context,
            DeploymentControlRequest request,
            [FromServices] DeploymentDrainCoordinator deployment,
            [FromServices] IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            if (!IsTrustedHostControl(context))
            {
                return HttpResults.Json(new
                {
                    status = "rejected",
                    errorCode = "trusted_host_required"
                }, statusCode: StatusCodes.Status403Forbidden);
            }
            DeploymentTransitionResult result = deployment.Activate(request);
            await RecordTransitionAuditAsync(context, auditEvents, "activate", result, cancellationToken);
            return HttpResults.Json(result, statusCode: result.Accepted ? StatusCodes.Status200OK : StatusCodes.Status409Conflict);
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig)
        .RequireRateLimiting("fixed_ip");

        endpoints.MapPost("/api/ops/deployment/drain", async Task<IResult> (
            HttpContext context,
            DeploymentControlRequest request,
            [FromServices] DeploymentDrainCoordinator deployment,
            [FromServices] IAuditEventService auditEvents,
            CancellationToken cancellationToken) =>
        {
            if (!IsTrustedHostControl(context))
            {
                return HttpResults.Json(new
                {
                    status = "rejected",
                    errorCode = "trusted_host_required"
                }, statusCode: StatusCodes.Status403Forbidden);
            }
            DeploymentTransitionResult result = deployment.BeginDrain(request);
            await RecordTransitionAuditAsync(context, auditEvents, "drain", result, cancellationToken);
            return HttpResults.Json(result, statusCode: result.Accepted ? StatusCodes.Status202Accepted : StatusCodes.Status409Conflict);
        })
        .RequireAdminPermission(AdminPermissions.SystemConfig)
        .RequireRateLimiting("fixed_ip");

        return endpoints;
    }

    internal static bool IsTrustedHostControl(HttpContext context)
        => context.Connection.RemoteIpAddress is IPAddress address && IPAddress.IsLoopback(address);

    private static Task RecordTransitionAuditAsync(
        HttpContext context,
        IAuditEventService auditEvents,
        string action,
        DeploymentTransitionResult result,
        CancellationToken cancellationToken)
    {
        _ = context.User.TryGetAdminPrincipalId(out long adminId);
        return auditEvents.RecordHighValueAsync(new AuditEvent(
            AuditSourceCatalog.Admin,
            AuditTypeCatalog.Infra,
            $"deployment.{action}",
            result.Accepted ? AuditOutcomeCatalog.Success : AuditOutcomeCatalog.Denied,
            result.Accepted ? AuditSeverityCatalog.Warning : AuditSeverityCatalog.Error,
            $"Deployment {action} control transition",
            ActorType: AnonymousIdentityRuntime.AdminPrincipalKind,
            ActorId: adminId > 0 ? adminId.ToString(System.Globalization.CultureInfo.InvariantCulture) : null,
            TargetType: "deployment_release",
            TargetId: result.Snapshot.ReleaseId,
            ReasonCode: result.ErrorCode,
            Context: new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["slot"] = result.Snapshot.Slot,
                ["generation"] = result.Snapshot.Generation,
                ["state"] = result.Snapshot.State,
                ["status"] = result.Status,
                ["idempotent"] = result.Idempotent
            }), cancellationToken);
    }
}
