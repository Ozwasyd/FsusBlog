using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Shared.Contracts.NotificationStream;

namespace FsusBlog.Server.Interfaces;

public interface INotificationStreamPublisher
{
    Task<Result<NotificationStreamCursor>> PublishAsync<TPayload>(
        NotificationStreamEventType eventType,
        TPayload payload,
        NotificationStreamTarget target,
        CancellationToken cancellationToken = default);
}