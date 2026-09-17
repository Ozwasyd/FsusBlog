using System.Net.WebSockets;

using FsusBlog.Server.Infrastructure.Operations;

namespace FsusBlog.Server.Infrastructure.NotificationStream;

public static class NotificationStreamRestartCloseCodes
{
    public const int ServiceRestart = 1012;
    public const int ReplayMissed = 4009;
    public const int ReplayRequired = 4010;
    public const int FullResyncRequired = 4011;
}

public static class NotificationStreamRestartReasons
{
    public const string ServiceRestart = "fsus_service_restart";
    public const string ReplayMissed = "fsus_replay_miss";
    public const string ReplayRequired = "fsus_replay_required";
    public const string FullResyncRequired = "fsus_full_resync_required";
}

public sealed record NotificationStreamCloseInstruction(
    int CloseCode,
    string Reason,
    bool PreserveCursor,
    bool RequireFullResync);

public sealed record NotificationStreamRestartRequest(
    string ReleaseId,
    string Slot,
    long Generation,
    string Reason = "deployment_drain",
    bool DryRun = false);

public sealed record NotificationStreamRestartSnapshot(
    bool Accepted,
    bool Idempotent,
    bool Requested,
    bool DryRun,
    string Status,
    string? ErrorCode,
    string ReleaseId,
    string Slot,
    long Generation,
    string Reason,
    int CloseCode,
    DateTimeOffset? RequestedAtUtc,
    int ConnectionsAtRequest);

public static class NotificationStreamRestartProtocol
{
    public static NotificationStreamCloseInstruction ReplayRequired(string detail)
        => new(
            NotificationStreamRestartCloseCodes.ReplayRequired,
            string.Concat(NotificationStreamRestartReasons.ReplayRequired, ":", NormalizeDetail(detail)),
            PreserveCursor: true,
            RequireFullResync: false);

    public static NotificationStreamCloseInstruction FullResyncRequired(string detail)
        => new(
            NotificationStreamRestartCloseCodes.FullResyncRequired,
            string.Concat(NotificationStreamRestartReasons.FullResyncRequired, ":", NormalizeDetail(detail)),
            PreserveCursor: false,
            RequireFullResync: true);

    public static NotificationStreamCloseInstruction Resolve(bool replayMissed, bool serviceRestartRequested)
    {
        if (replayMissed)
        {
            return new NotificationStreamCloseInstruction(
                NotificationStreamRestartCloseCodes.ReplayMissed,
                NotificationStreamRestartReasons.ReplayMissed,
                PreserveCursor: false,
                RequireFullResync: true);
        }

        if (serviceRestartRequested)
        {
            return new NotificationStreamCloseInstruction(
                NotificationStreamRestartCloseCodes.ServiceRestart,
                NotificationStreamRestartReasons.ServiceRestart,
                PreserveCursor: true,
                RequireFullResync: false);
        }

        return new NotificationStreamCloseInstruction(
            (int)WebSocketCloseStatus.NormalClosure,
            "closed",
            PreserveCursor: true,
            RequireFullResync: false);
    }

    public static WebSocketCloseStatus ToWebSocketCloseStatus(NotificationStreamCloseInstruction instruction)
        => (WebSocketCloseStatus)instruction.CloseCode;

    private static string NormalizeDetail(string detail)
    {
        if (string.IsNullOrWhiteSpace(detail))
        {
            return "backpressure";
        }

        string normalized = detail.Trim().ToLowerInvariant();
        return normalized[..Math.Min(normalized.Length, 64)];
    }
}

public sealed class NotificationStreamRestartCoordinator(
    IReleaseIdentityProvider releaseIdentity,
    DeploymentRuntimeState deploymentRuntime,
    NotificationStreamConnectionManager connectionManager,
    TimeProvider timeProvider)
{
    private readonly object _gate = new();
    private readonly CancellationTokenSource _restart = new();
    private NotificationStreamRestartSnapshot? _snapshot;

    public CancellationToken RestartToken => _restart.Token;

    public bool IsRestartRequested => _restart.IsCancellationRequested;

    public NotificationStreamRestartSnapshot Current
    {
        get
        {
            lock (_gate)
            {
                return _snapshot ?? CreateIdleSnapshot();
            }
        }
    }

    public NotificationStreamRestartSnapshot RequestRestart(NotificationStreamRestartRequest request)
    {
        ReleaseIdentitySnapshot local = releaseIdentity.Current;
        DeploymentRuntimeSnapshot deployment = deploymentRuntime.CreateSnapshot(connectionManager.ConnectionCount);
        string? errorCode = !string.Equals(request.ReleaseId?.Trim(), local.ReleaseId, StringComparison.Ordinal)
            ? "notification_restart_release_mismatch"
            : !string.Equals(request.Slot?.Trim(), local.ReleaseSlot, StringComparison.Ordinal)
                ? "notification_restart_slot_mismatch"
                : request.Generation <= 0 || request.Generation != deployment.Generation
                    ? "notification_restart_generation_mismatch"
                    : null;
        if (errorCode is not null)
        {
            return new NotificationStreamRestartSnapshot(
                false,
                false,
                false,
                request.DryRun,
                "rejected",
                errorCode,
                local.ReleaseId,
                local.ReleaseSlot,
                deployment.Generation,
                NormalizeReason(request.Reason),
                NotificationStreamRestartCloseCodes.ServiceRestart,
                null,
                connectionManager.ConnectionCount);
        }

        lock (_gate)
        {
            if (_snapshot is { Requested: true } existing)
            {
                return existing with
                {
                    Idempotent = true,
                    Status = "already-requested"
                };
            }

            DateTimeOffset now = timeProvider.GetUtcNow();
            var snapshot = new NotificationStreamRestartSnapshot(
                true,
                false,
                Requested: !request.DryRun,
                request.DryRun,
                request.DryRun ? "would-restart" : "restart-requested",
                null,
                local.ReleaseId,
                local.ReleaseSlot,
                deployment.Generation,
                NormalizeReason(request.Reason),
                NotificationStreamRestartCloseCodes.ServiceRestart,
                request.DryRun ? null : now,
                connectionManager.ConnectionCount);
            if (!request.DryRun)
            {
                _snapshot = snapshot;
                _restart.Cancel();
            }
            return snapshot;
        }
    }

    private NotificationStreamRestartSnapshot CreateIdleSnapshot()
    {
        ReleaseIdentitySnapshot local = releaseIdentity.Current;
        DeploymentRuntimeSnapshot deployment = deploymentRuntime.CreateSnapshot(connectionManager.ConnectionCount);
        return new NotificationStreamRestartSnapshot(
            true,
            true,
            false,
            false,
            "idle",
            null,
            local.ReleaseId,
            local.ReleaseSlot,
            deployment.Generation,
            string.Empty,
            NotificationStreamRestartCloseCodes.ServiceRestart,
            null,
            connectionManager.ConnectionCount);
    }

    private static string NormalizeReason(string? reason)
        => string.IsNullOrWhiteSpace(reason) ? "deployment_drain" : reason.Trim().ToLowerInvariant();
}
