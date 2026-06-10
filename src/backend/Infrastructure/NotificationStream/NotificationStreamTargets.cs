namespace FsusBlog.Server.Infrastructure.NotificationStream;

public static class NotificationStreamGroups
{
    public const string AuthenticatedUsers = "AuthenticatedUsersGroup";
    public const string ContentFeed = "ContentGovernanceGroup";
    public const string AdminUsers = "AdminUsersGroup";
}

public abstract record NotificationStreamTarget;

public sealed record NotificationStreamUserTarget(string UserId) : NotificationStreamTarget;

public sealed record NotificationStreamGroupTarget(string GroupName) : NotificationStreamTarget;

public sealed record NotificationStreamMultiUserTarget(IReadOnlyList<string> UserIds) : NotificationStreamTarget;
