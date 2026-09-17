using System.Security.Claims;

using FsusBlog.Server.Infrastructure.Helpers;

namespace FsusBlog.Server.Infrastructure.NotificationStream;

internal interface INotificationStreamAudienceResolver
{
    IReadOnlySet<string> ResolveGroups(ClaimsPrincipal principal, string? userId);
}

internal sealed class NotificationStreamAudienceResolver : INotificationStreamAudienceResolver
{
    public IReadOnlySet<string> ResolveGroups(ClaimsPrincipal principal, string? userId)
    {
        var groups = new HashSet<string>(StringComparer.Ordinal) { NotificationStreamTargetCollections.ContentFeed };
        if (principal.Identity?.IsAuthenticated == true || !string.IsNullOrEmpty(userId))
        {
            if (principal.IsAdminPrincipal() && principal.TryGetAdminPrincipalId(out _))
            {
                groups.Add(NotificationStreamTargetCollections.AdminUsers);
            }
        }

        return groups;
    }
}
