using FsusBlog.Server.Infrastructure.Security;

namespace FsusBlog.Server.Infrastructure.Middlewares;

public sealed partial class AnonymousGatewayHeaderGuardMiddleware
{
    public const string RejectedHeaderItemKey = "fsus.gateway.rejected_header";
    public const string RejectionReasonItemKey = "fsus.gateway.rejection_reason";

    private static readonly HashSet<string> s_allowedHeaders = new(StringComparer.OrdinalIgnoreCase)
    {
        "X-Fsus-Access-Token",
        "X-Fsus-Admin-Bootstrap-Token",
        "X-Fsus-Admin-Handle",
        "X-Fsus-Auth-Bridge",
        "X-Fsus-Bearer-Token",
        "X-Fsus-Challenge-Id",
        "X-Fsus-Challenge-Kind",
        "X-Fsus-Challenge-Proof",
        "X-Fsus-Client-Mutation-Id",
        "X-Fsus-Csrf-Token",
        "X-Fsus-Device-Fp",
        "X-Fsus-Local-Audit-Fixture-Secret",
        "X-Fsus-Local-Auth-Fixture-Secret",
        "X-Fsus-Local-Demo-Fixture-Secret",
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

    private static readonly string[] s_allowedPrefixes =
    [
        "X-Fsus-Challenge-",
        "X-Fsus-Notification-Stream-"
    ];

    private static readonly string[] s_forbiddenFragments =
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
            if (reason is null || IsDevelopmentOnlyHeaderAllowed(context, headerName))
            {
                continue;
            }

            context.Items[RejectedHeaderItemKey] = headerName;
            context.Items[RejectionReasonItemKey] = reason;
            LogRejectedGatewayHeader(
                _logger,
                context.TraceIdentifier,
                PrivateAssetRoutePrivacy.RedactPath(context.Request.Path),
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

    private static bool IsDevelopmentOnlyHeaderAllowed(HttpContext context, string headerName)
    {
        DevelopmentOnlyFsusHeaderMetadata? metadata =
            context.GetEndpoint()?.Metadata.GetMetadata<DevelopmentOnlyFsusHeaderMetadata>();
        if (metadata is null || !metadata.Allows(headerName))
        {
            return false;
        }

        IWebHostEnvironment? environment =
            context.RequestServices?.GetService<IWebHostEnvironment>();
        return environment?.IsDevelopment() == true;
    }

    private static string? ResolveRejectionReason(string headerName)
    {
        if (!headerName.StartsWith("X-Fsus-", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        foreach (string fragment in s_forbiddenFragments)
        {
            if (headerName.Contains(fragment, StringComparison.OrdinalIgnoreCase))
            {
                return "traditional_account_header";
            }
        }

        if (s_allowedHeaders.Contains(headerName))
        {
            return null;
        }

        foreach (string prefix in s_allowedPrefixes)
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

public sealed class DevelopmentOnlyFsusHeaderMetadata
{
    private readonly HashSet<string> _headerNames;

    public DevelopmentOnlyFsusHeaderMetadata(params string[] headerNames)
    {
        ArgumentNullException.ThrowIfNull(headerNames);
        if (headerNames.Length == 0
            || headerNames.Any(static headerName =>
                string.IsNullOrWhiteSpace(headerName)
                || !headerName.StartsWith("X-Fsus-", StringComparison.OrdinalIgnoreCase)))
        {
            throw new ArgumentException(
                "Development-only Fsus endpoint metadata requires one or more X-Fsus-* header names.",
                nameof(headerNames));
        }

        _headerNames = new HashSet<string>(
            headerNames,
            StringComparer.OrdinalIgnoreCase);
    }

    public bool Allows(string headerName)
        => _headerNames.Contains(headerName);
}
