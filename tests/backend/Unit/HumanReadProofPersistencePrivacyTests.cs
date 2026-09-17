using System.Reflection;
using System.Text.Json;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Services.VisitLog;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Outputs;

using SqlSugar;
namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class HumanReadProofPersistencePrivacyTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task TwentyArticleReads_PersistOnlyUnorderedHourlyAndDwellAggregates()
    {
        await using var harness = HumanReadProofTestHarness.Create();
        var contributions = new List<VisitLogMessage>();
        for (int articleId = 1; articleId <= 20; articleId++)
        {
            string route = $"article:{articleId}";
            HumanReadChallengeResponse challenge = Assert.IsType<HumanReadChallengeResponse>(
                await harness.Service.CreateChallengeAsync(
                    harness.CreateAuthenticatedBrowserContext(424242),
                    new HumanReadChallengeRequest("article", route, articleId)));
            harness.Time.Advance(TimeSpan.FromSeconds(9));
            HumanReadSubmitResponse submit = await harness.Service.SubmitAsync(
                harness.CreateAuthenticatedBrowserContext(424242),
                new HumanReadSubmitRequest(challenge.Token, "article", route, articleId, 9_000 + articleId));
            Assert.True(submit.Counted);
            Assert.True(harness.Channel.Reader.TryRead(out VisitLogMessage contribution));
            contributions.Add(contribution);
        }

        Assert.All(contributions, static item =>
        {
            Assert.Equal(0, item.AggregateHourUtc.Minute);
            Assert.Equal(0, item.AggregateHourUtc.Second);
            Assert.Equal(ReadDwellBuckets.Under10Seconds, item.DwellBucket);
        });
        Assert.Null(typeof(VisitLogMessage).GetProperty("IP"));
        Assert.Null(typeof(VisitLogMessage).GetProperty("RouteKey"));
        Assert.Null(typeof(VisitLogMessage).GetProperty("ViewerKeyHash"));
        Assert.Null(typeof(VisitLogMessage).GetProperty("ProofId"));
        Assert.Null(typeof(VisitLogMessage).GetProperty("DwellMs"));

        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(
            db,
            typeof(ArticleReadHourlyAggregate),
            typeof(ReadDwellDailyAggregate));
        CreateSharedReadRollups(db);

        await VisitLogProcessorService.PersistAggregatesAsync(db, contributions, CancellationToken.None);

        List<ArticleReadHourlyAggregate> articles = await db.Queryable<ArticleReadHourlyAggregate>()
            .OrderBy(static item => item.ArticleId)
            .ToListAsync();
        Assert.Equal(20, articles.Count);
        Assert.All(articles, static item => Assert.Equal(1, item.ReadCount));
        Assert.Single(articles.Select(static item => item.HourUtc).Distinct());
        ReadDwellDailyAggregate dwell = Assert.Single(await db.Queryable<ReadDwellDailyAggregate>().ToListAsync());
        Assert.Equal(ReadDwellBuckets.Under10Seconds, dwell.DwellBucket);
        Assert.Equal(20, dwell.ReadCount);

        string persistedJson = JsonSerializer.Serialize(new
        {
            articles,
            dwell
        });
        Assert.DoesNotContain("424242", persistedJson, StringComparison.Ordinal);
        Assert.DoesNotContain("article:", persistedJson, StringComparison.Ordinal);
        Assert.DoesNotContain("Viewer", persistedJson, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Proof", persistedJson, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Route", persistedJson, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void StatsContracts_KeepCompatibilityFieldButCannotExposeViewerIdentity()
    {
        string[] summaryProperties = typeof(StatsSummaryDto)
            .GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Select(static property => property.Name)
            .OrderBy(static name => name, StringComparer.Ordinal)
            .ToArray();
        string[] podFields = typeof(SiteStatsPod)
            .GetFields(BindingFlags.Public | BindingFlags.Instance)
            .Select(static field => field.Name)
            .OrderBy(static name => name, StringComparer.Ordinal)
            .ToArray();

        Assert.Contains(nameof(StatsSummaryDto.UniqueViewerKeyEstimate), summaryProperties);
        Assert.Contains(nameof(SiteStatsPod.UniqueViewerKeyEstimate), podFields);
        Assert.DoesNotContain("UserId", summaryProperties);
        Assert.DoesNotContain("ViewerKey", typeof(VisitLogMessage).GetProperties().Select(static property => property.Name));

        string json = JsonSerializer.Serialize(new StatsSummaryDto
        {
            TotalReads = 3,
            HumanVerifiedReads = 3,
            UniqueViewerKeyEstimate = 0,
            ArticleReads = 2,
            SiteReads = 1
        });
        Assert.Contains("\"UniqueViewerKeyEstimate\":0", json, StringComparison.Ordinal);
        Assert.DoesNotContain("UserId", json, StringComparison.Ordinal);
    }

    private static void CreateSharedReadRollups(SqlSugarClient db)
        => db.Ado.ExecuteCommand("""
            CREATE TABLE daily_read_stats (
                stat_date date PRIMARY KEY,
                total_reads bigint NOT NULL DEFAULT 0,
                human_verified_reads bigint NOT NULL DEFAULT 0,
                unique_viewer_estimate bigint NOT NULL DEFAULT 0,
                updated_at_utc timestamp without time zone NOT NULL
            );
            CREATE TABLE event_type_read_stats (
                event_type text PRIMARY KEY,
                read_count bigint NOT NULL DEFAULT 0,
                updated_at_utc timestamp without time zone NOT NULL
            );
            """);
}
