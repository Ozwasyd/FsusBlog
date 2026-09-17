using System.Security.Claims;

using FsusBlog.Server.Infrastructure.Helpers;

namespace FsusBlog.Server.Infrastructure.NotificationStream;

internal interface INotificationStreamConnectionAdmission
{
    Task<NotificationStreamHandshakeResult> AdmitAsync(
        HttpContext context,
        bool isAuthenticated,
        string? preflightGrantToken,
        CancellationToken cancellationToken);
}

internal sealed class NotificationStreamConnectionAdmission(
    INotificationStreamAdmissionService admissionService,
    INotificationStreamAudienceResolver audienceResolver) : INotificationStreamConnectionAdmission
{
    public async Task<NotificationStreamHandshakeResult> AdmitAsync(
        HttpContext context,
        bool isAuthenticated,
        string? preflightGrantToken,
        CancellationToken cancellationToken)
    {
        bool isAdminPrincipal = isAuthenticated
            && context.User.IsAdminPrincipal()
            && context.User.TryGetAdminPrincipalId(out _);
        string? userId = isAuthenticated && !isAdminPrincipal
            ? context.User.FindFirst(ClaimTypes.NameIdentifier)?.Value
            : null;

        NotificationStreamAdmissionResult admission = await admissionService.ValidateAsync(userId, cancellationToken);
        if (!admission.IsAllowed)
        {
            return NotificationStreamHandshakeResult.Failure(
                admission.StatusCode,
                admission.ErrorCode ?? "admission_failed");
        }

        IReadOnlySet<string> groups = audienceResolver.ResolveGroups(context.User, userId);
        return NotificationStreamHandshakeResult.Success(
            new NotificationStreamHandshake(NotificationStreamHandshakeProtocol.Value, userId, groups),
            preflightGrantToken);
    }
}
