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
    long Completed,
    long ReplayRequired,
    long DurableReplayTransferred,
    long AllowedDrops,
    long TerminalFailures,
    long Sequence,
    string? LastFailure)
{
    public long Outstanding => Math.Max(0, Queued) + Math.Max(0, InFlight) + ReplayRequired + TerminalFailures;
}

internal readonly record struct NotificationStreamFanoutDispatchResult(int Accepted, int Rejected);

internal sealed class NotificationStreamDeliveryAccounting
{
    private readonly object _gate = new();
    private NotificationStreamDeliverySnapshot _snapshot = new(0, 0, 0, 0, 0, 0, 0, 0, null);

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
        long completed = 0,
        long replay = 0,
        long transferred = 0,
        long dropped = 0,
        long terminal = 0,
        string? reason = null)
    {
        lock (_gate)
        {
            _snapshot = _snapshot with
            {
                Queued = _snapshot.Queued + queued,
                InFlight = _snapshot.InFlight + inFlight,
                Completed = _snapshot.Completed + completed,
                ReplayRequired = _snapshot.ReplayRequired + replay,
                DurableReplayTransferred = _snapshot.DurableReplayTransferred + transferred,
                AllowedDrops = _snapshot.AllowedDrops + dropped,
                TerminalFailures = _snapshot.TerminalFailures + terminal,
                Sequence = _snapshot.Sequence + 1,
                LastFailure = reason ?? _snapshot.LastFailure
            };
            if (_snapshot.Queued < 0 || _snapshot.InFlight < 0)
            {
                _snapshot = _snapshot with
                {
                    TerminalFailures = _snapshot.TerminalFailures + 1
                };
                throw new InvalidOperationException("notification delivery accounting underflow");
            }
        }
    }
}
