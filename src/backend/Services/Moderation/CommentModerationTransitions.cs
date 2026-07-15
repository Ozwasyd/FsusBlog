using FsusBlog.Server.Entities;

namespace FsusBlog.Server.Services.Moderation;

public static class CommentModerationTransitions
{
    private static readonly HashSet<(CommentModerationStatus From, CommentModerationStatus To)> Allowed =
    [
        (CommentModerationStatus.Pending, CommentModerationStatus.Approved),
        (CommentModerationStatus.Pending, CommentModerationStatus.Rejected),
        (CommentModerationStatus.Pending, CommentModerationStatus.Hidden),
        (CommentModerationStatus.Approved, CommentModerationStatus.Rejected),
        (CommentModerationStatus.Approved, CommentModerationStatus.Hidden),
        (CommentModerationStatus.Rejected, CommentModerationStatus.Approved),
        (CommentModerationStatus.Rejected, CommentModerationStatus.Hidden),
        (CommentModerationStatus.Hidden, CommentModerationStatus.Approved),
        (CommentModerationStatus.Hidden, CommentModerationStatus.Rejected)
    ];

    public static bool IsAllowed(CommentModerationStatus from, CommentModerationStatus to)
        => from != to && Allowed.Contains((from, to));
}
