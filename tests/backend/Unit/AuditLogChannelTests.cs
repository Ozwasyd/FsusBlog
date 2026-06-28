using System.Threading.Channels;
using FsusBlog.Server.Infrastructure.Audit;

namespace FsusBlog.Server.Tests;

public sealed class AuditLogChannelTests
{
    [Fact]
    public void TryWrite_DropsOverflowAndTracksDroppedCount()
    {
        var channel = new AuditLogChannel(new BoundedChannelOptions(1)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.Wait
        });

        bool first = channel.TryWrite(new AuditRecord("request", "business", DateTime.UtcNow, "one", null));
        bool second = channel.TryWrite(new AuditRecord("request", "business", DateTime.UtcNow, "two", null));

        Assert.True(first);
        Assert.False(second);
        Assert.Equal(1, channel.DrainDroppedCount());
        Assert.Equal(0, channel.DrainDroppedCount());
    }

    [Fact]
    public void TryWrite_DurableRecordUsesIndependentLaneWhenBestEffortChannelIsFull()
    {
        var channel = new AuditLogChannel(new BoundedChannelOptions(1)
        {
            SingleReader = true,
            SingleWriter = false,
            FullMode = BoundedChannelFullMode.Wait
        });

        bool bestEffort = channel.TryWrite(new AuditRecord("request", "business", DateTime.UtcNow, "normal", null));
        bool durable = channel.TryWrite(new AuditRecord("security", "security", DateTime.UtcNow, "critical", null, IsHighValue: true));
        bool overflow = channel.TryWrite(new AuditRecord("request", "business", DateTime.UtcNow, "overflow", null));

        Assert.True(bestEffort);
        Assert.True(durable);
        Assert.False(overflow);
        AuditLogChannelSnapshot snapshot = channel.Snapshot();
        Assert.Equal(2, snapshot.QueuedCount);
        Assert.Equal(1, snapshot.DroppedCount);
        Assert.Equal(1, snapshot.DroppedBySourceType["request:business"]);
    }
}
