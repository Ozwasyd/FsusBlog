using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Interfaces;
using FsusBlog.Shared.Contracts.NotificationStream;

namespace FsusBlog.Server.Services.NotificationStream;

public interface IMessageNotificationStreamPort
{
    Task PublishToUserAsync<TPayload>(NotificationStreamEventType eventType, long accountId, TPayload payload, string operation);

    Task PublishToContentFeedAsync<TPayload>(
        NotificationStreamEventType eventType,
        TPayload payload,
        string operation,
        string? idempotencyKey = null);

    Task PublishToAdminUsersAsync<TPayload>(NotificationStreamEventType eventType, TPayload payload, string operation);
}

internal sealed class MessageNotificationStreamPort(
    INotificationStreamPublisher notificationStreamPublisher,
    ILogger<MessageNotificationStreamPort> logger) : IMessageNotificationStreamPort
{
    public Task PublishToUserAsync<TPayload>(NotificationStreamEventType eventType, long accountId, TPayload payload, string operation)
        => PublishOrLogAsync(eventType, payload, new NotificationStreamUserTarget(accountId.ToString()), operation);

    public Task PublishToContentFeedAsync<TPayload>(
        NotificationStreamEventType eventType,
        TPayload payload,
        string operation,
        string? idempotencyKey = null)
        => PublishOrLogAsync(
            eventType,
            payload,
            new NotificationStreamGroupTarget(NotificationStreamTargetCollections.ContentFeed),
            operation,
            idempotencyKey);

    public Task PublishToAdminUsersAsync<TPayload>(NotificationStreamEventType eventType, TPayload payload, string operation)
        => PublishOrLogAsync(eventType, payload, new NotificationStreamGroupTarget(NotificationStreamTargetCollections.AdminUsers), operation);

    private async Task PublishOrLogAsync<TPayload>(
        NotificationStreamEventType eventType,
        TPayload payload,
        NotificationStreamTarget target,
        string operation,
        string? idempotencyKey = null)
    {
        var result = await notificationStreamPublisher.PublishAsync(
            eventType,
            payload,
            target,
            idempotencyKey: idempotencyKey);
        if (result.IsFailure)
        {
            logger.LogWarning(
                "Notification stream publish failed. Operation: {Operation} | EventType: {EventType} | Code: {Code} | Message: {Message}",
                operation,
                eventType,
                result.Error.Code,
                result.Error.Message);
            if (!string.IsNullOrWhiteSpace(idempotencyKey))
            {
                throw new InvalidOperationException($"Notification stream idempotent publish failed: {result.Error.Code}");
            }
        }
    }
}
