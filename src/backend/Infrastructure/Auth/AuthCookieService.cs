using Microsoft.Extensions.Configuration;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging;
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
    private const string AdminAccessTokenCookieName = "AdminAccessToken";
    private const string AdminSessionIdCookieName = "AdminSessionId";
    private const string HostAdminAccessTokenCookieName = "__Host-AdminAccessToken";
    private const string HostAdminSessionIdCookieName = "__Host-AdminSessionId";
    private readonly bool _allowInsecureTransportCookies;
    private readonly bool _allowLegacyPlainCookieRead;
    private readonly IWebHostEnvironment? _environment;
    private readonly ILogger<AuthCookieService>? _logger;
    private int _legacyPlainCookieWarningWritten;

    public AuthCookieService(
        IConfiguration configuration,
        IWebHostEnvironment? environment = null,
        ILogger<AuthCookieService>? logger = null)
    {
        _allowInsecureTransportCookies = configuration.GetValue<bool>("AuthCookies:AllowInsecureTransportCookies");
        _allowLegacyPlainCookieRead = configuration.GetValue<bool>("AuthCookies:AllowLegacyPlainCookieRead");
        _environment = environment;
        _logger = logger;
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
        => ReadUserCookie(context, AccessTokenCookieName, HostAccessTokenCookieName);

    public string? ReadRefreshToken(HttpContext context)
        => ReadUserCookie(context, RefreshTokenCookieName, HostRefreshTokenCookieName);

    public string? ReadSessionId(HttpContext context)
        => ReadUserCookie(context, SessionIdCookieName, HostSessionIdCookieName);

    public bool TryReadAdminAccessToken(HttpContext context, out string token)
    {
        token = ReadCookie(context, AdminAccessTokenCookieName, HostAdminAccessTokenCookieName, ShouldAllowLegacyPlainCookieRead()) ?? string.Empty;
        return !string.IsNullOrWhiteSpace(token);
    }

    public static string? ResolveAccessTokenCookieName(bool isProduction)
        => isProduction ? HostAccessTokenCookieName : AccessTokenCookieName;

    private string? ReadUserCookie(HttpContext context, string plainName, string hostName)
        => ReadCookie(context, plainName, hostName, ShouldAllowLegacyPlainCookieRead());

    private bool ShouldAllowLegacyPlainCookieRead()
    {
        if (!_allowLegacyPlainCookieRead)
        {
            return false;
        }

        bool isLocalCompatibleEnvironment = _environment?.IsDevelopment() == true;
        if (!isLocalCompatibleEnvironment)
        {
            return false;
        }

        if (Interlocked.Exchange(ref _legacyPlainCookieWarningWritten, 1) == 0)
        {
            _logger?.LogWarning(
                "AuthCookies:AllowLegacyPlainCookieRead is enabled for {EnvironmentName}; legacy plain user cookies are accepted for local migration only and must remain disabled in production.",
                _environment?.EnvironmentName ?? "Unknown");
        }

        return true;
    }

    private static string? ReadCookie(HttpContext context, string plainName, string hostName, bool allowPlainFallback)
    {
        if (context.Request.Cookies.TryGetValue(hostName, out var hostValue) && !string.IsNullOrWhiteSpace(hostValue))
        {
            return hostValue;
        }

        if (allowPlainFallback &&
            context.Request.Cookies.TryGetValue(plainName, out var plainValue) &&
            !string.IsNullOrWhiteSpace(plainValue))
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
