using System.Reflection;
using System.Text.Json;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.VisitLog;
using FsusBlog.Server.Tests.TestInfrastructure;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;
using NSubstitute;
using SqlSugar;
using VisitLogEntity = FsusBlog.Server.Entities.VisitLog;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Dependency", "Docker")]
[Collection(nameof(SchemaMigrationPostgresCollectionB))]
public sealed class HumanReadProofPersistencePrivacyTests(PostgresSchemaMigrationFixture fixture)
{
    [Fact]
    public async Task AuthenticatedSubmission_PersistsOnlyAnonymousViewerAndProofDimensions()
    {
        const int userId = 424242;
        await using var harness = HumanReadProofTestHarness.Create();
        HumanReadChallengeResponse challenge = Assert.IsType<HumanReadChallengeResponse>(
            await harness.Service.CreateChallengeAsync(
                harness.CreateAuthenticatedBrowserContext(userId),
                new HumanReadChallengeRequest("article", "article:42", 42)));
        harness.Time.Advance(TimeSpan.FromSeconds(9));

        HumanReadSubmitResponse submit = await harness.Service.SubmitAsync(
            harness.CreateAuthenticatedBrowserContext(userId),
            new HumanReadSubmitRequest(challenge.Token, "article", "article:42", 42, 9000));
        Assert.True(submit.Counted);
        Assert.True(harness.Channel.Reader.TryRead(out VisitLogMessage message));

        Assert.Null(typeof(VisitLogMessage).GetProperty("UserId"));
        Assert.Null(typeof(VisitLogEntity).GetProperty("UserId"));
        Assert.Null(typeof(VisitLogEntity).GetProperty("IP"));

        await using ServiceProvider processorServices = CreateProcessorServices();
        var processor = new VisitLogProcessorService(
            new VisitLogChannel(),
            processorServices,
            NullLogger<VisitLogProcessorService>.Instance);
        var projected = new List<VisitLogEntity>();
        MethodInfo projectMessage = Assert.IsAssignableFrom<MethodInfo>(typeof(VisitLogProcessorService).GetMethod(
            "ProcessSingleMessageCore",
            BindingFlags.Instance | BindingFlags.NonPublic));
        projectMessage.Invoke(processor, [message, projected]);
        VisitLogEntity entity = Assert.Single(projected);

        using SqlSugarClient db = await PostgresSqlSugarTestClient.CreateAsync(fixture);
        PostgresSqlSugarTestClient.InitTables(db, typeof(VisitLogEntity));
        await db.Insertable(entity).ExecuteCommandAsync();
        VisitLogEntity persisted = Assert.Single(await db.Queryable<VisitLogEntity>().ToListAsync());

        Assert.Equal(32, persisted.IpHash.Length);
        Assert.Equal(5, persisted.IpHashKeyEpoch);
        Assert.InRange(persisted.IpHashWindowUtc, 20200101, 20991231);
        Assert.NotEqual(message.IP, persisted.IpHash);
        Assert.Equal(message.ViewerKeyHash, persisted.ViewerKeyHash);
        Assert.Equal(message.ProofId, persisted.ProofId);
        Assert.NotEqual(userId.ToString(System.Globalization.CultureInfo.InvariantCulture), persisted.ViewerKeyHash);
        Assert.NotEqual(userId.ToString(System.Globalization.CultureInfo.InvariantCulture), persisted.ProofId);
        Assert.Equal(HumanReadEventTypes.ArticleRead, persisted.EventType);
        Assert.Equal(42, persisted.ArticleId);

        string persistedJson = JsonSerializer.Serialize(persisted);
        Assert.DoesNotContain("UserId", persistedJson, StringComparison.Ordinal);
        Assert.DoesNotContain(message.IP, persistedJson, StringComparison.Ordinal);
    }

    [Fact]
    public void StatsContracts_SerializeOnlyAggregateReadAndAnonymousViewerDimensions()
    {
        string[] summaryProperties = typeof(StatsSummaryDto)
            .GetProperties(BindingFlags.Public | BindingFlags.Instance)
            .Select(property => property.Name)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();
        string[] podFields = typeof(SiteStatsPod)
            .GetFields(BindingFlags.Public | BindingFlags.Instance)
            .Select(field => field.Name)
            .OrderBy(name => name, StringComparer.Ordinal)
            .ToArray();

        Assert.Contains(nameof(StatsSummaryDto.TotalReads), summaryProperties);
        Assert.Contains(nameof(StatsSummaryDto.HumanVerifiedReads), summaryProperties);
        Assert.Contains(nameof(StatsSummaryDto.UniqueViewerKeyEstimate), summaryProperties);
        Assert.DoesNotContain("UserId", summaryProperties);
        Assert.DoesNotContain("RegisteredVisits", summaryProperties);
        Assert.DoesNotContain("AnonymousVisits", summaryProperties);
        Assert.Contains(nameof(SiteStatsPod.TotalReads), podFields);
        Assert.Contains(nameof(SiteStatsPod.HumanVerifiedReads), podFields);
        Assert.Contains(nameof(SiteStatsPod.UniqueViewerKeyEstimate), podFields);
        Assert.DoesNotContain("UserId", podFields);
        Assert.DoesNotContain("RegisteredVisits", podFields);
        Assert.DoesNotContain("AnonymousVisits", podFields);

        string json = JsonSerializer.Serialize(new StatsSummaryDto
        {
            TotalReads = 3,
            HumanVerifiedReads = 2,
            UniqueViewerKeyEstimate = 2,
            ArticleReads = 2,
            SiteReads = 1
        });
        Assert.Contains("TotalReads", json, StringComparison.Ordinal);
        Assert.Contains("HumanVerifiedReads", json, StringComparison.Ordinal);
        Assert.Contains("UniqueViewerKeyEstimate", json, StringComparison.Ordinal);
        Assert.DoesNotContain("UserId", json, StringComparison.Ordinal);
        Assert.DoesNotContain("RegisteredVisits", json, StringComparison.Ordinal);
        Assert.DoesNotContain("AnonymousVisits", json, StringComparison.Ordinal);
    }

    private static ServiceProvider CreateProcessorServices()
        => new ServiceCollection()
            .AddSingleton<IConfiguration>(new ConfigurationBuilder()
                .AddInMemoryCollection(new Dictionary<string, string?>
                {
                    [VisitLogIpPseudonymizer.CurrentEpochKey] = "5",
                    [VisitLogIpPseudonymizer.CurrentKeyKey] = "EBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8="
                })
                .Build())
            .AddScoped(_ => Substitute.For<ISqlSugarClient>())
            .AddScoped(_ => Substitute.For<IDbConcurrencyGate>())
            .AddScoped(_ => Substitute.For<IArticleViewProjectionService>())
            .AddScoped(_ => Substitute.For<IHotStatsInvalidationCoalescer>())
            .BuildServiceProvider();
}
