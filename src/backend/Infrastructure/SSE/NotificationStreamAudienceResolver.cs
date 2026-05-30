using System.Security.Claims;

namespace FsusBlog.Server.Infrastructure.Sse;

internal interface INotificationStreamAudienceResolver
{
    IReadOnlySet<string> ResolveGroups(ClaimsPrincipal principal, string? userId);
}

internal sealed class NotificationStreamAudienceResolver : INotificationStreamAudienceResolver
{
    public IReadOnlySet<string> ResolveGroups(ClaimsPrincipal principal, string? userId)
    {
        var groups = new HashSet<string>(StringComparer.Ordinal) { SseGroups.ContentFeed };
        if (!string.IsNullOrEmpty(userId))
        {
            groups.Add(SseGroups.AuthenticatedUsers);
            if (principal.IsInRole("admin"))
            {
                groups.Add(SseGroups.AdminUsers);
            }
        }

        return groups;
    }
}
