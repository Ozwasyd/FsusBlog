using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Sse;
using FsusBlog.Server.Interfaces;
using FsusBlog.Shared.Contracts.Sse;

namespace FsusBlog.Server.Services.Sse;

internal sealed class RedisSsePublisher(
    SseBacklogStore backlogStore,
    SseLocalFanoutQueue localFanoutQueue,
    INotificationFrameCodec frameCodec,
    ILogger<RedisSsePublisher> logger) : ISsePublisher
{
    public async Task<Result<SseCursor>> PublishAsync<TPayload>(
        SseEventType eventType,
        TPayload payload,
        SseTarget target,
        CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();

        long eventId;
        try
        {
            eventId = await backlogStore.NextEventIdAsync(cancellationToken).ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to allocate SSE event id. Type: {EventType}", eventType);
            return Result<SseCursor>.Failure(ErrorCode.InfraFailure, "SSE event id allocation failed");
        }
        SharedSseFrame frame = frameCodec.EncodeEventFrame(eventId, eventType, payload);

        try
        {
            var routeResult = TargetRouteCodec.TryEncode(target);
            if (routeResult.IsFailure || string.IsNullOrWhiteSpace(routeResult.Value))
            {
                return Result<SseCursor>.Failure(routeResult.IsFailure ? routeResult.Error : ErrorDetail.Create(ErrorCode.Validation, "Unsupported SSE target."));
            }

            string route = routeResult.Value;
            Result appendResult = await backlogStore.AppendAsync(eventId, route, frame, cancellationToken).ConfigureAwait(false);
            if (appendResult.IsFailure)
            {
                return Result<SseCursor>.Failure(appendResult.Error);
            }

            if (!localFanoutQueue.TryEnqueue(frame, target))
            {
                logger.LogWarning("sse-local-fanout-enqueue-dropped {EventType} {EventId} {DroppedCount}",
                    eventType,
                    eventId,
                    localFanoutQueue.DroppedCount);
            }
            return Result<SseCursor>.Success(new SseCursor(eventId));
        }
        catch (Exception ex)
        {
            logger.LogError(ex, "Failed to publish SSE event. Type: {EventType} | EventId: {EventId}", eventType, eventId);
            return Result<SseCursor>.Failure(ErrorCode.InfraFailure, "SSE publish failed");
        }
        finally
        {
            frame.Release();
        }
    }
}
