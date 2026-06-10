using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Binary;

namespace FsusBlog.Server.Infrastructure.NotificationStream;

internal interface INotificationStreamHandler
{
    Task HandleAsync(HttpContext context, CancellationToken cancellationToken);
}

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
            await envelopePolicy.WriteApiErrorAsync(
                context,
                context.Response.Body,
                ErrorDetail.Create(ErrorCode.Validation, result.ErrorCode ?? "notification_handshake_failed", traceId: context.TraceIdentifier),
                result.StatusCode);
            return;
        }

        await sessionService.RunAsync(context, result.Handshake!, cancellationToken);
    }
}
