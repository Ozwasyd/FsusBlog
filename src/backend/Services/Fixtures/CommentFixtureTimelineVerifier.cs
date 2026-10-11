using FsusBlog.Server.Entities;

namespace FsusBlog.Server.Services.Fixtures;

/// <summary>Reconstructs continuity from supplied production facts without repairing events or deciding moderation policy.</summary>
public static class CommentFixtureTimelineVerifier
{
    /// <summary>Checks the read-port result against its comment and current row, retaining production refusals.</summary>
    public static bool IsConsistent(CommentModerationTimelineResult? timeline, long commentId,
        CommentModerationStatus currentStatus)
    {
        if (timeline is null || !timeline.Consistent || timeline.CommentId != commentId
            || timeline.CurrentStatus != currentStatus || timeline.ProjectedStatus != currentStatus
            || timeline.Events.Any(item => item.CommentId != commentId))
        {
            return false;
        }

        return HasContinuity(timeline.Events.Select(item => (item.Id, item.PreviousStatus, item.NextStatus)),
            currentStatus);
    }

    /// <summary>Checks existing fixture observations in their supplied order; metadata does not authorize a transition.</summary>
    public static bool IsContinuous(IReadOnlyList<CommentFixtureModerationEventObservation>? events,
        CommentModerationStatus currentStatus)
    {
        return events is not null
            && HasContinuity(events.Select(item => (item.Id, item.PreviousStatus, item.NextStatus)), currentStatus);
    }

    private static bool HasContinuity(
        IEnumerable<(long Id, CommentModerationStatus? PreviousStatus, CommentModerationStatus NextStatus)> events,
        CommentModerationStatus currentStatus)
    {
        var identities = new HashSet<long>();
        CommentModerationStatus? projected = null;
        bool hasEvents = false;
        foreach (var (id, previousStatus, nextStatus) in events)
        {
            if (id <= 0 || !identities.Add(id) || previousStatus != projected)
            {
                return false;
            }

            hasEvents = true;
            projected = nextStatus;
        }

        return hasEvents && projected == currentStatus;
    }
}
