using System.Text.Json;

using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Services.Background;
using FsusBlog.Server.Services.Security;

using Microsoft.Extensions.Configuration;
namespace FsusBlog.Server.Tests.Unit;

public sealed class AntiCrawlerPolicyBehaviorTests
{
    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void AtomicSnapshotWrite_ReplacesCompleteJsonAndLeavesNoTemporaryFile()
    {
        string directory = Path.Combine(Path.GetTempPath(), $"fsus-crawler-snapshot-{Guid.NewGuid():N}");
        Directory.CreateDirectory(directory);
        try
        {
            string path = Path.Combine(directory, "crawler-ranges.snapshot.json");
            File.WriteAllText(path, "{\"stale\":true}");
            string json = """
                {"Google":["66.249.64.0/19"],"Bing":["40.77.167.0/24"],"SavedAt":"2026-06-25T00:00:00+00:00"}
                """;

            CrawlerUpdateWorker.WriteSnapshotAtomically(path, json);

            using JsonDocument document = JsonDocument.Parse(File.ReadAllText(path));
            Assert.Equal("66.249.64.0/19", document.RootElement.GetProperty("Google")[0].GetString());
            Assert.Equal("40.77.167.0/24", document.RootElement.GetProperty("Bing")[0].GetString());
            Assert.Empty(Directory.GetFiles(directory, "*.tmp"));
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Theory]
    [InlineData("http://developers.google.com/static/search/apis/ipranges/googlebot.json")]
    [InlineData("https://internal-admin/api/secrets")]
    [InlineData("https://169.254.169.254/latest/meta-data/")]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "anticrawler-unsafe-provider-url-reject")]
    public void UpdateAntiCrawlerOptions_RejectsUnsafeProviderUrls(string configured)
    {
        var service = new SecurityAdminPolicyService(CurrentRiskPolicyTestConfiguration.WithCurrentRiskPolicy(new ConfigurationBuilder().Build()));

        Assert.Throws<ArgumentException>(() =>
            service.UpdateAntiCrawlerOptions(CreateUpdate(googleUrl: configured), "test"));
    }

    [Theory]
    [InlineData("../crawler-ranges.snapshot.json")]
    [InlineData("/tmp/fsus-crawler-ranges.snapshot.json")]
    [InlineData("nested/../../crawler-ranges.snapshot.json")]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "anticrawler-snapshot-path-outside-root-reject")]
    public void UpdateAntiCrawlerOptions_RejectsSnapshotPathsOutsideDataRoot(string configured)
    {
        var service = new SecurityAdminPolicyService(CurrentRiskPolicyTestConfiguration.WithCurrentRiskPolicy(new ConfigurationBuilder().Build()));

        Assert.Throws<ArgumentException>(() =>
            service.UpdateAntiCrawlerOptions(CreateUpdate(snapshotPath: configured), "test"));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void UpdateAntiCrawlerOptions_AcceptsOfficialProvidersAndRelativeSnapshotPath()
    {
        var service = new SecurityAdminPolicyService(CurrentRiskPolicyTestConfiguration.WithCurrentRiskPolicy(new ConfigurationBuilder().Build()));

        AntiCrawlerPolicySnapshot snapshot = service.UpdateAntiCrawlerOptions(
            CreateUpdate(
                googleUrl: "https://developers.google.com/static/search/apis/ipranges/googlebot.json",
                bingUrl: "https://www.bing.com/toolbox/bingbot.json",
                snapshotPath: "crawler/last-known-good.json"),
            "test");

        Assert.Equal("https://developers.google.com/static/search/apis/ipranges/googlebot.json", snapshot.Options.GoogleCrawlerRangesUrl);
        Assert.Equal("https://www.bing.com/toolbox/bingbot.json", snapshot.Options.BingCrawlerRangesUrl);
        Assert.Equal("crawler/last-known-good.json", snapshot.Options.SnapshotPath);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Boundary)]
    public void ListRiskEvents_ClampsUntrustedLimitsAtPublicServiceBoundary()
    {
        var service = new SecurityAdminPolicyService(CurrentRiskPolicyTestConfiguration.WithCurrentRiskPolicy(new ConfigurationBuilder().Build()));
        for (int index = 0; index < 513; index++)
        {
            service.RecordRiskEvent(new AntiCrawlerRiskEventResponse(
                $"event-{index}",
                DateTimeOffset.Parse("2026-07-11T08:00:00Z").AddSeconds(index),
                SecurityRiskSources.AntiCrawler,
                "test",
                "observe",
                1,
                index,
                "ip-hash",
                "/article/42",
                "GET",
                "unit-test",
                null));
        }

        Assert.Single(service.ListRiskEvents(limit: int.MinValue));
        Assert.Equal(512, service.ListRiskEvents(limit: int.MaxValue).Count);
    }

    private static AntiCrawlerOptionsUpdateRequest CreateUpdate(
        string? googleUrl = null,
        string? bingUrl = null,
        string? snapshotPath = null)
        => new(
            Mode: null,
            PublicReadChallengeEnabled: null,
            SearchCrawlerVerificationEnabled: null,
            SocialPreviewGuardEnabled: null,
            RiskScoringEnabled: null,
            EventPersistenceEnabled: null,
            DashboardAggregationEnabled: null,
            CidrAutoUpdateEnabled: null,
            IllegalPathHardAbortEnabled: null,
            RequireChallengeScore: null,
            BlockScore: null,
            MaxRiskScore: null,
            DefaultRiskTtlSeconds: null,
            FixedIpPermitLimit: null,
            FixedIpQueueLimit: null,
            VerifiedCrawlerFixedIpPermitLimit: null,
            PublicReadPermitLimit: null,
            PublicReadQueueLimit: null,
            VerifiedCrawlerPublicReadPermitLimit: null,
            SocialPreviewPublicReadPermitLimit: null,
            ReadProofPermitLimit: null,
            CidrUpdateIntervalMinutes: null,
            CidrInitialDelaySeconds: null,
            CidrMinUpdateIntervalMinutes: null,
            GoogleCrawlerRangesUrl: googleUrl,
            BingCrawlerRangesUrl: bingUrl,
            SnapshotPath: snapshotPath,
            SocialPreviewAllowedPathPrefixes: null,
            BlockedUserAgentKeywords: null,
            Reason: "test");
}
