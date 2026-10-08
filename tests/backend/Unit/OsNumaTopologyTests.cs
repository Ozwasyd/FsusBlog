using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Platform;

using Xunit;

namespace FsusBlog.Server.Tests.Unit;

public sealed class OsNumaTopologyTests
{
    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(63)]
    [InlineData(64)]
    [InlineData(4094)]
    [InlineData(4095)]
    public unsafe void BindMaskRetainsOnlyTheTargetAfterKernelMaximumDecrement(int node)
    {
        int calls = 0;
        OsPageCall result = LinuxOsNumaRangeApi.Bind(123, 4096, node,
            (address, bytes, mode, mask, maximumNode, flags) =>
            {
                calls++;
                Assert.Equal((nint)123, address);
                Assert.Equal((nuint)4096, bytes);
                Assert.Equal(2, mode);
                Assert.Equal(0U, flags);
                // Model the documented get_nodes/get_bitmap boundary, without
                // invoking mbind or asserting any native NUMA capability.
                int copiedBits = checked((int)(maximumNode - 1));
                Assert.InRange(copiedBits, node + 1, 4096);
                int copiedWords = (copiedBits + 63) / 64;
                Assert.InRange(copiedWords, 1, 64);
                Assert.Equal(node / 64 + 1, copiedWords);
                for (int word = 0; word < copiedWords; word++)
                {
                    ulong copied = mask[word];
                    if (word == copiedWords - 1 && copiedBits % 64 != 0)
                    {
                        copied &= (1UL << (copiedBits % 64)) - 1;
                    }
                    Assert.Equal(word == node / 64 ? 1UL << (node % 64) : 0UL, copied);
                }
                return new OsPageCall(false, 22);
            });
        Assert.Equal(1, calls);
        Assert.Equal(new OsPageCall(false, 22), result);
    }

    [Theory]
    [InlineData(int.MinValue)]
    [InlineData(-1)]
    [InlineData(4096)]
    [InlineData(int.MaxValue)]
    public unsafe void OutOfRangeBindNodesNeverReachTheCall(int node)
    {
        int calls = 0;
        OsPageCall result = LinuxOsNumaRangeApi.Bind(123, 4096, node,
            (address, bytes, mode, mask, maximumNode, flags) =>
            {
                calls++;
                return new OsPageCall(true, 0);
            });
        Assert.Equal(0, calls);
        Assert.Equal(new OsPageCall(false, 95), result);
    }

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
