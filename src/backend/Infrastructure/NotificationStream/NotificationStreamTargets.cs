namespace FsusBlog.Server.Infrastructure.NotificationStream;

public static class NotificationStreamTargetCollections
{
    public const string ContentFeed = "content-feed";
    public const string AdminUsers = "admin-users";
}

public abstract record NotificationStreamTarget;

public sealed record NotificationStreamUserTarget(string UserId) : NotificationStreamTarget;

public sealed record NotificationStreamGroupTarget(string GroupName) : NotificationStreamTarget;

public sealed record NotificationStreamMultiUserTarget(IReadOnlyList<string> UserIds) : NotificationStreamTarget;
