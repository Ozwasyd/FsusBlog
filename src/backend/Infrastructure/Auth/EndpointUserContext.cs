using FsusBlog.Server.Infrastructure.Helpers;
using System.Security.Claims;

namespace FsusBlog.Server.Infrastructure.Auth;

public readonly record struct EndpointUserContext(
    int UserId,
    string? SessionId,
    bool IsAuthenticated,
    bool IsMfaVerified)
{
    public static EndpointUserContext From(ClaimsPrincipal? principal)
    {
        bool isAuthenticated = principal?.Identity?.IsAuthenticated == true;
        return new EndpointUserContext(
            principal.GetUserId(),
            principal.GetSessionId(),
            isAuthenticated,
            principal.IsMfaVerified());
    }

    public static EndpointUserContext From(HttpContext httpContext)
    {
        ClaimsPrincipal principal = httpContext.User;
        bool isAuthenticated = principal.Identity?.IsAuthenticated == true;
        return new EndpointUserContext(
            httpContext.GetUserId(),
            principal.GetSessionId(),
            isAuthenticated,
            principal.IsMfaVerified());
    }
}
