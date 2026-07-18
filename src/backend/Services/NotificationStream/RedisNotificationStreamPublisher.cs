using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Interfaces;
using FsusBlog.Shared.Contracts.NotificationStream;

using StackExchange.Redis;

namespace FsusBlog.Server.Services.NotificationStream;

internal sealed class RedisNotificationStreamPublisher(
    NotificationStreamBacklogStore backlogStore,
    NotificationStreamLocalFanoutQueue localFanoutQueue,
    INotificationFrameCodec frameCodec,
    ILogger<RedisNotificationStreamPublisher> logger) : INotificationStreamPublisher
{
    private readonly SemaphoreSlim _publishGate = new(1, 1);

    public async Task<Result<NotificationStreamCursor>> PublishAsync<TPayload>(
        NotificationStreamEventType eventType,
        TPayload payload,
        NotificationStreamTarget target,
        CancellationToken cancellationToken = default,
        string? idempotencyKey = null)
    {
        cancellationToken.ThrowIfCancellationRequested();

        var routeResult = NotificationStreamTargetRouteCodec.TryEncode(target);
        if (routeResult.IsFailure || string.IsNullOrWhiteSpace(routeResult.Value))
        {
            return Result<NotificationStreamCursor>.Failure(
                routeResult.IsFailure
                    ? routeResult.Error
                    : ErrorDetail.Create(ErrorCode.Validation, "Unsupported notification stream target."));
        }

        await _publishGate.WaitAsync(cancellationToken).ConfigureAwait(false);
        RedisValue publishOrderLock = RedisValue.Null;
        SharedNotificationStreamFrame? frame = null;
        long eventId = 0;
        try
        {
            publishOrderLock = await backlogStore.AcquirePublishOrderLockAsync(cancellationToken).ConfigureAwait(false);
            eventId = await backlogStore.GetOrCreateEventIdAsync(idempotencyKey, cancellationToken).ConfigureAwait(false);
            frame = frameCodec.EncodeEventFrame(eventId, eventType, payload);

            string route = routeResult.Value!;
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
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            throw;
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to publish notification stream event. Type: {EventType} | EventId: {EventId}", eventType, eventId);
            return Result<NotificationStreamCursor>.Failure(ErrorCode.InfraFailure, "Notification stream publish failed");
        }
        finally
        {
            frame?.Release();
            if (!publishOrderLock.IsNullOrEmpty)
            {
                try
                {
                    bool released = await backlogStore.ReleasePublishOrderLockAsync(publishOrderLock).ConfigureAwait(false);
                    if (!released)
                    {
                        logger.LogWarning("notification-stream-publish-order-lock-release-missed {EventType} {EventId}", eventType, eventId);
                    }
                }
                catch (Exception ex)
                {
                    logger.LogWarning(ex, "notification-stream-publish-order-lock-release-failed {EventType} {EventId}", eventType, eventId);
                }
            }
            _publishGate.Release();
        }
    }
}
