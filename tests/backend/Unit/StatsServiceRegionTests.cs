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

    [Fact]
    public void LoadAdminStatsOverviewFromDbAsync_UsesSerializableTransaction()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/StatsService.cs"));
        string method = Slice(source, "private async Task<AdminStatsOverviewDto> LoadAdminStatsOverviewFromDbAsync", "    private async Task<List<RecentCommentStatItemDto>> LoadRecentCommentsAsync");

        Assert.Contains("BeginTran(IsolationLevel.Serializable)", method, StringComparison.Ordinal);
        Assert.Contains("_db.Ado.CommitTran()", method, StringComparison.Ordinal);
        Assert.Contains("_db.Ado.RollbackTran()", method, StringComparison.Ordinal);
    }

    [Fact]
    public void LoadAdminStatsOverviewFromDbAsync_RunsAllOverviewReadsInsideSerializableTransaction()
    {
        string source = File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, "src/backend/Services/StatsService.cs"));
        string method = Slice(source, "private async Task<AdminStatsOverviewDto> LoadAdminStatsOverviewFromDbAsync", "    private async Task<List<RecentCommentStatItemDto>> LoadRecentCommentsAsync");

        int begin = method.IndexOf("BeginTran(IsolationLevel.Serializable)", StringComparison.Ordinal);
        int articleCounts = method.IndexOf("articleCountQuery.ToSql()", StringComparison.Ordinal);
        int comments = method.IndexOf("Queryable<Comment>().CountAsync()", StringComparison.Ordinal);
        int popular = method.IndexOf("popularQuery.ToSql()", StringComparison.Ordinal);
        int readStats = method.IndexOf("readStatsSql", StringComparison.Ordinal);
        int commit = method.IndexOf("_db.Ado.CommitTran()", StringComparison.Ordinal);

        Assert.True(begin >= 0);
        Assert.True(articleCounts > begin && articleCounts < commit);
        Assert.True(comments > begin && comments < commit);
        Assert.True(popular > begin && popular < commit);
        Assert.True(readStats > begin && readStats < commit);
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
