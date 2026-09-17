using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RuntimeCacheScenarioEvidenceClockTests
{
    [Fact]
    public void SecurityDurableRowBoundaryUsesTheInjectedBusinessClock()
    {
        var epoch = new DateTimeOffset(2026, 9, 14, 15, 10, 0, TimeSpan.Zero);
        var clock = new TestBusinessTimeProvider(epoch);

        DateTimeOffset boundary = RuntimeCacheScenarioEvidenceEndpoints.SecurityEvidenceStartBoundary(clock);

        Assert.Equal(epoch.AddSeconds(-1), boundary);
    }
}
