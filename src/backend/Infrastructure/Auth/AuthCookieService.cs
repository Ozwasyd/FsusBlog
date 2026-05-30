using Microsoft.Extensions.Configuration;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using System.IdentityModel.Tokens.Jwt;

namespace FsusBlog.Server.Infrastructure.Auth;

public sealed class AuthCookieService
{
    private static readonly JwtSecurityTokenHandler JwtHandler = new();
    private const string AccessTokenCookieName = "AccessToken";
    private const string RefreshTokenCookieName = "RefreshToken";
    private const string SessionIdCookieName = "SessionId";
    private const string HostAccessTokenCookieName = "__Host-AccessToken";
    private const string HostRefreshTokenCookieName = "__Host-RefreshToken";
    private const string HostSessionIdCookieName = "__Host-SessionId";
    private readonly bool _allowInsecureTransportCookies;

    public AuthCookieService(IConfiguration configuration)
    {
        _allowInsecureTransportCookies = configuration.GetValue<bool>("AuthCookies:AllowInsecureTransportCookies");
    }

    public void SetTokenCookies(HttpContext context, IWebHostEnvironment env, string accessToken, string refreshToken, DateTime idleExpiresAt)
    {
        var useSecureTransportCookies = !env.IsDevelopment() && !_allowInsecureTransportCookies;
        var baseOptions = new CookieOptions
        {
            HttpOnly = true,
            Secure = useSecureTransportCookies,
            SameSite = SameSiteMode.Strict,
            Path = "/"
        };

        string accessCookieName = useSecureTransportCookies ? HostAccessTokenCookieName : AccessTokenCookieName;
        string refreshCookieName = useSecureTransportCookies ? HostRefreshTokenCookieName : RefreshTokenCookieName;
        string sessionCookieName = useSecureTransportCookies ? HostSessionIdCookieName : SessionIdCookieName;

        context.Response.Cookies.Append(accessCookieName, accessToken, new CookieOptions(baseOptions)
        {
            Expires = DateTime.UtcNow.AddMinutes(15)
        });

        context.Response.Cookies.Append(refreshCookieName, refreshToken, new CookieOptions(baseOptions)
        {
            Expires = idleExpiresAt
        });

        string? sessionId = ReadSessionId(accessToken);
        if (!string.IsNullOrWhiteSpace(sessionId))
        {
            context.Response.Cookies.Append(sessionCookieName, sessionId, new CookieOptions(baseOptions)
            {
                Expires = idleExpiresAt
            });
        }
    }

    public void ClearTokenCookies(HttpContext context)
    {
        var options = new CookieOptions { Path = "/" };
        context.Response.Cookies.Delete(AccessTokenCookieName, options);
        context.Response.Cookies.Delete(RefreshTokenCookieName, options);
        context.Response.Cookies.Delete(SessionIdCookieName, options);
        context.Response.Cookies.Delete(HostAccessTokenCookieName, options);
        context.Response.Cookies.Delete(HostRefreshTokenCookieName, options);
        context.Response.Cookies.Delete(HostSessionIdCookieName, options);
    }

    public string? ReadRefreshToken(HttpContext context)
        => ReadCookie(context, RefreshTokenCookieName, HostRefreshTokenCookieName);

    public string? ReadSessionId(HttpContext context)
        => ReadCookie(context, SessionIdCookieName, HostSessionIdCookieName);

    public static string? ResolveAccessTokenCookieName(bool isProduction)
        => isProduction ? HostAccessTokenCookieName : AccessTokenCookieName;

    private static string? ReadCookie(HttpContext context, string plainName, string hostName)
    {
        if (context.Request.Cookies.TryGetValue(hostName, out var hostValue) && !string.IsNullOrWhiteSpace(hostValue))
        {
            return hostValue;
        }

        if (context.Request.Cookies.TryGetValue(plainName, out var plainValue) && !string.IsNullOrWhiteSpace(plainValue))
        {
            return plainValue;
        }

        return null;
    }

    private static string? ReadSessionId(string accessToken)
    {
        try
        {
            var jwtToken = JwtHandler.ReadJwtToken(accessToken);
            return jwtToken.Claims.FirstOrDefault(c => c.Type == "sid")?.Value;
        }
        catch
        {
            return null;
        }
    }
}
