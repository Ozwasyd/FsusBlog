using System.Data;
using System.Globalization;

using FsusBlog.Migration;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Tests.TestInfrastructure;

using SqlSugar;

namespace FsusBlog.Server.Tests;

public sealed class CurrentSchemaRuntimeRollupTablesTests
{
    [Fact]
    public void RuntimeRollupCatalog_MatchesPostCodeFirstEnsureTableSteps()
    {
        string[] migrationIds =
        [
            "20260629-post-visit-log-stats-rollup",
            "20260629-post-author-analytics-rollups"
        ];
        Dictionary<string, string> ensureTables = new SchemaMigrationRegistry()
            .GetDescriptors()
            .Where(descriptor => migrationIds.Contains(descriptor.MigrationId, StringComparer.Ordinal))
            .SelectMany(static descriptor => descriptor.Steps.OfType<EnsureTableStep>())
            .ToDictionary(static step => step.TableName, static step => step.CreateSql, StringComparer.Ordinal);

        Assert.Equal(
            ensureTables.Keys.Order(StringComparer.Ordinal),
            CurrentSchemaRuntimeRollupTables.TableNames.Order(StringComparer.Ordinal));
        foreach (CurrentSchemaRuntimeRollupTable table in CurrentSchemaRuntimeRollupTables.Tables)
        {
            Assert.Equal(ensureTables[table.TableName], table.CreateSql);
        }
    }

    [Fact]
    public void RuntimeRollupCatalog_CoversStatsEndpointTables()
    {
        Assert.Contains("daily_read_stats", CurrentSchemaRuntimeRollupTables.TableNames, StringComparer.Ordinal);
        Assert.Contains("region_read_stats", CurrentSchemaRuntimeRollupTables.TableNames, StringComparer.Ordinal);
        Assert.Contains("event_type_read_stats", CurrentSchemaRuntimeRollupTables.TableNames, StringComparer.Ordinal);
        Assert.Contains("author_daily_read_stats", CurrentSchemaRuntimeRollupTables.TableNames, StringComparer.Ordinal);
    }
}

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class CurrentSchemaRuntimeRollupTablesDatabaseTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task ApplyEnsureTableSteps_CreatesStatsRollupTablesQueryableAsEmpty()
    {
        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        await CurrentSchemaRuntimeRollupTables.ApplyEnsureTableStepsAsync(db, CancellationToken.None);

        DataTable stats = await db.Ado.GetDataTableAsync("""
            SELECT
                COALESCE((SELECT SUM(total_reads)::bigint FROM daily_read_stats), 0)::bigint AS "TotalReads",
                COALESCE((SELECT SUM(read_count)::bigint FROM event_type_read_stats WHERE event_type = 'article_read'), 0)::bigint AS "ArticleReads",
                COALESCE((SELECT SUM(read_count)::bigint FROM region_read_stats), 0)::bigint AS "RegionReads";
            """);
        Assert.Equal(1, stats.Rows.Count);
        Assert.Equal(0L, Convert.ToInt64(stats.Rows[0]["TotalReads"], CultureInfo.InvariantCulture));
        Assert.Equal(0L, Convert.ToInt64(stats.Rows[0]["ArticleReads"], CultureInfo.InvariantCulture));
        Assert.Equal(0L, Convert.ToInt64(stats.Rows[0]["RegionReads"], CultureInfo.InvariantCulture));
        Assert.Equal(0, await db.Ado.GetIntAsync("SELECT COUNT(1) FROM author_daily_read_stats;"));
    }
}
