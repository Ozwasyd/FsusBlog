using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Shared.Contracts.NotificationStream;

using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Tests.Unit;

internal static class NotificationStreamBackpressureTestSupport
{
    public static NotificationStreamLocalFanoutQueue CreateQueue()
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["NotificationStream:LocalFanoutQueueCapacity"] = "12",
                ["NotificationStream:Fanout:LosslessFrameCapacity"] = "4",
                ["NotificationStream:Fanout:StateFrameCapacity"] = "4",
                ["NotificationStream:Fanout:LowFrameCapacity"] = "4",
                ["NotificationStream:Fanout:LosslessByteBudget"] = "4096",
                ["NotificationStream:Fanout:StateByteBudget"] = "4096",
                ["NotificationStream:Fanout:LowByteBudget"] = "4096"
            })
            .Build();
        return new NotificationStreamLocalFanoutQueue(configuration);
    }

    public static void UpdateMaximum(ref int location, int value)
    {
        int current = Volatile.Read(ref location);
        while (value > current)
        {
            int observed = Interlocked.CompareExchange(ref location, value, current);
            if (observed == current)
            {
                return;
            }

            current = observed;
        }
    }
}

internal sealed class PolicyTestFrameCodec : INotificationFrameCodec
{
    public byte[] EncodeHeartbeatFrame() => [0];

    public SharedNotificationStreamFrame EncodeEventFrame<TPayload>(
        long eventId,
        NotificationStreamEventType eventType,
        TPayload payload)
        => SharedNotificationStreamFrame.FromArray([(byte)eventId, (byte)eventType]);
}
