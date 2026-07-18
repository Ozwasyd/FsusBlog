using System.Security.Claims;

using FsusBlog.Server.Infrastructure.Helpers;

namespace FsusBlog.Server.Infrastructure.Auth;

/// <summary>Projects authentication, identity-kind, session, and MFA claims into one endpoint-safe value.</summary>
public readonly record struct EndpointUserContext(
    int AccountId,
    long AdminPrincipalId,
    string? IdentityKind,
    string? SessionId,
    bool IsAuthenticated,
    bool IsMfaVerified)
{
    /// <summary>Indicates whether the projected principal uses the anonymous-account identity kind.</summary>
    public bool IsAnonymousAccount => string.Equals(IdentityKind, AnonymousIdentityRuntime.AnonymousAccountKind, StringComparison.Ordinal);

    /// <summary>Indicates whether the projected principal uses the isolated administrator identity kind.</summary>
    public bool IsAdminPrincipal => string.Equals(IdentityKind, AnonymousIdentityRuntime.AdminPrincipalKind, StringComparison.Ordinal);

    /// <summary>Projects an optional claims principal without relying on request-specific extension state.</summary>
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

    /// <summary>Projects the current request principal and its mapped account identifier.</summary>
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
