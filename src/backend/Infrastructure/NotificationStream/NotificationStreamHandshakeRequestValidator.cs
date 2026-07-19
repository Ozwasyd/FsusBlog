using System.Diagnostics;

using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Operations;

namespace FsusBlog.Server.Infrastructure.NotificationStream;

internal interface INotificationStreamHandshakeRequestValidator
{
    NotificationStreamHandshakeRequestValidation Validate(HttpContext context, bool requireWebSocket);
}

internal readonly record struct NotificationStreamHandshakeRequestValidation(
    bool IsAllowed,
    bool IsAuthenticated,
    int StatusCode,
    string? ErrorCode)
{
    public static NotificationStreamHandshakeRequestValidation Allowed(bool isAuthenticated)
        => new(true, isAuthenticated, StatusCodes.Status200OK, null);

    public static NotificationStreamHandshakeRequestValidation Rejected(int statusCode, string errorCode)
        => new(false, false, statusCode, errorCode);
}

internal sealed class NotificationStreamHandshakeRequestValidator(
    NotificationStreamOriginSnapshotProvider originSnapshotProvider,
    IWebHostEnvironment environment,
    DeploymentRuntimeState? deploymentRuntime = null) : INotificationStreamHandshakeRequestValidator
{
    public NotificationStreamHandshakeRequestValidation Validate(HttpContext context, bool requireWebSocket)
    {
        if (deploymentRuntime is not null && !deploymentRuntime.CanAcceptNotificationStream)
        {
            return NotificationStreamHandshakeRequestValidation.Rejected(
                StatusCodes.Status503ServiceUnavailable,
                deploymentRuntime.IsDraining ? "deployment_draining" : "deployment_not_active");
        }

        if (requireWebSocket && !context.WebSockets.IsWebSocketRequest)
        {
            return NotificationStreamHandshakeRequestValidation.Rejected(
                StatusCodes.Status426UpgradeRequired,
                "websocket_required");
        }

        NotificationStreamHandshakeRequestValidation? originFailure = ValidateOrigin(context);
        if (originFailure is not null)
        {
            return originFailure.Value;
        }

        string requestedProtocol = context.Request.Headers.SecWebSocketProtocol.ToString();
        if (string.IsNullOrWhiteSpace(requestedProtocol))
        {
            requestedProtocol = context.Request.Headers["X-Fsus-Notification-Stream-Protocol"].ToString();
        }

        if (!ContainsRequestedProtocol(requestedProtocol))
        {
            return NotificationStreamHandshakeRequestValidation.Rejected(
                StatusCodes.Status409Conflict,
                "protocol_mismatch");
        }

        bool isAuthenticated = context.User.Identity?.IsAuthenticated == true;
        if (context.Request.Headers.ContainsKey("Authorization") && !isAuthenticated)
        {
            return NotificationStreamHandshakeRequestValidation.Rejected(
                StatusCodes.Status401Unauthorized,
                "auth_failed");
        }

        return NotificationStreamHandshakeRequestValidation.Allowed(isAuthenticated);
    }

    private NotificationStreamHandshakeRequestValidation? ValidateOrigin(HttpContext context)
    {
        long started = Stopwatch.GetTimestamp();
        string originHeader = context.Request.Headers.Origin.ToString();
        if (string.IsNullOrWhiteSpace(originHeader))
        {
            return environment.IsProduction() && !IsInternalProbe(context)
                ? NotificationStreamHandshakeRequestValidation.Rejected(StatusCodes.Status403Forbidden, "origin_not_allowed")
                : null;
        }

        if (!Uri.TryCreate(originHeader, UriKind.Absolute, out Uri? origin))
        {
            return NotificationStreamHandshakeRequestValidation.Rejected(StatusCodes.Status403Forbidden, "origin_not_allowed");
        }

        if (IsDevelopmentLocalhostOrigin(origin))
        {
            return null;
        }

        if (environment.IsProduction() && !IsProductionSafeOriginScheme(origin.Scheme))
        {
            return NotificationStreamHandshakeRequestValidation.Rejected(StatusCodes.Status403Forbidden, "origin_not_allowed");
        }

        NotificationStreamOriginSnapshot originSnapshot = originSnapshotProvider.Current;
        string normalizedOrigin = NormalizeOrigin(origin);
        if (!originSnapshot.AllowedOrigins.Contains(normalizedOrigin))
        {
            FsusObservability.RecordNotificationStreamOriginValidation("origin", false, Stopwatch.GetElapsedTime(started));
            return NotificationStreamHandshakeRequestValidation.Rejected(StatusCodes.Status403Forbidden, "origin_not_allowed");
        }

        if (!originSnapshot.AllowedHosts.Contains(origin.Host))
        {
            FsusObservability.RecordNotificationStreamOriginValidation("host", false, Stopwatch.GetElapsedTime(started));
            return NotificationStreamHandshakeRequestValidation.Rejected(StatusCodes.Status403Forbidden, "origin_not_allowed");
        }

        FsusObservability.RecordNotificationStreamOriginValidation("origin", true, Stopwatch.GetElapsedTime(started));
        return null;
    }

    internal static HashSet<string> BuildAllowedOrigins(IConfiguration configuration)
    {
        var allowed = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        AddOrigin(allowed, configuration["Seo:BaseUrl"]);
        AddOriginList(allowed, configuration["CORS_ALLOWED_HOSTS"]);
        AddOriginList(allowed, configuration["Fido2:Origins"]);
        foreach (IConfigurationSection child in configuration.GetSection("Fido2:Origins").GetChildren())
        {
            AddOrigin(allowed, child.Value);
        }

        return allowed;
    }

    internal static HashSet<string> BuildAllowedHosts(IConfiguration configuration, HashSet<string> allowedOrigins)
    {
        var hosts = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (string origin in allowedOrigins)
        {
            if (Uri.TryCreate(origin, UriKind.Absolute, out Uri? uri))
            {
                hosts.Add(uri.Host);
            }
        }

        string? configuredHosts = configuration["AllowedHosts"];
        if (!string.IsNullOrWhiteSpace(configuredHosts))
        {
            foreach (string host in configuredHosts.Split([';', ','], StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                if (host != "*")
                {
                    hosts.Add(host);
                }
            }
        }

        return hosts;
    }

    private static void AddOriginList(HashSet<string> allowed, string? origins)
    {
        if (string.IsNullOrWhiteSpace(origins))
        {
            return;
        }

        foreach (string origin in origins.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            AddOrigin(allowed, origin);
        }
    }

    private static void AddOrigin(HashSet<string> allowed, string? origin)
    {
        if (!string.IsNullOrWhiteSpace(origin) && Uri.TryCreate(origin, UriKind.Absolute, out Uri? uri))
        {
            allowed.Add(NormalizeOrigin(uri));
        }
    }

    private bool IsDevelopmentLocalhostOrigin(Uri origin)
        => environment.IsDevelopment()
            && IsLocalhost(origin.Host)
            && (origin.Scheme == Uri.UriSchemeHttp
                || origin.Scheme == Uri.UriSchemeHttps
                || origin.Scheme.Equals("ws", StringComparison.OrdinalIgnoreCase)
                || origin.Scheme.Equals("wss", StringComparison.OrdinalIgnoreCase));

    private static bool IsProductionSafeOriginScheme(string scheme)
        => scheme == Uri.UriSchemeHttps || scheme.Equals("wss", StringComparison.OrdinalIgnoreCase);

    private static bool IsInternalProbe(HttpContext context)
    {
        if (context.Request.Headers.ContainsKey("Sec-Fetch-Site"))
        {
            return false;
        }

        string userAgent = context.Request.Headers.UserAgent.ToString();
        if (userAgent.Contains("Mozilla", StringComparison.OrdinalIgnoreCase))
        {
            return false;
        }

        return context.Connection.RemoteIpAddress is null
            || System.Net.IPAddress.IsLoopback(context.Connection.RemoteIpAddress);
    }

    private static bool IsLocalhost(string host)
        => host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
            || host.Equals("127.0.0.1", StringComparison.OrdinalIgnoreCase)
            || host.Equals("::1", StringComparison.OrdinalIgnoreCase);

    private static string NormalizeOrigin(Uri origin)
    {
        string scheme = origin.Scheme.Equals("wss", StringComparison.OrdinalIgnoreCase)
            ? Uri.UriSchemeHttps
            : origin.Scheme.Equals("ws", StringComparison.OrdinalIgnoreCase)
                ? Uri.UriSchemeHttp
                : origin.Scheme.ToLowerInvariant();
        string port = origin.IsDefaultPort ? string.Empty : $":{origin.Port}";
        return $"{scheme}://{origin.IdnHost.ToLowerInvariant()}{port}";
    }

    private static bool ContainsRequestedProtocol(string requestedProtocol)
    {
        ReadOnlySpan<char> remaining = requestedProtocol.AsSpan();
        while (!remaining.IsEmpty)
        {
            int comma = remaining.IndexOf(',');
            ReadOnlySpan<char> segment = comma >= 0 ? remaining[..comma] : remaining;
            if (segment.Trim().Equals(NotificationStreamHandshakeProtocol.Value.AsSpan(), StringComparison.Ordinal))
            {
                return true;
            }

            if (comma < 0)
            {
                break;
            }

            remaining = remaining[(comma + 1)..];
        }

        return false;
    }
}
