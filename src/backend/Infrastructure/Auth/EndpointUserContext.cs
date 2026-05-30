using FsusBlog.Server.Infrastructure.Helpers;
using System.Security.Claims;

namespace FsusBlog.Server.Infrastructure.Auth;

public readonly record struct EndpointUserContext(
    int UserId,
    string UserName,
    string? SessionId,
    bool IsAuthenticated,
    bool IsAdmin,
    bool IsMfaVerified)
{
    public static EndpointUserContext From(ClaimsPrincipal? principal)
    {
        bool isAuthenticated = principal?.Identity?.IsAuthenticated == true;
        return new EndpointUserContext(
            principal.GetUserId(),
            principal.GetUserName(),
            principal.GetSessionId(),
            isAuthenticated,
            principal?.IsInRole("admin") == true,
            principal.IsMfaVerified());
    }

    public static EndpointUserContext From(HttpContext httpContext)
        => From(httpContext.User);
}
