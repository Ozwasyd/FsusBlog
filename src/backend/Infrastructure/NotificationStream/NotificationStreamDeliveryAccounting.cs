namespace FsusBlog.Server.Infrastructure.NotificationStream;

internal abstract class NotificationStreamBacklogAcceptance
{
    private protected NotificationStreamBacklogAcceptance()
    {
    }

    internal bool Matches(long eventId, NotificationStreamTarget target)
        => Services.NotificationStream.RedisNotificationStreamPublisher.MatchesBacklogAcceptance(this, eventId, target);
}

internal sealed record NotificationStreamDeliverySnapshot(
    long Queued,
    long InFlight,
    long FanoutExpanded,
    long SocketWriteCompleted,
    long LegacyPipeCopyCompleted,
    long ReplayRequired,
    long DurableReplayTransferred,
    long AllowedDrops,
    long TerminalFailures,
    long Sequence,
    string? LastFailure,
    long ReplayReadFailures = 0)
{
    public long Outstanding
        => Math.Max(0, Queued)
            + Math.Max(0, InFlight)
            + ReplayRequired
            + ReplayReadFailures
            + TerminalFailures;
}

internal readonly record struct NotificationStreamFanoutDispatchResult(int Accepted, int Rejected);

internal sealed class NotificationStreamDeliveryAccounting
{
    private readonly object _gate = new();
    private NotificationStreamDeliverySnapshot _snapshot = new(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, null);

    internal NotificationStreamDeliverySnapshot Snapshot()
    {
        lock (_gate)
        {
            return _snapshot;
        }
    }

    internal void Transition(
        long queued = 0,
        long inFlight = 0,
        long fanoutExpanded = 0,
        long socketWriteCompleted = 0,
        long legacyPipeCopyCompleted = 0,
        long replay = 0,
        long transferred = 0,
        long dropped = 0,
        long terminal = 0,
        string? reason = null,
        long replayReadFailures = 0)
    {
        lock (_gate)
        {
            _snapshot = _snapshot with
            {
                Queued = _snapshot.Queued + queued,
                InFlight = _snapshot.InFlight + inFlight,
                FanoutExpanded = _snapshot.FanoutExpanded + fanoutExpanded,
                SocketWriteCompleted = _snapshot.SocketWriteCompleted + socketWriteCompleted,
                LegacyPipeCopyCompleted = _snapshot.LegacyPipeCopyCompleted + legacyPipeCopyCompleted,
                ReplayRequired = _snapshot.ReplayRequired + replay,
                DurableReplayTransferred = _snapshot.DurableReplayTransferred + transferred,
                AllowedDrops = _snapshot.AllowedDrops + dropped,
                TerminalFailures = _snapshot.TerminalFailures + terminal,
                Sequence = _snapshot.Sequence + 1,
                LastFailure = reason ?? _snapshot.LastFailure,
                ReplayReadFailures = _snapshot.ReplayReadFailures + replayReadFailures
            };
            if (_snapshot.Queued < 0 || _snapshot.InFlight < 0 || _snapshot.ReplayReadFailures < 0)
            {
                _snapshot = _snapshot with
                {
                    TerminalFailures = _snapshot.TerminalFailures + 1
                };
                throw new InvalidOperationException("notification delivery accounting underflow");
            }
        }
    }

    internal bool TryResolveReplayReadFailure(string reason)
    {
        lock (_gate)
        {
            if (_snapshot.ReplayReadFailures == 0)
            {
                return false;
            }

            Transition(
                reason: reason,
                replayReadFailures: -1);
            return true;
        }
    }
}
