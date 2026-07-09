using Microsoft.Extensions.Configuration;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;

namespace FsusBlog.Server.Infrastructure.Auth;

public sealed class AuthCookieService
{
    private const string AccessTokenCookieName = "AccessToken";
    private const string RefreshTokenCookieName = "RefreshToken";
    private const string SessionIdCookieName = "SessionId";
    private const string HostAccessTokenCookieName = "__Host-AccessToken";
    private const string HostRefreshTokenCookieName = "__Host-RefreshToken";
    private const string HostSessionIdCookieName = "__Host-SessionId";
    private const string AdminAccessTokenCookieName = "AdminAccessToken";
    private const string AdminSessionIdCookieName = "AdminSessionId";
    private const string HostAdminAccessTokenCookieName = "__Host-AdminAccessToken";
    private const string HostAdminSessionIdCookieName = "__Host-AdminSessionId";
    private readonly bool _allowInsecureTransportCookies;
    private readonly string _accessTokenCookieName;
    private readonly string _refreshTokenCookieName;
    private readonly string _sessionIdCookieName;
    private readonly string _adminAccessTokenCookieName;

    public AuthCookieService(
        IConfiguration configuration,
        IWebHostEnvironment? environment = null,
        ILogger<AuthCookieService>? logger = null)
    {
        _allowInsecureTransportCookies = configuration.GetValue<bool>("AuthCookies:AllowInsecureTransportCookies");
        bool useSecureTransportCookies = ShouldUseSecureTransportCookies(environment);
        _accessTokenCookieName = useSecureTransportCookies ? HostAccessTokenCookieName : AccessTokenCookieName;
        _refreshTokenCookieName = useSecureTransportCookies ? HostRefreshTokenCookieName : RefreshTokenCookieName;
        _sessionIdCookieName = useSecureTransportCookies ? HostSessionIdCookieName : SessionIdCookieName;
        _adminAccessTokenCookieName = useSecureTransportCookies ? HostAdminAccessTokenCookieName : AdminAccessTokenCookieName;
    }

    public void SetTokenCookies(HttpContext context, IWebHostEnvironment env, string accessToken, string refreshToken, string? sessionId, DateTime idleExpiresAt)
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

    public void SetAdminSessionCookies(HttpContext context, IWebHostEnvironment env, string accessToken, string sessionId, DateTime idleExpiresAt)
    {
        CookieOptions baseOptions = CreateBaseOptions(env);
        string accessCookieName = baseOptions.Secure ? HostAdminAccessTokenCookieName : AdminAccessTokenCookieName;
        string sessionCookieName = baseOptions.Secure ? HostAdminSessionIdCookieName : AdminSessionIdCookieName;

        AppendAccessTokenCookie(context, accessCookieName, accessToken, baseOptions);
        context.Response.Cookies.Append(sessionCookieName, sessionId, new CookieOptions(baseOptions)
        {
            Expires = idleExpiresAt
        });
    }

    private CookieOptions CreateBaseOptions(IWebHostEnvironment env)
    {
        bool secure = ShouldUseSecureTransportCookies(env);
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

        ClearAdminSessionCookies(context);
    }

    public void ClearAdminSessionCookies(HttpContext context)
    {
        var options = new CookieOptions { Path = "/" };
        context.Response.Cookies.Delete(AdminAccessTokenCookieName, options);
        context.Response.Cookies.Delete(AdminSessionIdCookieName, options);

        CookieOptions hostOptions = CreateHostPrefixedDeleteOptions();
        context.Response.Cookies.Delete(HostAdminAccessTokenCookieName, hostOptions);
        context.Response.Cookies.Delete(HostAdminSessionIdCookieName, hostOptions);
    }

    private static CookieOptions CreateHostPrefixedDeleteOptions()
        => new()
        {
            HttpOnly = true,
            Secure = true,
            SameSite = SameSiteMode.Strict,
            Path = "/"
        };

    public string? ReadAccessToken(HttpContext context)
        => ReadCookie(context, _accessTokenCookieName);

    public string? ReadRefreshToken(HttpContext context)
        => ReadCookie(context, _refreshTokenCookieName);

    public string? ReadSessionId(HttpContext context)
        => ReadCookie(context, _sessionIdCookieName);

    public bool TryReadAdminAccessToken(HttpContext context, out string token)
    {
        token = ReadCookie(context, _adminAccessTokenCookieName) ?? string.Empty;
        return !string.IsNullOrWhiteSpace(token);
    }

    public static string? ResolveAccessTokenCookieName(bool isProduction)
        => isProduction ? HostAccessTokenCookieName : AccessTokenCookieName;

    private bool ShouldUseSecureTransportCookies(IWebHostEnvironment? env)
        => env is null || !env.IsDevelopment() || !_allowInsecureTransportCookies;

    private static string? ReadCookie(HttpContext context, string cookieName)
    {
        if (context.Request.Cookies.TryGetValue(cookieName, out var hostValue) && !string.IsNullOrWhiteSpace(hostValue))
        {
            return hostValue;
        }

        return null;
    }

}
