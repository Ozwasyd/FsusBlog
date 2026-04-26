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
}
