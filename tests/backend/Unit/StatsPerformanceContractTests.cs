using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests.Unit;

public sealed class StatsPerformanceContractTests
{
    [Fact]
    public void BinaryStatsSubEndpoints_DoNotLoadFullAdminStatsCoreModel()
    {
        string source = ReadRepoFile("src/backend/Modules/Endpoints/Binary/BinaryEndpoints.Stats.cs");
        string recent = ExtractRouteBlock(source, "stats/recent-comments");
        string regions = ExtractRouteBlock(source, "stats/regions");

        Assert.Contains("GetAdminRecentCommentsAsync", recent, StringComparison.Ordinal);
        Assert.Contains("GetAdminRegionStatsAsync", regions, StringComparison.Ordinal);
        Assert.DoesNotContain("GetAdminStatsAsync", recent, StringComparison.Ordinal);
        Assert.DoesNotContain("GetAdminStatsAsync", regions, StringComparison.Ordinal);
    }

    [Fact]
    public void StatsCoreQueryCache_SourceUsesSingleFlightForColdMisses()
    {
        string source = ReadRepoFile("src/backend/Infrastructure/CoreBridge/Caching/StatsCoreQueryCache.cs");

        Assert.Contains("AcquireSingleFlightAsync", source, StringComparison.Ordinal);
        Assert.Contains("await using", source, StringComparison.Ordinal);
        Assert.Contains("TryGetAsync(CachePolicyId.AdminStats", source, StringComparison.Ordinal);
    }

    [Fact]
    public void StatsCachePolicies_AreSplitByOverviewRecentRegionsAndFrame()
    {
        string policyIds = ReadRepoFile("src/backend/Infrastructure/Cache/CachePolicyId.cs");
        string registry = ReadRepoFile("src/backend/Infrastructure/Cache/CachePolicyRegistry.cs");
        string invalidation = ReadRepoFile("src/backend/Infrastructure/Cache/ICacheInvalidationDispatcher.cs");

        Assert.Contains("AdminStatsOverview", policyIds, StringComparison.Ordinal);
        Assert.Contains("AdminStatsRecentComments", policyIds, StringComparison.Ordinal);
        Assert.Contains("AdminStatsRegions", policyIds, StringComparison.Ordinal);
        Assert.Contains("CachePolicyId.AdminStatsOverview", registry, StringComparison.Ordinal);
        Assert.Contains("CachePolicyId.AdminStatsRecentComments", registry, StringComparison.Ordinal);
        Assert.Contains("CachePolicyId.AdminStatsRegions", registry, StringComparison.Ordinal);
        Assert.Contains("new(CachePolicyId.AdminStatsOverview", invalidation, StringComparison.Ordinal);
        Assert.Contains("new(CachePolicyId.AdminStatsRecentComments", invalidation, StringComparison.Ordinal);
        Assert.Contains("new(CachePolicyId.AdminStatsRegions", invalidation, StringComparison.Ordinal);
    }

    private static string ReadRepoFile(string relativePath)
        => File.ReadAllText(Path.Combine(BackendTestPaths.RepositoryRoot, relativePath));

    private static string ExtractRouteBlock(string source, string route)
    {
        int routeIndex = source.IndexOf(route, StringComparison.Ordinal);
        Assert.True(routeIndex >= 0, $"Missing route: {route}");
        int start = source.LastIndexOf("group.MapGet", routeIndex, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Missing MapGet start for route: {route}");
        int end = source.IndexOf("}).RequireAdminPermission", routeIndex, StringComparison.Ordinal);
        Assert.True(end > start, $"Missing MapGet end for route: {route}");
        return source[start..end];
    }
}
