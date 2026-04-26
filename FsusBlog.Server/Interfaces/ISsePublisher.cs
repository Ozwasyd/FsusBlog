using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Sse;
using FsusBlog.Shared.Contracts.Sse;

namespace FsusBlog.Server.Interfaces;

public interface ISsePublisher
{
    Task<Result<SseCursor>> PublishAsync<TPayload>(
        SseEventType eventType,
        TPayload payload,
        SseTarget target,
        CancellationToken cancellationToken = default);
}