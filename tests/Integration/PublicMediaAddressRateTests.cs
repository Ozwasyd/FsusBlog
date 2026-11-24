namespace FsusBlog.V2.Integration.Tests;

public sealed class PublicMediaAddressRateTests
{
    [Fact]
    public void AllowsOneNominalAndThirtyExcessRequestsPerAddress()
    {
        var clock = new ManualClock();
        var rate = new PublicMediaAddressRate(clock);
        var ipv4 = IPAddress.Parse("192.0.2.1");
        var ipv6 = IPAddress.Parse("2001:db8::1");
        for (var i = 0; i < 31; i++) Assert.True(rate.Admit(ipv4));
        Assert.False(rate.Admit(ipv4));
        Assert.True(rate.Admit(ipv6));

        clock.Advance(TimeSpan.FromMilliseconds(100) - TimeSpan.FromTicks(1));
        Assert.False(rate.Admit(ipv4));
        clock.Advance(TimeSpan.FromTicks(1));
        Assert.True(rate.Admit(ipv4));
        Assert.False(rate.Admit(ipv4));
        clock.Advance(TimeSpan.FromMilliseconds(300));
        for (var i = 0; i < 3; i++) Assert.True(rate.Admit(ipv4));
        Assert.False(rate.Admit(ipv4));

        clock.Advance(TimeSpan.FromSeconds(3.1));
        for (var i = 0; i < 31; i++) Assert.True(rate.Admit(ipv4));
        Assert.False(rate.Admit(ipv4));
    }

    private sealed class ManualClock : TimeProvider
    {
        private long now;
        public override long TimestampFrequency => TimeSpan.TicksPerSecond;
        public override long GetTimestamp() => now;
        internal void Advance(TimeSpan duration) => now += duration.Ticks;
    }
}
