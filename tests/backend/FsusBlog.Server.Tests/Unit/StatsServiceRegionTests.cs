using FsusBlog.Server.Services;

namespace FsusBlog.Server.Tests.Unit;

public sealed class StatsServiceRegionTests
{
    [Theory]
    [InlineData(null)]
    [InlineData("")]
    [InlineData("   ")]
    [InlineData("未知")]
    [InlineData("Unknown")]
    public void NormalizeRegionForStats_UnknownInputs_ReturnsUnknownRegion(string? input)
    {
        Assert.Equal("未知地区", StatsService.NormalizeRegionForStats(input));
    }

    [Fact]
    public void NormalizeRegionForStats_KnownRegion_ReturnsTrimmedValue()
    {
        Assert.Equal("中国-北京", StatsService.NormalizeRegionForStats("  中国-北京  "));
    }
}
