using System.Security.Claims;

namespace FsusBlog.Server.Infrastructure.NotificationStream;

internal interface INotificationStreamAudienceResolver
{
    IReadOnlySet<string> ResolveGroups(ClaimsPrincipal principal, string? userId);
}

internal sealed class NotificationStreamAudienceResolver : INotificationStreamAudienceResolver
{
    public IReadOnlySet<string> ResolveGroups(ClaimsPrincipal principal, string? userId)
    {
        var groups = new HashSet<string>(StringComparer.Ordinal) { NotificationStreamGroups.ContentFeed };
        if (!string.IsNullOrEmpty(userId))
        {
            groups.Add(NotificationStreamGroups.AuthenticatedUsers);
            if (principal.IsInRole("admin"))
            {
                groups.Add(NotificationStreamGroups.AdminUsers);
            }
        }

        return groups;
    }
}
