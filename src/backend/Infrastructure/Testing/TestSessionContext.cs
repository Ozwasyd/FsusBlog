using System.Text.RegularExpressions;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers;

namespace FsusBlog.Server.Infrastructure.Testing;

public interface ITestSessionContext
{
    bool IsActive
    {
        get;
    }
    string? SessionId
    {
        get;
    }
    string? SchemaName
    {
        get;
    }
    string PrefixKey(string key);
}

public interface ITestSessionKeyScope
{
    string? SessionId
    {
        get;
    }
    string PrefixKey(string key);
    IDisposable BeginScope(string? sessionId);
}

public sealed class TestSessionContext(ITestSessionKeyScope keyScope) : ITestSessionContext
{
    public bool IsActive => SessionId is not null;
    public string? SessionId => keyScope.SessionId;
    public string? SchemaName => SessionId is { } session ? $"fsus_e2e_{session.Replace('-', '_')}" : null;
    public string PrefixKey(string key) => keyScope.PrefixKey(key);
}

public sealed class TestAwareRuntimeKeyScope(ITestSessionKeyScope keyScope) : IRuntimeKeyScope
{
    public string ScopeToken => keyScope.SessionId ?? string.Empty;
    public string PrefixKey(string key) => keyScope.PrefixKey(key);
}

public sealed partial class HttpTestSessionKeyScope(IHttpContextAccessor httpContextAccessor, IWebHostEnvironment environment) : ITestSessionKeyScope
{
    public const string HeaderName = "X-Fsus-Test-Session";
    private static readonly AsyncLocal<string?> ExplicitSessionId = new();

    public string? SessionId
    {
        get
        {
            if (!IsIsolationEnabled(environment))
            {
                return null;
            }

            if (NormalizeSessionId(ExplicitSessionId.Value) is { } explicitSession)
            {
                return explicitSession;
            }

            string? raw = httpContextAccessor.HttpContext?.Request.Headers[HeaderName].FirstOrDefault();
            return NormalizeSessionId(raw);
        }
    }

    public string PrefixKey(string key)
    {
        return SessionId is { } session ? $"e2e:{session}:{key}" : key;
    }

    public IDisposable BeginScope(string? sessionId)
    {
        string? previous = ExplicitSessionId.Value;
        ExplicitSessionId.Value = NormalizeSessionId(sessionId);
        return new ExplicitSessionScope(previous);
    }

    private static string? NormalizeSessionId(string? raw)
    {
        if (string.IsNullOrWhiteSpace(raw))
        {
            return null;
        }

        string normalized = TextHelpers.LowerTrimmed(raw) ?? string.Empty;
        return SessionIdPattern().IsMatch(normalized) ? normalized : null;
    }

    public static bool IsIsolationEnabled(IWebHostEnvironment environment)
    {
        return string.Equals(Environment.GetEnvironmentVariable("FSUSBLOG_TEST_SESSION_ISOLATION"), "1", StringComparison.Ordinal)
            || environment.IsDevelopment()
            || string.Equals(environment.EnvironmentName, "Test", StringComparison.OrdinalIgnoreCase);
    }

    public static bool IsValidSessionId(string value) => SessionIdPattern().IsMatch(value);

    [GeneratedRegex("^[a-z0-9][a-z0-9-]{0,40}$", RegexOptions.CultureInvariant)]
    private static partial Regex SessionIdPattern();

    private sealed class ExplicitSessionScope(string? previous) : IDisposable
    {
        public void Dispose()
        {
            ExplicitSessionId.Value = previous;
        }
    }
}

public sealed class TestSessionValidationMiddleware(RequestDelegate next, IWebHostEnvironment environment)
{
    private const string NotificationStreamPath = "/api/notifications/stream";
    private const string NotificationStreamPreflightPath = "/api/notifications/stream/preflight";
    private const string NotificationStreamTestSessionCookieName = "FsusTestSession";

    public async Task InvokeAsync(HttpContext context)
    {
        if (!HttpTestSessionKeyScope.IsIsolationEnabled(environment))
        {
            await next(context);
            return;
        }

        bool isNotificationStream = string.Equals(context.Request.Path.Value, NotificationStreamPath, StringComparison.OrdinalIgnoreCase);
        bool isNotificationStreamPreflight = string.Equals(context.Request.Path.Value, NotificationStreamPreflightPath, StringComparison.OrdinalIgnoreCase);
        string? rawSession = context.Request.Headers[HttpTestSessionKeyScope.HeaderName].FirstOrDefault();
        if (string.IsNullOrWhiteSpace(rawSession) && (isNotificationStream || isNotificationStreamPreflight))
        {
            rawSession = context.Request.Cookies[NotificationStreamTestSessionCookieName];
            if (!string.IsNullOrWhiteSpace(rawSession))
            {
                context.Request.Headers[HttpTestSessionKeyScope.HeaderName] = rawSession;
            }
        }

        if (string.IsNullOrWhiteSpace(rawSession))
        {
            await next(context);
            return;
        }

        string session = TextHelpers.LowerTrimmed(rawSession) ?? string.Empty;
        if (!HttpTestSessionKeyScope.IsValidSessionId(session))
        {
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            await context.Response.WriteAsync("invalid test session id", context.RequestAborted);
            return;
        }

        context.Request.Headers[HttpTestSessionKeyScope.HeaderName] = session;
        if (isNotificationStreamPreflight)
        {
            context.Response.Cookies.Append(NotificationStreamTestSessionCookieName, session, new CookieOptions
            {
                HttpOnly = true,
                Secure = context.Request.IsHttps,
                SameSite = SameSiteMode.Strict,
                Path = NotificationStreamPath,
                IsEssential = true
            });
        }

        context.Response.Headers["Vary"] = HttpTestSessionKeyScope.HeaderName;
        await next(context);
    }
}
