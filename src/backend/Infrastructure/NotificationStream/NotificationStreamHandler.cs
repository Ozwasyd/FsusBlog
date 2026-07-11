using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Binary;

namespace FsusBlog.Server.Infrastructure.NotificationStream;

internal interface INotificationStreamHandler
{
    Task HandleAsync(HttpContext context, CancellationToken cancellationToken);
}

// Design reference: docs/api/design.md "通知通道设计约定".
internal sealed class NotificationStreamHandler(
    INotificationStreamHandshakeService handshakeService,
    INotificationStreamSessionService sessionService,
    IBinaryEnvelopePolicy envelopePolicy) : INotificationStreamHandler
{
    public async Task HandleAsync(HttpContext context, CancellationToken cancellationToken)
    {
        NotificationStreamHandshakeResult result = await handshakeService.ValidateAsync(context, cancellationToken);
        if (!result.IsSuccess)
        {
            NotificationStreamMetrics.RecordHandshakeFailure(result.ErrorCode ?? "unknown");
            context.Response.Headers["X-Fsus-Notification-Stream-Error-Code"] = result.ErrorCode ?? "notification_handshake_failed";
            context.Response.Headers["X-Fsus-Notification-Stream-Status-Code"] = result.StatusCode.ToString(System.Globalization.CultureInfo.InvariantCulture);
            if (result.StatusCode == StatusCodes.Status503ServiceUnavailable)
            {
                context.Response.Headers["Retry-After"] = "5";
            }
            await envelopePolicy.WriteApiErrorAsync(
                context,
                context.Response.Body,
                ErrorDetail.Create(ErrorCode.Validation, result.ErrorCode ?? "notification_handshake_failed", traceId: context.TraceIdentifier),
                result.StatusCode);
            return;
        }

        try
        {
            await sessionService.RunAsync(context, result.Handshake!, cancellationToken);
        }
        catch (NotificationStreamConnectionLimitExceededException ex)
        {
            NotificationStreamMetrics.RecordHandshakeFailure("notification_connection_limit");
            context.Response.Headers["Retry-After"] = "60";
            context.Response.Headers["X-Fsus-Notification-Stream-Error-Code"] = "notification_connection_limit";
            context.Response.Headers["X-Fsus-Notification-Stream-Status-Code"] = StatusCodes.Status429TooManyRequests.ToString(System.Globalization.CultureInfo.InvariantCulture);
            context.Response.Headers["X-Fsus-Notification-Stream-Limit-Scope"] = ex.Scope.ToString();
            await envelopePolicy.WriteApiErrorAsync(
                context,
                context.Response.Body,
                ErrorDetail.Create(ErrorCode.Validation, "notification_connection_limit", traceId: context.TraceIdentifier),
                StatusCodes.Status429TooManyRequests);
        }
        catch (NotificationStreamDeploymentUnavailableException ex)
        {
            NotificationStreamMetrics.RecordHandshakeFailure(ex.ErrorCode);
            context.Response.Headers["Retry-After"] = "5";
            context.Response.Headers["X-Fsus-Notification-Stream-Error-Code"] = ex.ErrorCode;
            context.Response.Headers["X-Fsus-Notification-Stream-Status-Code"] = StatusCodes.Status503ServiceUnavailable.ToString(System.Globalization.CultureInfo.InvariantCulture);
            await envelopePolicy.WriteApiErrorAsync(
                context,
                context.Response.Body,
                ErrorDetail.Create(ErrorCode.Validation, ex.ErrorCode, traceId: context.TraceIdentifier),
                StatusCodes.Status503ServiceUnavailable);
        }
    }
}
