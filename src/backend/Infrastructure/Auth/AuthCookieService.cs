using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;

namespace FsusBlog.Server.Infrastructure.Auth;

/// <summary>Issues, reads, and revokes user and administrator authentication cookies with environment-safe attributes.</summary>
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
    private const string EnrollmentTokenCookieName = "EnrollmentToken";
    private const string HostEnrollmentTokenCookieName = "__Host-EnrollmentToken";
    private readonly bool _allowInsecureTransportCookies;
    private readonly string _accessTokenCookieName;
    private readonly string _refreshTokenCookieName;
    private readonly string _sessionIdCookieName;
    private readonly string _adminAccessTokenCookieName;

    /// <summary>Selects host-prefixed secure cookie names unless explicitly running an allowed development transport.</summary>
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

    /// <summary>Writes the user access, refresh, and optional session cookies with their independent expiry boundaries.</summary>
    public void SetTokenCookies(
        HttpContext context,
        IWebHostEnvironment env,
        string accessToken,
        DateTimeOffset accessTokenExpiresAtUtc,
        string refreshToken,
        string? sessionId,
        DateTime idleExpiresAt,
        bool persistent = true)
    {
        CookieOptions baseOptions = CreateBaseOptions(env);
        bool useSecureTransportCookies = baseOptions.Secure;

        string accessCookieName = useSecureTransportCookies ? HostAccessTokenCookieName : AccessTokenCookieName;
        string refreshCookieName = useSecureTransportCookies ? HostRefreshTokenCookieName : RefreshTokenCookieName;
        string sessionCookieName = useSecureTransportCookies ? HostSessionIdCookieName : SessionIdCookieName;

        AppendAccessTokenCookie(context, accessCookieName, accessToken, accessTokenExpiresAtUtc, baseOptions, persistent);

        CookieOptions refreshOptions = new(baseOptions);
        if (persistent)
        {
            refreshOptions.Expires = idleExpiresAt;
        }
        context.Response.Cookies.Append(refreshCookieName, refreshToken, refreshOptions);

        if (!string.IsNullOrWhiteSpace(sessionId))
        {
            CookieOptions sessionOptions = new(baseOptions);
            if (persistent)
            {
                sessionOptions.Expires = idleExpiresAt;
            }
            context.Response.Cookies.Append(sessionCookieName, sessionId, sessionOptions);
        }
    }

    /// <summary>Replaces only the short-lived user access-token cookie after token refresh.</summary>
    public void SetAccessTokenCookie(
        HttpContext context,
        IWebHostEnvironment env,
        string accessToken,
        DateTimeOffset accessTokenExpiresAtUtc)
    {
        CookieOptions baseOptions = CreateBaseOptions(env);
        string accessCookieName = baseOptions.Secure ? HostAccessTokenCookieName : AccessTokenCookieName;
        AppendAccessTokenCookie(context, accessCookieName, accessToken, accessTokenExpiresAtUtc, baseOptions);
    }

    /// <summary>Writes the administrator access-token and session cookies using the stricter admin namespace.</summary>
    public void SetAdminSessionCookies(
        HttpContext context,
        IWebHostEnvironment env,
        string accessToken,
        DateTimeOffset accessTokenExpiresAtUtc,
        string sessionId,
        DateTime idleExpiresAt)
    {
        CookieOptions baseOptions = CreateBaseOptions(env);
        string accessCookieName = baseOptions.Secure ? HostAdminAccessTokenCookieName : AdminAccessTokenCookieName;
        string sessionCookieName = baseOptions.Secure ? HostAdminSessionIdCookieName : AdminSessionIdCookieName;

        AppendAccessTokenCookie(context, accessCookieName, accessToken, accessTokenExpiresAtUtc, baseOptions);
        context.Response.Cookies.Append(sessionCookieName, sessionId, new CookieOptions(baseOptions)
        {
            Expires = idleExpiresAt
        });
    }

    /// <summary>Writes the short-lived token that is valid only on enrollment endpoints.</summary>
    public void SetEnrollmentCookie(HttpContext context, IWebHostEnvironment env, string token, DateTime expiresAt)
    {
        CookieOptions baseOptions = CreateBaseOptions(env);
        context.Response.Cookies.Append(
            baseOptions.Secure ? HostEnrollmentTokenCookieName : EnrollmentTokenCookieName,
            token,
            new CookieOptions(baseOptions) { Expires = expiresAt, Path = "/api/binary/auth/enrollment" });
    }

    /// <summary>Reads the enrollment-only token from the secure or compatibility cookie name.</summary>
    public string? ReadEnrollmentToken(HttpContext context)
        => ReadCookie(context, ShouldUseSecureTransportCookies(null) ? HostEnrollmentTokenCookieName : EnrollmentTokenCookieName)
            ?? ReadCookie(context, EnrollmentTokenCookieName);

    /// <summary>Clears both enrollment cookie names after completion or rejection.</summary>
    public void ClearEnrollmentCookie(HttpContext context)
    {
        context.Response.Cookies.Delete(EnrollmentTokenCookieName, new CookieOptions { Path = "/api/binary/auth/enrollment" });
        context.Response.Cookies.Delete(HostEnrollmentTokenCookieName, new CookieOptions
        {
            HttpOnly = true,
            Secure = true,
            SameSite = SameSiteMode.Strict,
            Path = "/api/binary/auth/enrollment"
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

    private static void AppendAccessTokenCookie(
        HttpContext context,
        string cookieName,
        string accessToken,
        DateTimeOffset accessTokenExpiresAtUtc,
        CookieOptions baseOptions,
        bool persistent = true)
    {
        CookieOptions options = new(baseOptions);
        if (persistent)
        {
            options.Expires = accessTokenExpiresAtUtc.ToUniversalTime();
        }
        context.Response.Cookies.Append(cookieName, accessToken, options);
    }

    /// <summary>Deletes every supported user and administrator authentication cookie variant.</summary>
    public void ClearTokenCookies(HttpContext context)
    {
        ClearUserSessionCookies(context);
        ClearAdminSessionCookies(context);
    }

    /// <summary>Deletes legacy and host-prefixed user access, refresh, and session cookies.</summary>
    public void ClearUserSessionCookies(HttpContext context)
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

    /// <summary>Deletes legacy and host-prefixed administrator access and session cookies.</summary>
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

    /// <summary>Reads the access token from the cookie name selected for the current environment.</summary>
    public string? ReadAccessToken(HttpContext context)
        => ReadCookie(context, _accessTokenCookieName);

    /// <summary>Reads the refresh token from the cookie name selected for the current environment.</summary>
    public string? ReadRefreshToken(HttpContext context)
        => ReadCookie(context, _refreshTokenCookieName);

    /// <summary>Reads the user session identifier from the cookie name selected for the current environment.</summary>
    public string? ReadSessionId(HttpContext context)
        => ReadCookie(context, _sessionIdCookieName);

    /// <summary>Attempts to read a non-empty administrator access token from the active cookie namespace.</summary>
    public bool TryReadAdminAccessToken(HttpContext context, out string token)
    {
        token = ReadCookie(context, _adminAccessTokenCookieName) ?? string.Empty;
        return !string.IsNullOrWhiteSpace(token);
    }

    /// <summary>Returns the externally visible access-token cookie name for production or development transport.</summary>
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
