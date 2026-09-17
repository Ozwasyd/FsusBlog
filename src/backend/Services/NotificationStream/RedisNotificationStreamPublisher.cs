using System.Diagnostics;
using System.Globalization;

using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Interfaces;
using FsusBlog.Shared.Contracts.NotificationStream;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Services.NotificationStream;

internal sealed class RedisNotificationStreamPublisher(
    NotificationStreamBacklogStore backlogStore,
    NotificationStreamLocalFanoutQueue localFanoutQueue,
    NotificationStreamConnectionManager connectionManager,
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

        var routeResult = NotificationStreamTargetRouteCodec.TryEncode(target);
        if (routeResult.IsFailure || string.IsNullOrWhiteSpace(routeResult.Value))
        {
            return Result<NotificationStreamCursor>.Failure(
                routeResult.IsFailure
                    ? routeResult.Error
                    : ErrorDetail.Create(ErrorCode.Validation, "Unsupported notification stream target."));
        }

        NotificationStreamDeliveryPolicy policy;
        try
        {
            policy = NotificationStreamDeliveryPolicyCatalog.GetRequired(eventType);
        }
        catch (InvalidOperationException ex)
        {
            logger.LogError(ex, "notification-stream-unknown-event-type {EventType}", (short)eventType);
            return Result<NotificationStreamCursor>.Failure(ErrorCode.Validation, "Unsupported notification stream event type.");
        }

        string route = routeResult.Value!;
        IReadOnlyList<NotificationStreamPublishOrderLock> publishOrderLocks = [];
        SharedNotificationStreamFrame? frame = null;
        long eventId = 0;
        try
        {
            long waitStarted = Stopwatch.GetTimestamp();
            publishOrderLocks = await backlogStore.AcquirePublishOrderLocksAsync(route, cancellationToken).ConfigureAwait(false);
            NotificationStreamMetrics.RecordPublishCriticalSectionWait(
                Stopwatch.GetElapsedTime(waitStarted),
                publishOrderLocks.Count);
            eventId = await backlogStore.GetOrCreateEventIdAsync(idempotencyKey, cancellationToken).ConfigureAwait(false);
            frame = frameCodec.EncodeEventFrame(eventId, eventType, payload);

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

            if (appendResult.Value is { Appended: true })
            {
                string coalescingKey = ResolveCoalescingKey(eventType, payload, route, policy);
                NotificationStreamFanoutEnqueueResult enqueue = localFanoutQueue.TryEnqueue(
                    frame,
                    target,
                    policy,
                    coalescingKey,
                    eventId,
                    new CommittedBacklogAcceptance(eventId, route));
                if (enqueue.Status == NotificationStreamFanoutEnqueueStatus.ReplayRequired)
                {
                    connectionManager.RequireRecovery(
                        target,
                        policy,
                        eventId,
                        string.Concat("publish_lane_", enqueue.Reason));
                    logger.LogWarning(
                        "notification-stream-local-fanout-replay-required {EventType} {EventId} {Reason} {DroppedCount}",
                        eventType,
                        eventId,
                        enqueue.Reason,
                        localFanoutQueue.DroppedCount);
                }
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
            if (publishOrderLocks.Count > 0)
            {
                try
                {
                    bool released = await backlogStore.ReleasePublishOrderLocksAsync(publishOrderLocks).ConfigureAwait(false);
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
        }
    }

    private sealed class CommittedBacklogAcceptance(long eventId, string route) : NotificationStreamBacklogAcceptance
    {
        internal long EventId { get; } = eventId;
        internal string Route { get; } = route;
    }

    internal static bool MatchesBacklogAcceptance(
        NotificationStreamBacklogAcceptance acceptance,
        long eventId,
        NotificationStreamTarget target)
    {
        if (acceptance is not CommittedBacklogAcceptance committed || committed.EventId != eventId)
        {
            return false;
        }

        var route = NotificationStreamTargetRouteCodec.TryEncode(target);
        return route.IsSuccess && string.Equals(route.Value, committed.Route, StringComparison.Ordinal);
    }

    private static string ResolveCoalescingKey<TPayload>(
        NotificationStreamEventType eventType,
        TPayload payload,
        string route,
        NotificationStreamDeliveryPolicy policy)
    {
        string semanticKey = payload switch
        {
            InboxConversationUpsertPayload value => value.Conversation.ConversationId,
            InboxMessageAppendPayload value => value.ConversationId,
            InboxReadUpdatedPayload value => value.ConversationId,
            InboxConversationStatusChangedPayload value => value.ConversationId,
            CacheControlPayload value => string.Concat(value.Type, ":", value.Scope ?? string.Empty, ":", value.Cache ?? string.Empty),
            SearchIndexUpdatePayload value => value.ManifestUrl,
            _ => route
        };

        return string.Create(
            CultureInfo.InvariantCulture,
            $"{(short)eventType}:{policy.CoalescingKey ?? "none"}:{route}:{semanticKey}");
    }
}
