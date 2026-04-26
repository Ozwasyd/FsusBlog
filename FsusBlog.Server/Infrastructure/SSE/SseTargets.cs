namespace FsusBlog.Server.Infrastructure.Sse;

public static class SseGroups
{
    public const string AuthenticatedUsers = "AuthenticatedUsersGroup";
    public const string ContentFeed = "ContentGovernanceGroup";
    public const string AdminUsers = "AdminUsersGroup";
}

public abstract record SseTarget;

public sealed record UserTarget(string UserId) : SseTarget;

public sealed record GroupTarget(string GroupName) : SseTarget;

public sealed record MultiUserTarget(IReadOnlyList<string> UserIds) : SseTarget;
