using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Interfaces;
using FsusBlog.Shared.Contracts.NotificationStream;

namespace FsusBlog.Server.Services.NotificationStream;

internal sealed class RedisNotificationStreamPublisher(
    NotificationStreamBacklogStore backlogStore,
    NotificationStreamLocalFanoutQueue localFanoutQueue,
    INotificationFrameCodec frameCodec,
    ILogger<RedisNotificationStreamPublisher> logger) : INotificationStreamPublisher
{
    public async Task<Result<NotificationStreamCursor>> PublishAsync<TPayload>(
        NotificationStreamEventType eventType,
        TPayload payload,
        NotificationStreamTarget target,
        CancellationToken cancellationToken = default,
        string? idempotencyKey = null)
    {
        cancellationToken.ThrowIfCancellationRequested();

        long eventId;
        try
        {
            eventId = await backlogStore.GetOrCreateEventIdAsync(idempotencyKey, cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to allocate notification stream event id. Type: {EventType}", eventType);
            return Result<NotificationStreamCursor>.Failure(ErrorCode.InfraFailure, "Notification stream event id allocation failed");
        }
        SharedNotificationStreamFrame frame = frameCodec.EncodeEventFrame(eventId, eventType, payload);

        try
        {
            var routeResult = NotificationStreamTargetRouteCodec.TryEncode(target);
            if (routeResult.IsFailure || string.IsNullOrWhiteSpace(routeResult.Value))
            {
                return Result<NotificationStreamCursor>.Failure(routeResult.IsFailure ? routeResult.Error : ErrorDetail.Create(ErrorCode.Validation, "Unsupported notification stream target."));
            }

            string route = routeResult.Value;
            Result<NotificationStreamAppendResult> appendResult = await backlogStore.AppendAsync(
                    eventId,
                    route,
                    frame,
                    cancellationToken,
                    idempotent: !string.IsNullOrWhiteSpace(idempotencyKey))
                .ConfigureAwait(false);
            if (appendResult.IsFailure)
            {
                return Result<NotificationStreamCursor>.Failure(appendResult.Error);
            }

            if (appendResult.Value is { Appended: true } && !localFanoutQueue.TryEnqueue(frame, target))
            {
                logger.LogWarning("notification-stream-local-fanout-enqueue-dropped {EventType} {EventId} {DroppedCount}",
                    eventType,
                    eventId,
                    localFanoutQueue.DroppedCount);
            }
            return Result<NotificationStreamCursor>.Success(new NotificationStreamCursor(eventId));
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to publish notification stream event. Type: {EventType} | EventId: {EventId}", eventType, eventId);
            return Result<NotificationStreamCursor>.Failure(ErrorCode.InfraFailure, "Notification stream publish failed");
        }
        finally
        {
            frame.Release();
        }
    }
}
