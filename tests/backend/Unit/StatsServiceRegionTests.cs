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
    public void LoadRegionStatsAsync_SourceReadsPreAggregatedRegionRollup()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/StatsService.cs"));
        int methodStart = source.IndexOf("private async Task<List<RegionStatItemDto>> LoadRegionStatsAsync", StringComparison.Ordinal);
        int nextMethod = source.IndexOf("internal static string NormalizeRegionForStats", StringComparison.Ordinal);
        string method = source[methodStart..nextMethod];

        Assert.Contains("region_read_stats", method, StringComparison.Ordinal);
        Assert.DoesNotContain("FROM sys_visit_log", method, StringComparison.Ordinal);
        Assert.Contains("ORDER BY \"Count\" DESC, \"Region\" ASC", method, StringComparison.Ordinal);
        Assert.Contains("LIMIT 10", method, StringComparison.Ordinal);
        Assert.DoesNotContain("Dictionary<string, int>", method, StringComparison.Ordinal);
        Assert.DoesNotContain("OrderByDescending(item => item.Value)", method, StringComparison.Ordinal);
    }

    [Fact]
    public void LoadAdminStatsOverviewFromDbAsync_UsesRollupTablesWithoutHeavySerializableTransaction()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/StatsService.cs"));
        string method = Slice(source, "private async Task<AdminStatsOverviewDto> LoadAdminStatsOverviewFromDbAsync", "    private async Task<List<RecentCommentStatItemDto>> LoadRecentCommentsAsync");

        Assert.Contains("daily_read_stats", method, StringComparison.Ordinal);
        Assert.Contains("event_type_read_stats", method, StringComparison.Ordinal);
        Assert.DoesNotContain("FROM sys_visit_log", method, StringComparison.Ordinal);
        Assert.DoesNotContain("BeginTran(IsolationLevel.Serializable)", method, StringComparison.Ordinal);
    }

    [Fact]
    public void LoadAdminStatsOverviewFromDbAsync_UsesIndependentOverviewCachePolicy()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/StatsService.cs"));
        string method = Slice(source, "private async Task<AdminStatsOverviewDto> LoadAdminStatsOverviewFromDbAsync", "    private async Task<List<RecentCommentStatItemDto>> LoadRecentCommentsAsync");
        string publicMethod = Slice(source, "public async Task<AdminStatsOverviewDto> GetAdminStatsOverviewAsync", "    public async Task<List<RecentCommentStatItemDto>> GetAdminRecentCommentsAsync");

        Assert.Contains("CachePolicyId.AdminStatsOverview", publicMethod, StringComparison.Ordinal);
        Assert.Contains("articleCountQuery.ToSql()", method, StringComparison.Ordinal);
        Assert.Contains("Queryable<Comment>().CountAsync()", method, StringComparison.Ordinal);
        Assert.Contains("popularQuery.ToSql()", method, StringComparison.Ordinal);
        Assert.Contains("readStatsSql", method, StringComparison.Ordinal);
    }

    private static string Slice(string source, string startMarker, string endMarker)
    {
        int start = source.IndexOf(startMarker, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Missing start marker: {startMarker}");
        int end = source.IndexOf(endMarker, start + startMarker.Length, StringComparison.Ordinal);
        Assert.True(end > start, $"Missing end marker: {endMarker}");
        return source[start..end];
    }
}
