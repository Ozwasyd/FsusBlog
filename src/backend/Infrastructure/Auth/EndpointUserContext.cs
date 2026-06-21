using FsusBlog.Server.Infrastructure.Helpers;
using System.Security.Claims;

namespace FsusBlog.Server.Infrastructure.Auth;

public readonly record struct EndpointUserContext(
    int AccountId,
    long AdminPrincipalId,
    string? IdentityKind,
    string? SessionId,
    bool IsAuthenticated,
    bool IsMfaVerified)
{
    public bool IsAnonymousAccount => string.Equals(IdentityKind, AnonymousIdentityRuntime.AnonymousAccountKind, StringComparison.Ordinal);

    public bool IsAdminPrincipal => string.Equals(IdentityKind, AnonymousIdentityRuntime.AdminPrincipalKind, StringComparison.Ordinal);

    public static EndpointUserContext From(ClaimsPrincipal? principal)
    {
        bool isAuthenticated = principal?.Identity?.IsAuthenticated == true;
        _ = principal.TryGetAdminPrincipalId(out long adminPrincipalId);
        return new EndpointUserContext(
            principal.GetUserId(),
            adminPrincipalId,
            principal?.FindFirst("identity_kind")?.Value,
            principal.GetSessionId(),
            isAuthenticated,
            principal.IsMfaVerified());
    }

    public static EndpointUserContext From(HttpContext httpContext)
    {
        ClaimsPrincipal principal = httpContext.User;
        bool isAuthenticated = principal.Identity?.IsAuthenticated == true;
        _ = principal.TryGetAdminPrincipalId(out long adminPrincipalId);
        return new EndpointUserContext(
            httpContext.GetUserId(),
            adminPrincipalId,
            principal.FindFirst("identity_kind")?.Value,
            principal.GetSessionId(),
            isAuthenticated,
            principal.IsMfaVerified());
    }
}
