using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Platform;

using Xunit;

namespace FsusBlog.Server.Tests.Unit;

public sealed class OsNumaTopologyTests
{
    [Fact]
    public void DisabledObservationLeavesDetectionUnknownWithoutReadingTheOs()
    {
        OsNumaTopologyObservation observation = OsNumaTopologySource.Observe(MemoryCapabilityMode.Disabled);
        Assert.Equal(MemoryDetection.Unknown, observation.Detection);
        Assert.Null(observation.AllowedNodes);
        Assert.Empty(observation.OnlineNodes);
        Assert.Contains("no NUMA source probes", observation.Reason);
    }

    [Theory]
    [InlineData("0", "0", 1, 1)]
    [InlineData("0-3", "1,3", 4, 2)]
    [InlineData("0,2", "2-3", 2, 1)]
    public void OnlineAndAllowedAreDistinct(string online, string allowed, int onlineCount, int allowedCount)
    {
        OsNumaTopologyObservation observation = OsNumaTopologySource.Parse(online,
            $"Name:\ttest\nMems_allowed_list:\t{allowed}\n", DateTimeOffset.UnixEpoch);
        Assert.Equal(MemoryDetection.Present, observation.Detection);
        Assert.Equal(onlineCount, observation.OnlineNodes.Count);
        Assert.Equal(allowedCount, observation.AllowedNodes!.Count);
        Assert.All(observation.AllowedNodes, node => Assert.True(observation.CanTarget(node)));
        Assert.False(observation.CanTarget(4096));
    }

    [Theory]
    [InlineData("")]
    [InlineData("-1")]
    [InlineData("0-4096")]
    [InlineData("3-1")]
    [InlineData("0,,1")]
    [InlineData("0,0")]
    [InlineData("1-3,2")]
    [InlineData("2147483647")]
    [InlineData("0-1-2")]
    public void MalformedOrUnboundedTopologyIsUnknown(string online)
    {
        OsNumaTopologyObservation observation = OsNumaTopologySource.Parse(online,
            "Mems_allowed_list:\t0\n", DateTimeOffset.UnixEpoch);
        Assert.Equal(MemoryDetection.Unknown, observation.Detection);
        Assert.Null(observation.AllowedNodes);
        Assert.False(observation.CanTarget(0));
    }

    [Theory]
    [InlineData("Name:\ttest\n")]
    [InlineData("Mems_allowed_list:\t\n")]
    [InlineData("Mems_allowed_list:\t0\nMems_allowed_list:\t1\n")]
    public void MissingOrConflictingRestrictionsNeverAuthorizePlacement(string status)
    {
        OsNumaTopologyObservation observation = OsNumaTopologySource.Parse("0-1", status, DateTimeOffset.UnixEpoch);
        Assert.Equal(MemoryDetection.Present, observation.Detection);
        Assert.Null(observation.AllowedNodes);
        Assert.False(observation.CanTarget(0));
        Assert.False(observation.CanTarget(1));
    }

    [Fact]
    public void CompletelyDisallowedOnlineSetIsKnownEmpty()
    {
        OsNumaTopologyObservation observation = OsNumaTopologySource.Parse("0", "Mems_allowed_list:\t1\n",
            DateTimeOffset.UnixEpoch);
        Assert.NotNull(observation.AllowedNodes);
        Assert.Empty(observation.AllowedNodes);
        Assert.False(observation.CanTarget(0));
    }
}
