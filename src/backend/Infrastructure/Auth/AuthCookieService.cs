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
        CookieOptions baseOptions = CreateBaseOptions(env);
        bool useSecureTransportCookies = baseOptions.Secure;

        string accessCookieName = useSecureTransportCookies ? HostAccessTokenCookieName : AccessTokenCookieName;
        string refreshCookieName = useSecureTransportCookies ? HostRefreshTokenCookieName : RefreshTokenCookieName;
        string sessionCookieName = useSecureTransportCookies ? HostSessionIdCookieName : SessionIdCookieName;

        AppendAccessTokenCookie(context, accessCookieName, accessToken, baseOptions);

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

    public void SetAccessTokenCookie(HttpContext context, IWebHostEnvironment env, string accessToken)
    {
        CookieOptions baseOptions = CreateBaseOptions(env);
        string accessCookieName = baseOptions.Secure ? HostAccessTokenCookieName : AccessTokenCookieName;
        AppendAccessTokenCookie(context, accessCookieName, accessToken, baseOptions);
    }

    private CookieOptions CreateBaseOptions(IWebHostEnvironment env)
    {
        bool secure = !env.IsDevelopment() || !_allowInsecureTransportCookies;
        return new CookieOptions
        {
            HttpOnly = true,
            Secure = secure,
            SameSite = SameSiteMode.Strict,
            Path = "/"
        };
    }

    private static void AppendAccessTokenCookie(HttpContext context, string cookieName, string accessToken, CookieOptions baseOptions)
        => context.Response.Cookies.Append(cookieName, accessToken, new CookieOptions(baseOptions)
        {
            Expires = DateTime.UtcNow.AddMinutes(15)
        });

    public void ClearTokenCookies(HttpContext context)
    {
        var options = new CookieOptions { Path = "/" };
        context.Response.Cookies.Delete(AccessTokenCookieName, options);
        context.Response.Cookies.Delete(RefreshTokenCookieName, options);
        context.Response.Cookies.Delete(SessionIdCookieName, options);

        CookieOptions hostOptions = CreateHostPrefixedDeleteOptions();
        context.Response.Cookies.Delete(HostAccessTokenCookieName, hostOptions);
        context.Response.Cookies.Delete(HostRefreshTokenCookieName, hostOptions);
        context.Response.Cookies.Delete(HostSessionIdCookieName, hostOptions);
    }

    private static CookieOptions CreateHostPrefixedDeleteOptions()
        => new()
        {
            HttpOnly = true,
            Secure = true,
            SameSite = SameSiteMode.Strict,
            Path = "/"
        };

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
