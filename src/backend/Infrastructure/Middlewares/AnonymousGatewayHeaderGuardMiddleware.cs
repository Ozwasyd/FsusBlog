namespace FsusBlog.Server.Infrastructure.Middlewares;

public sealed partial class AnonymousGatewayHeaderGuardMiddleware
{
    public const string RejectedHeaderItemKey = "fsus.gateway.rejected_header";
    public const string RejectionReasonItemKey = "fsus.gateway.rejection_reason";

    private static readonly HashSet<string> AllowedHeaders = new(StringComparer.OrdinalIgnoreCase)
    {
        "X-Fsus-Access-Token",
        "X-Fsus-Admin-Bootstrap-Token",
        "X-Fsus-Admin-Handle",
        "X-Fsus-Auth-Bridge",
        "X-Fsus-Bearer-Token",
        "X-Fsus-Challenge-Id",
        "X-Fsus-Challenge-Kind",
        "X-Fsus-Challenge-Proof",
        "X-Fsus-Csrf-Token",
        "X-Fsus-Device-Fp",
        "X-Fsus-Local-Auth-Fixture-Secret",
        "X-Fsus-Mfa-Proof",
        "X-Fsus-Notification-Drill-Nonce",
        "X-Fsus-Notification-Drill-Secret",
        "X-Fsus-Notification-Drill-Signature",
        "X-Fsus-Notification-Drill-Timestamp",
        "X-Fsus-Notification-Stream-Protocol",
        "X-Fsus-Pow-Proof",
        "X-Fsus-Public-Aot-Token",
        "X-Fsus-Region",
        "X-Fsus-Session-Id",
        "X-Fsus-Subscription-Proof",
        "X-Fsus-Test-Session",
        "X-Fsus-Upload-Offset",
        "X-Fsus-Upload-Part",
        "X-Fsus-Upload-Payload-Hash",
        "X-Fsus-Upload-Token"
    };

    private static readonly string[] AllowedPrefixes =
    [
        "X-Fsus-Challenge-",
        "X-Fsus-Notification-Stream-"
    ];

    private static readonly string[] ForbiddenFragments =
    [
        "username",
        "user-name",
        "email",
        "role",
        "account-role",
        "userid",
        "user-id",
        "password",
        "totp",
        "register",
        "login"
    ];

    private readonly RequestDelegate _next;
    private readonly ILogger<AnonymousGatewayHeaderGuardMiddleware> _logger;

    public AnonymousGatewayHeaderGuardMiddleware(
        RequestDelegate next,
        ILogger<AnonymousGatewayHeaderGuardMiddleware> logger)
    {
        _next = next;
        _logger = logger;
    }

    public async Task InvokeAsync(HttpContext context)
    {
        foreach (string headerName in context.Request.Headers.Keys)
        {
            if (!headerName.StartsWith("X-Fsus-", StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            string? reason = ResolveRejectionReason(headerName);
            if (reason is null)
            {
                continue;
            }

            context.Items[RejectedHeaderItemKey] = headerName;
            context.Items[RejectionReasonItemKey] = reason;
            LogRejectedGatewayHeader(
                _logger,
                context.TraceIdentifier,
                context.Request.Path.Value ?? string.Empty,
                headerName,
                reason);
            context.Response.StatusCode = StatusCodes.Status400BadRequest;
            context.Response.ContentType = "application/json; charset=utf-8";
            await context.Response.WriteAsJsonAsync(new
            {
                error = "fsus_gateway_header_rejected",
                message = "FsusBlog only accepts the anonymous profile header allowlist.",
                details = reason,
                traceId = context.TraceIdentifier
            });
            return;
        }

        await _next(context);
    }

    public static bool IsAllowedHeader(string headerName)
        => headerName.StartsWith("X-Fsus-", StringComparison.OrdinalIgnoreCase)
            && ResolveRejectionReason(headerName) is null;

    private static string? ResolveRejectionReason(string headerName)
    {
        if (!headerName.StartsWith("X-Fsus-", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        foreach (string fragment in ForbiddenFragments)
        {
            if (headerName.Contains(fragment, StringComparison.OrdinalIgnoreCase))
            {
                return "traditional_account_header";
            }
        }

        if (AllowedHeaders.Contains(headerName))
        {
            return null;
        }

        foreach (string prefix in AllowedPrefixes)
        {
            if (headerName.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            {
                return null;
            }
        }

        return "unknown_fsus_header";
    }

    [LoggerMessage(
        EventId = 214,
        Level = LogLevel.Warning,
        Message = "Rejected inbound Fsus gateway header | TraceId: {TraceId} | Path: {Path} | Header={HeaderName} | Reason={Reason}")]
    private static partial void LogRejectedGatewayHeader(
        ILogger logger,
        string traceId,
        string path,
        string headerName,
        string reason);
}
