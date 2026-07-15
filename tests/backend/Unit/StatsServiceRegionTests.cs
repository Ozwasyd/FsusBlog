using System.Reflection;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Privacy;
using FsusBlog.Server.Services;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class StatsServiceRegionTests(PostgresSchemaMigrationFixture fixture)
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
    public async Task LoadRegionStatsAsync_ReadsAggregatedTopTenFromRegionRollup()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        CreateRegionRollupTable(db);
        DateTime now = DateTime.UtcNow;
        for (int index = 0; index < 12; index++)
        {
            db.Ado.ExecuteCommand(
                "INSERT INTO region_read_stats(region, read_count, updated_at_utc) VALUES (@Region, @Count, @Now);",
                new SugarParameter("@Region", $"region-{index:00}"),
                new SugarParameter("@Count", (long)(20 - index)),
                new SugarParameter("@Now", now));
        }
        db.Ado.ExecuteCommand(
            "INSERT INTO region_read_stats(region, read_count, updated_at_utc) VALUES (NULL, 7, @Now), ('Unknown', 5, @Now), ('未知', 3, @Now);",
            new SugarParameter("@Now", now));
        var executedSql = new List<string>();
        db.Aop.OnLogExecuting = (sql, _) => executedSql.Add(sql);
        StatsService service = CreateService(db);

        List<RegionStatItemDto> regions = await service.LoadRegionStatsAsync(CancellationToken.None);

        string query = Assert.Single(executedSql);
        Assert.Contains("region_read_stats", query, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("sys_visit_log", query, StringComparison.OrdinalIgnoreCase);
        Assert.Equal(10, regions.Count);
        Assert.DoesNotContain(regions, static item => item.Region is "region-10" or "region-11");
        Assert.Contains(regions, static item => item.Region == "未知地区");
        Assert.Equal(
            regions.OrderByDescending(static item => item.Count).ThenBy(static item => item.Region, StringComparer.Ordinal).ToArray(),
            regions.ToArray());
    }

    [Fact]
    public async Task LoadAdminStatsOverviewFromDbAsync_UsesRollupsWithoutSerializableTransaction()
    {
        using SqlSugarClient db = await CreateOverviewDatabaseAsync();
        db.Ado.ExecuteCommand("INSERT INTO daily_read_stats VALUES ('2026-07-12', 30, 20, 10, NOW());");
        db.Ado.ExecuteCommand("INSERT INTO event_type_read_stats VALUES ('article_read', 22, NOW()), ('site_read', 8, NOW());");
        var executedSql = new List<string>();
        db.Aop.OnLogExecuting = (sql, _) => executedSql.Add(sql);
        StatsService service = CreateService(db);

        AdminStatsOverviewDto overview = await InvokeOverviewLoaderAsync(service);

        Assert.Equal(30, overview.Summary.TotalReads);
        Assert.Equal(20, overview.Summary.HumanVerifiedReads);
        Assert.Equal(0, overview.Summary.UniqueViewerKeyEstimate);
        Assert.Equal(22, overview.Summary.ArticleReads);
        Assert.Equal(8, overview.Summary.SiteReads);
        Assert.Contains(executedSql, static sql => sql.Contains("daily_read_stats", StringComparison.OrdinalIgnoreCase));
        Assert.Contains(executedSql, static sql => sql.Contains("event_type_read_stats", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(executedSql, static sql => sql.Contains("sys_visit_log", StringComparison.OrdinalIgnoreCase));
        Assert.DoesNotContain(executedSql, static sql => sql.Contains("SERIALIZABLE", StringComparison.OrdinalIgnoreCase));
    }

    [Fact]
    public async Task GetAdminStatsOverviewAsync_UsesIndependentOverviewCachePolicy()
    {
        var coordinator = new RecordingCacheMissCoordinator(new AdminStatsOverviewDto
        {
            Summary = new StatsSummaryDto { TotalArticles = 7 }
        });
        var service = new StatsService(
            Substitute.For<ISqlSugarClient>(),
            Substitute.For<IUnifiedCache>(),
            coordinator,
            Substitute.For<IDbConcurrencyGate>(),
            CreatePrivacyPolicy(),
            NullLogger<StatsService>.Instance);

        AdminStatsOverviewDto overview = await service.GetAdminStatsOverviewAsync();

        Assert.Equal(7, overview.Summary.TotalArticles);
        Assert.Equal(CachePolicyId.AdminStatsOverview, coordinator.PolicyId);
        Assert.Equal("main", coordinator.Identity);
        Assert.Equal("admin-stats", coordinator.Operation);
    }

    private static StatsService CreateService(ISqlSugarClient db)
        => new(
            db,
            Substitute.For<IUnifiedCache>(),
            Substitute.For<ICacheMissCoordinator>(),
            Substitute.For<IDbConcurrencyGate>(),
            CreatePrivacyPolicy(),
            NullLogger<StatsService>.Instance);

    private static IReadAnalyticsPrivacyPolicy CreatePrivacyPolicy()
        => new ReadAnalyticsPrivacyPolicy(
            new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    [ReadAnalyticsPrivacyPolicy.NoiseKeySetting] = "QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl8=",
                    [ReadAnalyticsPrivacyPolicy.KThresholdSetting] = "10",
                    [ReadAnalyticsPrivacyPolicy.EpsilonPerReleaseSetting] = "0.5",
                    [ReadAnalyticsPrivacyPolicy.DailyEpsilonLimitSetting] = "1.0"
                })
                .Build(),
            TimeProvider.System);

    private async Task<SqlSugarClient> CreateOverviewDatabaseAsync()
    {
        SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(Article), typeof(Comment));
        db.Ado.ExecuteCommand("""
            CREATE TABLE daily_read_stats (
                stat_date date PRIMARY KEY,
                total_reads bigint NOT NULL,
                human_verified_reads bigint NOT NULL,
                unique_viewer_estimate bigint NOT NULL,
                updated_at_utc timestamp without time zone NOT NULL
            );
            CREATE TABLE event_type_read_stats (
                event_type text PRIMARY KEY,
                read_count bigint NOT NULL,
                updated_at_utc timestamp without time zone NOT NULL
            );
            """);
        return db;
    }

    private static void CreateRegionRollupTable(SqlSugarClient db)
        => db.Ado.ExecuteCommand("""
            CREATE TABLE region_read_stats (
                region text NULL,
                read_count bigint NOT NULL,
                updated_at_utc timestamp without time zone NOT NULL
            );
            """);

    private static async Task<AdminStatsOverviewDto> InvokeOverviewLoaderAsync(StatsService service)
    {
        MethodInfo method = typeof(StatsService).GetMethod(
            "LoadAdminStatsOverviewFromDbAsync",
            BindingFlags.NonPublic | BindingFlags.Instance)
            ?? throw new InvalidOperationException("Stats overview loader was not found.");
        var task = Assert.IsAssignableFrom<Task<AdminStatsOverviewDto>>(
            method.Invoke(service, [CancellationToken.None]));
        return await task;
    }

    private sealed class RecordingCacheMissCoordinator(AdminStatsOverviewDto result) : ICacheMissCoordinator
    {
        public CachePolicyId? PolicyId { get; private set; }
        public string? Identity { get; private set; }
        public string? Operation { get; private set; }

        public Task<T?> CoordinateAsync<T>(
            CachePolicyId policyId,
            string identity,
            Func<CancellationToken, Task<CacheReadResult<T>>> tryReadAsync,
            Func<CancellationToken, Task<T?>> rebuildAsync,
            string operation,
            CancellationToken cancellationToken = default,
            CacheRebuildStrategy? strategy = null)
        {
            PolicyId = policyId;
            Identity = identity;
            Operation = operation;
            return Task.FromResult((T?)(object)result);
        }
    }
}
