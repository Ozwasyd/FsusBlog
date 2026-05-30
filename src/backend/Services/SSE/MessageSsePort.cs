using FsusBlog.Server.Infrastructure.Sse;
using FsusBlog.Server.Interfaces;
using FsusBlog.Shared.Contracts.Sse;

namespace FsusBlog.Server.Services.Sse;

public interface IMessageSsePort
{
    Task PublishToUserAsync<TPayload>(SseEventType eventType, long userId, TPayload payload, string operation);

    Task PublishToContentFeedAsync<TPayload>(SseEventType eventType, TPayload payload, string operation);

    Task PublishToAdminUsersAsync<TPayload>(SseEventType eventType, TPayload payload, string operation);
}

internal sealed class MessageSsePort(
    ISsePublisher ssePublisher,
    ILogger<MessageSsePort> logger) : IMessageSsePort
{
    public Task PublishToUserAsync<TPayload>(SseEventType eventType, long userId, TPayload payload, string operation)
        => PublishOrLogAsync(eventType, payload, new UserTarget(userId.ToString()), operation);

    public Task PublishToContentFeedAsync<TPayload>(SseEventType eventType, TPayload payload, string operation)
        => PublishOrLogAsync(eventType, payload, new GroupTarget(SseGroups.ContentFeed), operation);

    public Task PublishToAdminUsersAsync<TPayload>(SseEventType eventType, TPayload payload, string operation)
        => PublishOrLogAsync(eventType, payload, new GroupTarget(SseGroups.AdminUsers), operation);

    private async Task PublishOrLogAsync<TPayload>(SseEventType eventType, TPayload payload, SseTarget target, string operation)
    {
        var result = await ssePublisher.PublishAsync(eventType, payload, target);
        if (result.IsFailure)
        {
            logger.LogWarning(
                "SSE publish failed. Operation: {Operation} | EventType: {EventType} | Code: {Code} | Message: {Message}",
                operation,
                eventType,
                result.Error.Code,
                result.Error.Message);
        }
    }
}
