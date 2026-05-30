using System.Security.Claims;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using Microsoft.AspNetCore.Mvc;

namespace FsusBlog.Server.Infrastructure.Sse;

internal interface INotificationStreamHandshakeService
{
    Task<NotificationStreamHandshakeResult> ValidateAsync(
        HttpContext context,
        CancellationToken cancellationToken,
        bool requireWebSocket = true);
}

internal sealed record NotificationStreamHandshake(string Protocol, string? UserId, IReadOnlySet<string> Groups);

internal sealed record NotificationStreamHandshakeResult
{
    private NotificationStreamHandshakeResult(NotificationStreamHandshake? handshake, int statusCode, string? errorCode)
    {
        Handshake = handshake;
        StatusCode = statusCode;
        ErrorCode = errorCode;
    }

    public NotificationStreamHandshake? Handshake { get; }

    public int StatusCode { get; }

    public string? ErrorCode { get; }

    public bool IsSuccess => Handshake is not null;

    public static NotificationStreamHandshakeResult Success(NotificationStreamHandshake handshake) => new(handshake, StatusCodes.Status200OK, null);

    public static NotificationStreamHandshakeResult Failure(int statusCode, string errorCode) => new(null, statusCode, errorCode);
}

internal sealed class NotificationStreamHandshakeService(
    IPowService powService,
    AdaptivePowGovernor powGovernor,
    INotificationStreamAdmissionService admissionService,
    INotificationStreamAudienceResolver audienceResolver,
    ILoggerFactory loggerFactory) : INotificationStreamHandshakeService
{
    private const string Protocol = "fsus-aeds.v2";

    public async Task<NotificationStreamHandshakeResult> ValidateAsync(
        HttpContext context,
        CancellationToken cancellationToken,
        bool requireWebSocket = true)
    {
        if (requireWebSocket && !context.WebSockets.IsWebSocketRequest)
        {
            return NotificationStreamHandshakeResult.Failure(StatusCodes.Status426UpgradeRequired, "websocket_required");
        }

        string requestedProtocol = context.Request.Headers.SecWebSocketProtocol.ToString();
        if (string.IsNullOrWhiteSpace(requestedProtocol))
        {
            requestedProtocol = context.Request.Headers["X-Fsus-Sse-Protocol"].ToString();
        }

        if (!ContainsRequestedProtocol(requestedProtocol))
        {
            return NotificationStreamHandshakeResult.Failure(StatusCodes.Status409Conflict, "protocol_mismatch");
        }

        bool isAuthenticated = context.User.Identity?.IsAuthenticated == true;
        bool hasAuthHeader = context.Request.Headers.ContainsKey("Authorization");
        if (hasAuthHeader && !isAuthenticated)
        {
            return NotificationStreamHandshakeResult.Failure(StatusCodes.Status401Unauthorized, "auth_failed");
        }

        if (!isAuthenticated)
        {
            Microsoft.Extensions.Logging.ILogger powLogger = loggerFactory.CreateLogger("FsusBlog.Sse.Pow");
            IActionResult? powFailure = await PowValidationLogic.ValidateFromQueryAsync(context, powLogger, powService, powGovernor);
            if (powFailure is not null)
            {
                return NotificationStreamHandshakeResult.Failure(ResolveStatusCode(powFailure, StatusCodes.Status401Unauthorized), "pow_failed");
            }
        }

        string? userId = isAuthenticated
            ? context.User.FindFirst(ClaimTypes.NameIdentifier)?.Value
            : null;

        var admission = await admissionService.ValidateAsync(userId, cancellationToken);
        if (!admission.IsAllowed)
        {
            return NotificationStreamHandshakeResult.Failure(admission.StatusCode, admission.ErrorCode ?? "admission_failed");
        }

        IReadOnlySet<string> groups = audienceResolver.ResolveGroups(context.User, userId);
        return NotificationStreamHandshakeResult.Success(new NotificationStreamHandshake(Protocol, userId, groups));
    }

    private static int ResolveStatusCode(IActionResult result, int fallback)
    {
        return result switch
        {
            ObjectResult objectResult when objectResult.StatusCode.HasValue => objectResult.StatusCode.Value,
            StatusCodeResult statusCodeResult => statusCodeResult.StatusCode,
            _ => fallback
        };
    }

    private static bool ContainsRequestedProtocol(string requestedProtocol)
    {
        ReadOnlySpan<char> remaining = requestedProtocol.AsSpan();
        while (!remaining.IsEmpty)
        {
            int comma = remaining.IndexOf(',');
            ReadOnlySpan<char> segment = comma >= 0 ? remaining[..comma] : remaining;
            if (segment.Trim().Equals(Protocol.AsSpan(), StringComparison.Ordinal))
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
