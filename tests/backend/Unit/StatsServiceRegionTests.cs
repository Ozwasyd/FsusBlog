using FsusBlog.Server.Services;
using FsusBlog.Server.Tests.TestInfrastructure;

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

    [Fact]
    public void LoadRegionStatsAsync_SourcePushesNormalizationAndTopNToSql()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/StatsService.cs"));
        int methodStart = source.IndexOf("private async Task<List<RegionStatItemDto>> LoadRegionStatsAsync", StringComparison.Ordinal);
        int nextMethod = source.IndexOf("internal static string NormalizeRegionForStats", StringComparison.Ordinal);
        string method = source[methodStart..nextMethod];

        Assert.Contains("WITH normalized_regions AS", method, StringComparison.Ordinal);
        Assert.Contains("GROUP BY \"Region\"", method, StringComparison.Ordinal);
        Assert.Contains("ORDER BY \"Count\" DESC, \"Region\" ASC", method, StringComparison.Ordinal);
        Assert.Contains("LIMIT 10", method, StringComparison.Ordinal);
        Assert.DoesNotContain("Dictionary<string, int>", method, StringComparison.Ordinal);
        Assert.DoesNotContain("OrderByDescending(item => item.Value)", method, StringComparison.Ordinal);
    }
}
