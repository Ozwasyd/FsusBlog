using System.Buffers;
using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Shared.Contracts.NotificationStream;

namespace FsusBlog.Server.Infrastructure.NotificationStream;

internal interface INotificationFrameCodec
{
    byte[] EncodeHeartbeatFrame();
    SharedNotificationStreamFrame EncodeEventFrame<TPayload>(long eventId, NotificationStreamEventType eventType, TPayload payload);
}

internal sealed class NotificationFrameCodec(IAedsEncoder aeds) : INotificationFrameCodec
{
    public byte[] EncodeHeartbeatFrame()
    {
        var payloadWriter = new ArrayBufferWriter<byte>(16);
        PodBinaryCodec.WriteNotificationHeartbeat(payloadWriter);
        return aeds.Encode(AedsFrameType.NotificationHeartbeat, payloadWriter.WrittenSpan);
    }

    public SharedNotificationStreamFrame EncodeEventFrame<TPayload>(long eventId, NotificationStreamEventType eventType, TPayload payload)
    {
        var payloadWriter = new ArrayBufferWriter<byte>(512);
        PodBinaryCodec.WriteNotificationEvent(eventId, eventType, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), payload, payloadWriter);
        return SharedNotificationStreamFrame.FromArray(aeds.Encode(AedsFrameType.NotificationEvent, payloadWriter.WrittenSpan));
    }
}