using System.Buffers;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Shared.Contracts.Sse;

namespace FsusBlog.Server.Infrastructure.Sse;

internal interface INotificationFrameCodec
{
    byte[] EncodeHeartbeatFrame();
    SharedSseFrame EncodeEventFrame<TPayload>(long eventId, SseEventType eventType, TPayload payload);
}

internal sealed class NotificationFrameCodec(IAedsEncoder aeds) : INotificationFrameCodec
{
    public byte[] EncodeHeartbeatFrame()
    {
        var payloadWriter = new ArrayBufferWriter<byte>(16);
        PodBinaryCodec.WriteNotificationHeartbeat(payloadWriter);
        return aeds.Encode(AedsFrameType.NotificationHeartbeat, payloadWriter.WrittenSpan);
    }

    public SharedSseFrame EncodeEventFrame<TPayload>(long eventId, SseEventType eventType, TPayload payload)
    {
        var payloadWriter = new ArrayBufferWriter<byte>(512);
        PodBinaryCodec.WriteNotificationEvent(eventId, eventType, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), payload, payloadWriter);
        return SharedSseFrame.FromArray(aeds.Encode(AedsFrameType.NotificationEvent, payloadWriter.WrittenSpan));
    }
}