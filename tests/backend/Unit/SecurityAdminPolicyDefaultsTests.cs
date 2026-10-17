using Microsoft.Extensions.Configuration;

using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Services.Security;

using Microsoft.Extensions.Configuration;

using ConfigurationBuilder = Microsoft.Extensions.Configuration.ConfigurationBuilder;
using IConfiguration = Microsoft.Extensions.Configuration.IConfiguration;

namespace FsusBlog.Server.Tests.Unit;

public sealed class SecurityAdminPolicyDefaultsTests
{
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void Constructor_SeedsExactDefaultAntiCrawlerRules()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());

        Dictionary<string, AntiCrawlerRuleResponse> rules = service.ListRules()
            .ToDictionary(rule => rule.Id, StringComparer.Ordinal);

        Assert.Equal(4, rules.Count);
        AssertRule(
            rules["fake-crawler"],
            "伪造搜索引擎爬虫",
            "user-agent",
            "Googlebot|bingbot|Baiduspider|Sogou",
            30,
            "搜索引擎 UA 必须通过 CIDR 或 DNS 验证。");
        AssertRule(
            rules["unknown-bot"],
            "未知 bot UA",
            "user-agent",
            "bot|spider|crawler",
            15,
            "未知 bot 默认进入反爬处置。");
        AssertRule(
            rules["tool-user-agent"],
            "工具型 User-Agent",
            "user-agent",
            "python|curl|wget|httpclient|zgrab",
            10,
            "工具型 UA 默认拒绝公开热路径。");
        AssertRule(
            rules["social-preview-scope"],
            "社交预览范围保护",
            "path",
            "/api",
            10,
            "社交预览 bot 不允许访问 API。");

        static void AssertRule(
            AntiCrawlerRuleResponse rule,
            string name,
            string matchType,
            string pattern,
            int score,
            string notes)
        {
            Assert.Equal(name, rule.Name);
            Assert.True(rule.Enabled);
            Assert.Equal(matchType, rule.MatchType);
            Assert.Equal(pattern, rule.Pattern);
            Assert.Equal("block", rule.Action);
            Assert.Equal(score, rule.Score);
            Assert.Equal(notes, rule.Notes);
            Assert.Equal("configuration", rule.UpdatedBy);
        }
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void Constructor_SeedsPolicySnapshotsWithConfigurationProvenance()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());

        Assert.StartsWith("anti-crawler-", service.Current.SnapshotId, StringComparison.Ordinal);
        Assert.Equal("configuration", service.Current.UpdatedBy);
        Assert.Equal("startup", service.Current.Reason);

        Assert.StartsWith("pow-", service.CurrentPow.SnapshotId, StringComparison.Ordinal);
        Assert.Equal("configuration", service.CurrentPow.UpdatedBy);
        Assert.Equal("startup", service.CurrentPow.Reason);

        Assert.StartsWith("perception-v2-", service.CurrentPerceptionSealedV2.SnapshotId, StringComparison.Ordinal);
        Assert.StartsWith("perception-v2-policy-", service.CurrentPerceptionSealedV2.PolicyVersion, StringComparison.Ordinal);
        Assert.Equal("configuration", service.CurrentPerceptionSealedV2.UpdatedBy);
        Assert.Equal("startup", service.CurrentPerceptionSealedV2.Reason);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void Constructor_UsesExactDefaultAntiCrawlerOptions()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());
        AntiCrawlerPolicyOptions options = service.Current.Options;

        Assert.Equal("enforce", options.Mode);
        Assert.True(options.PublicReadChallengeEnabled);
        Assert.True(options.SearchCrawlerVerificationEnabled);
        Assert.True(options.SocialPreviewGuardEnabled);
        Assert.True(options.RiskScoringEnabled);
        Assert.True(options.EventPersistenceEnabled);
        Assert.True(options.DashboardAggregationEnabled);
        Assert.True(options.CidrAutoUpdateEnabled);
        Assert.True(options.IllegalPathHardAbortEnabled);
        Assert.Equal(50, options.RequireChallengeScore);
        Assert.Equal(100, options.BlockScore);
        Assert.Equal(200, options.MaxRiskScore);
        Assert.Equal(600, options.DefaultRiskTtlSeconds);
        Assert.Equal(100, options.FixedIpPermitLimit);
        Assert.Equal(2, options.FixedIpQueueLimit);
        Assert.Equal(1000, options.VerifiedCrawlerFixedIpPermitLimit);
        Assert.Equal(120, options.PublicReadPermitLimit);
        Assert.Equal(2, options.PublicReadQueueLimit);
        Assert.Equal(1000, options.VerifiedCrawlerPublicReadPermitLimit);
        Assert.Equal(30, options.SocialPreviewPublicReadPermitLimit);
        Assert.Equal(30, options.ReadProofPermitLimit);
        Assert.Equal(1440, options.CidrUpdateIntervalMinutes);
        Assert.Equal(0, options.CidrInitialDelaySeconds);
        Assert.Equal(30, options.CidrMinUpdateIntervalMinutes);
        Assert.Equal(
            "https://developers.google.com/static/search/apis/ipranges/googlebot.json",
            options.GoogleCrawlerRangesUrl);
        Assert.Equal("https://www.bing.com/toolbox/bingbot.json", options.BingCrawlerRangesUrl);
        Assert.Null(options.SnapshotPath);
        Assert.Equal(
            ["/", "/article/", "/assets/", "/uploads/", "/favicon.ico", "/robots.txt"],
            options.SocialPreviewAllowedPathPrefixes);
        Assert.Equal(
            ["python", "java", "curl", "wget", "httpclient", "axios", "go-http-client", "censys", "zgrab"],
            options.BlockedUserAgentKeywords);
        Assert.Equal("security.pow", options.SecurityChallengeReference);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void Constructor_UsesExactDefaultPowOptions()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());
        PowPolicyOptions options = service.CurrentPow.Options;

        Assert.Equal("enforce", options.Mode);
        Assert.Equal(4, options.DefaultDifficulty);
        Assert.True(options.AdaptiveDifficultyEnabled);
        Assert.Equal(300, options.ProofTtlSeconds);
        Assert.True(options.ReplayProtectionEnabled);
        Assert.True(options.RiskScoreLinkEnabled);
        Assert.Equal("/api/binary/auth/pow-challenge", options.ChallengeEndpoint);
        Assert.Equal("RedisPowService", options.VerificationStrategy);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void Constructor_UsesExactDefaultPerceptionV2Options()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());
        PerceptionSealedV2PolicyOptions options = service.CurrentPerceptionSealedV2.Options;

        Assert.True(options.Enabled);
        Assert.True(options.LocalizationEnabled);
        Assert.False(options.MicroInteractionEnabled);
        Assert.False(options.PoSpaceFallbackEnabled);
        Assert.Equal(90, options.EarlyRejectThreshold);
        Assert.Equal(3, options.MaxAttempts);
        Assert.Equal(750, options.MinSolveDurationMs);
        Assert.Equal(60_000, options.MaxSolveDurationMs);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void Constructor_ReadsAntiCrawlerOptionsFromConfiguration()
    {
        IConfiguration configuration = BuildConfiguration(
            ("AntiCrawler:Mode", "observe"),
            ("Security:AntiCrawler:Mode", "lockdown"),
            ("AntiCrawler:PublicReadChallengeEnabled", "false"),
            ("AntiCrawler:SearchCrawlerVerificationEnabled", "false"),
            ("AntiCrawler:SocialPreviewGuardEnabled", "false"),
            ("AntiCrawler:RiskScoringEnabled", "false"),
            ("AntiCrawler:EventPersistenceEnabled", "false"),
            ("AntiCrawler:DashboardAggregationEnabled", "false"),
            ("Security:CrawlerCidrs:Enabled", "false"),
            ("AntiCrawler:IllegalPathHardAbortEnabled", "false"),
            ("Security:Risk:RequireChallengeScore", "77"),
            ("Security:Risk:BlockScore", "88"),
            ("Security:Risk:MaxRiskScore", "99"),
            ("Security:Risk:DefaultRiskTtlSeconds", "1234"),
            ("RateLimiting:FixedIpPermitLimit", "555"),
            ("RateLimiting:FixedIpQueueLimit", "7"),
            ("RateLimiting:VerifiedCrawlerFixedIpPermitLimit", "2222"),
            ("RateLimiting:PublicReadPermitLimit", "333"),
            ("RateLimiting:PublicReadQueueLimit", "9"),
            ("RateLimiting:VerifiedCrawlerPublicReadPermitLimit", "4444"),
            ("RateLimiting:SocialPreviewPublicReadPermitLimit", "66"),
            ("RateLimiting:ReadProofPermitLimit", "44"),
            ("Security:CrawlerCidrs:MinUpdateIntervalMinutes", "120"),
            ("Security:CrawlerCidrs:UpdateIntervalMinutes", "600"),
            ("Security:CrawlerCidrs:InitialDelaySeconds", "45"),
            ("Security:CrawlerCidrs:GoogleUrl", "https://developers.google.com/custom/google-ranges.json"),
            ("Security:CrawlerCidrs:BingUrl", "https://www.bing.com/custom/bing-ranges.json"),
            ("Security:CrawlerCidrs:SnapshotPath", "crawler/custom.snapshot.json"),
            ("AntiCrawler:SocialPreviewAllowedPathPrefixes", "/public/, /feed/"),
            ("AntiCrawler:BlockedUserAgentKeywords", "scrapy, megacrawler"));

        var service = new SecurityAdminPolicyService(configuration);
        AntiCrawlerPolicyOptions options = service.Current.Options;

        Assert.Equal("observe", options.Mode);
        Assert.False(options.PublicReadChallengeEnabled);
        Assert.False(options.SearchCrawlerVerificationEnabled);
        Assert.False(options.SocialPreviewGuardEnabled);
        Assert.False(options.RiskScoringEnabled);
        Assert.False(options.EventPersistenceEnabled);
        Assert.False(options.DashboardAggregationEnabled);
        Assert.False(options.CidrAutoUpdateEnabled);
        Assert.False(options.IllegalPathHardAbortEnabled);
        Assert.Equal(77, options.RequireChallengeScore);
        Assert.Equal(88, options.BlockScore);
        Assert.Equal(99, options.MaxRiskScore);
        Assert.Equal(1234, options.DefaultRiskTtlSeconds);
        Assert.Equal(555, options.FixedIpPermitLimit);
        Assert.Equal(7, options.FixedIpQueueLimit);
        Assert.Equal(2222, options.VerifiedCrawlerFixedIpPermitLimit);
        Assert.Equal(333, options.PublicReadPermitLimit);
        Assert.Equal(9, options.PublicReadQueueLimit);
        Assert.Equal(4444, options.VerifiedCrawlerPublicReadPermitLimit);
        Assert.Equal(66, options.SocialPreviewPublicReadPermitLimit);
        Assert.Equal(44, options.ReadProofPermitLimit);
        Assert.Equal(600, options.CidrUpdateIntervalMinutes);
        Assert.Equal(45, options.CidrInitialDelaySeconds);
        Assert.Equal(120, options.CidrMinUpdateIntervalMinutes);
        Assert.Equal("https://developers.google.com/custom/google-ranges.json", options.GoogleCrawlerRangesUrl);
        Assert.Equal("https://www.bing.com/custom/bing-ranges.json", options.BingCrawlerRangesUrl);
        Assert.Equal("crawler/custom.snapshot.json", options.SnapshotPath);
        Assert.Equal(["/public/", "/feed/"], options.SocialPreviewAllowedPathPrefixes);
        Assert.Equal(["scrapy", "megacrawler"], options.BlockedUserAgentKeywords);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Boundary)]
    [Fact]
    public void Constructor_CidrUpdateIntervalNeverDropsBelowMinimum()
    {
        IConfiguration configuration = BuildConfiguration(
            ("Security:CrawlerCidrs:MinUpdateIntervalMinutes", "120"),
            ("Security:CrawlerCidrs:UpdateIntervalMinutes", "60"));

        var service = new SecurityAdminPolicyService(configuration);

        Assert.Equal(120, service.Current.Options.CidrUpdateIntervalMinutes);
        Assert.Equal(120, service.Current.Options.CidrMinUpdateIntervalMinutes);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void Constructor_AntiCrawlerModeFallsBackToSecurityKey()
    {
        IConfiguration configuration = BuildConfiguration(
            ("Security:AntiCrawler:Mode", "observe"));

        var service = new SecurityAdminPolicyService(configuration);

        Assert.Equal("observe", service.Current.Options.Mode);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void Constructor_ReadsPowOptionsFromConfiguration()
    {
        IConfiguration configuration = BuildConfiguration(
            ("Pow:Mode", "observe"),
            ("Pow:DefaultDifficulty", "9"),
            ("Pow:AdaptiveDifficultyEnabled", "false"),
            ("Pow:ProofTtlSeconds", "900"),
            ("Pow:ReplayProtectionEnabled", "false"),
            ("Pow:RiskScoreLinkEnabled", "false"));

        var service = new SecurityAdminPolicyService(configuration);
        PowPolicyOptions options = service.CurrentPow.Options;

        Assert.Equal("observe", options.Mode);
        Assert.Equal(9, options.DefaultDifficulty);
        Assert.False(options.AdaptiveDifficultyEnabled);
        Assert.Equal(900, options.ProofTtlSeconds);
        Assert.False(options.ReplayProtectionEnabled);
        Assert.False(options.RiskScoreLinkEnabled);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void Constructor_ReadsPerceptionV2OptionsFromConfiguration()
    {
        IConfiguration configuration = BuildConfiguration(
            ("Security:PerceptionV2:Enabled", "false"),
            ("Security:PerceptionV2:Localization:Enabled", "false"),
            ("Security:PerceptionV2:MicroInteraction:Enabled", "true"),
            ("Security:PerceptionV2:PoSpaceFallback:Enabled", "true"),
            ("Security:PerceptionV2:EarlyRejectThreshold", "75"),
            ("Security:PerceptionV2:MaxAttempts", "7"),
            ("Security:PerceptionV2:MinSolveDurationMs", "1250"),
            ("Security:PerceptionV2:MaxSolveDurationMs", "120000"));

        var service = new SecurityAdminPolicyService(configuration);
        PerceptionSealedV2PolicyOptions options = service.CurrentPerceptionSealedV2.Options;

        Assert.False(options.Enabled);
        Assert.False(options.LocalizationEnabled);
        Assert.True(options.MicroInteractionEnabled);
        Assert.True(options.PoSpaceFallbackEnabled);
        Assert.Equal(75, options.EarlyRejectThreshold);
        Assert.Equal(7, options.MaxAttempts);
        Assert.Equal(1250, options.MinSolveDurationMs);
        Assert.Equal(120_000, options.MaxSolveDurationMs);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void ListRiskEvents_ReturnsNewestFirstAcrossRingBufferWraparound()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());
        DateTimeOffset baseTime = DateTimeOffset.Parse("2026-07-11T08:00:00Z");
        for (int index = 0; index < 600; index++)
        {
            service.RecordRiskEvent(new AntiCrawlerRiskEventResponse(
                $"event-{index}",
                baseTime.AddSeconds(index),
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

        IReadOnlyList<AntiCrawlerRiskEventResponse> events = service.ListRiskEvents(limit: 512);

        Assert.Equal(512, events.Count);
        Assert.Equal("event-599", events[0].Id);
        Assert.Equal("event-598", events[1].Id);
        Assert.Equal("event-88", events[^1].Id);
        for (int index = 0; index < events.Count - 1; index++)
        {
            Assert.True(
                events[index].OccurredAtUtc > events[index + 1].OccurredAtUtc,
                $"event order broken at index {index}");
        }
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void ListRiskEvents_FiltersBySourceAndReason()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());
        DateTimeOffset baseTime = DateTimeOffset.Parse("2026-07-11T08:00:00Z");
        RecordEvent(service, "keep-1", baseTime, SecurityRiskSources.AntiCrawler, "policy");
        RecordEvent(service, "drop-source", baseTime.AddSeconds(1), SecurityRiskSources.PublicRead, "policy");
        RecordEvent(service, "drop-reason", baseTime.AddSeconds(2), SecurityRiskSources.AntiCrawler, "abuse");
        RecordEvent(service, "keep-2", baseTime.AddSeconds(3), SecurityRiskSources.AntiCrawler, "policy");

        IReadOnlyList<AntiCrawlerRiskEventResponse> filtered =
            service.ListRiskEvents(SecurityRiskSources.AntiCrawler, "policy");

        Assert.Equal(["keep-2", "keep-1"], filtered.Select(item => item.Id).ToArray());
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void Simulate_CoversAllMatchTypeBranchesAndCrawlerDetection()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());
        service.AddRule(new AntiCrawlerRuleRequest("ip-rule", true, "ip", "10.0.0.1", "block", 50, null), "test");
        service.AddRule(new AntiCrawlerRuleRequest("path-rule", true, "path", "/admin", "block", 50, null), "test");
        service.AddRule(new AntiCrawlerRuleRequest("method-rule", true, "method", "POST", "block", 50, null), "test");
        service.AddRule(new AntiCrawlerRuleRequest("ua-rule", true, "user-agent", "python|curl", "block", 50, null), "test");

        AntiCrawlerSimulationResult ipHit = service.Simulate(new AntiCrawlerSimulationRequest("GET", "/", "Mozilla", "10.0.0.1", null, 0));
        Assert.Contains("ip-rule:block", ipHit.MatchedRules);

        AntiCrawlerSimulationResult pathHit = service.Simulate(new AntiCrawlerSimulationRequest("GET", "/admin", "Mozilla", "1.2.3.4", null, 0));
        Assert.Contains("path-rule:block", pathHit.MatchedRules);

        AntiCrawlerSimulationResult methodHit = service.Simulate(new AntiCrawlerSimulationRequest("POST", "/", "Mozilla", "1.2.3.4", null, 0));
        Assert.Contains("method-rule:block", methodHit.MatchedRules);

        AntiCrawlerSimulationResult uaHit = service.Simulate(new AntiCrawlerSimulationRequest("GET", "/", "python", "1.2.3.4", null, 0));
        Assert.Contains("ua-rule:block", uaHit.MatchedRules);

        AntiCrawlerSimulationResult tokenHit = service.Simulate(new AntiCrawlerSimulationRequest("GET", "/", "curl/8.0", "1.2.3.4", null, 0));
        Assert.Contains("ua-rule:block", tokenHit.MatchedRules);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void Simulate_DetectsSearchCrawlerAndSocialPreviewUserAgents()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());

        Assert.True(service.Simulate(new AntiCrawlerSimulationRequest("GET", "/", "Googlebot/2.1", "1.2.3.4", null, 0)).WouldVerifyCrawler);
        Assert.True(service.Simulate(new AntiCrawlerSimulationRequest("GET", "/", "bingbot/2.0", "1.2.3.4", null, 0)).WouldVerifyCrawler);
        Assert.True(service.Simulate(new AntiCrawlerSimulationRequest("GET", "/", "Baiduspider", "1.2.3.4", null, 0)).WouldVerifyCrawler);
        Assert.True(service.Simulate(new AntiCrawlerSimulationRequest("GET", "/", "Sogou", "1.2.3.4", null, 0)).WouldVerifyCrawler);
        Assert.True(service.Simulate(new AntiCrawlerSimulationRequest("GET", "/", "Google-InspectionTool", "1.2.3.4", null, 0)).WouldVerifyCrawler);
        Assert.True(service.Simulate(new AntiCrawlerSimulationRequest("GET", "/", "msnbot", "1.2.3.4", null, 0)).WouldVerifyCrawler);

        Assert.True(service.Simulate(new AntiCrawlerSimulationRequest("GET", "/", "Twitterbot/1.0", "1.2.3.4", null, 0)).WouldApplySocialPreviewGuard);
        Assert.True(service.Simulate(new AntiCrawlerSimulationRequest("GET", "/", "facebookexternalhit", "1.2.3.4", null, 0)).WouldApplySocialPreviewGuard);
        Assert.True(service.Simulate(new AntiCrawlerSimulationRequest("GET", "/", "Discordbot", "1.2.3.4", null, 0)).WouldApplySocialPreviewGuard);
        Assert.True(service.Simulate(new AntiCrawlerSimulationRequest("GET", "/", "Slackbot", "1.2.3.4", null, 0)).WouldApplySocialPreviewGuard);
        Assert.True(service.Simulate(new AntiCrawlerSimulationRequest("GET", "/", "TelegramBot", "1.2.3.4", null, 0)).WouldApplySocialPreviewGuard);
        Assert.True(service.Simulate(new AntiCrawlerSimulationRequest("GET", "/", "LinkedInBot", "1.2.3.4", null, 0)).WouldApplySocialPreviewGuard);
        Assert.True(service.Simulate(new AntiCrawlerSimulationRequest("GET", "/", "WhatsApp", "1.2.3.4", null, 0)).WouldApplySocialPreviewGuard);

        Assert.False(service.Simulate(new AntiCrawlerSimulationRequest("GET", "/", "Mozilla/5.0", "1.2.3.4", null, 0)).WouldVerifyCrawler);
        Assert.False(service.Simulate(new AntiCrawlerSimulationRequest("GET", "/", "Mozilla/5.0", "1.2.3.4", null, 0)).WouldApplySocialPreviewGuard);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Boundary)]
    [Fact]
    public void Simulate_DisabledModeAllowsAllAndObserveModeReportsMatchedRules()
    {
        var service = new SecurityAdminPolicyService(BuildConfiguration(("AntiCrawler:Mode", "disabled")));
        service.AddRule(new AntiCrawlerRuleRequest("block-rule", true, "user-agent", "python", "block", 100, null), "test");

        AntiCrawlerSimulationResult disabledResult = service.Simulate(new AntiCrawlerSimulationRequest("GET", "/", "python", "1.2.3.4", null, 0));
        Assert.Equal("disabled_allow", disabledResult.FinalAction);

        var observeService = new SecurityAdminPolicyService(BuildConfiguration(("AntiCrawler:Mode", "observe")));
        observeService.AddRule(new AntiCrawlerRuleRequest("block-rule", true, "user-agent", "python", "block", 100, null), "test");

        AntiCrawlerSimulationResult observeResult = observeService.Simulate(new AntiCrawlerSimulationRequest("GET", "/", "python", "1.2.3.4", null, 0));
        Assert.Equal("observe", observeResult.FinalAction);

        AntiCrawlerSimulationResult observeNoMatch = observeService.Simulate(new AntiCrawlerSimulationRequest("GET", "/", "Mozilla", "1.2.3.4", null, 0));
        Assert.Equal("allow", observeNoMatch.FinalAction);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void Simulate_AllowlistedEntryOverridesBlocklistInEnforceMode()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());
        service.AddEntry("block", new AntiCrawlerListEntryRequest("1.2.3.4", "ip", "test", true), "test");
        service.AddEntry("allow", new AntiCrawlerListEntryRequest("1.2.3.4", "ip", "test", true), "test");

        AntiCrawlerSimulationResult result = service.Simulate(new AntiCrawlerSimulationRequest("GET", "/", "Mozilla", "1.2.3.4", null, 0));
        Assert.Equal("allow", result.FinalAction);
        Assert.Contains("allow:1.2.3.4", result.MatchedLists);
        Assert.Contains("block:1.2.3.4", result.MatchedLists);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void Simulate_BlocklistedEntryBlocksInEnforceMode()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());
        service.AddEntry("block", new AntiCrawlerListEntryRequest("1.2.3.4", "ip", "test", true), "test");

        AntiCrawlerSimulationResult result = service.Simulate(new AntiCrawlerSimulationRequest("GET", "/", "Mozilla", "1.2.3.4", null, 0));
        Assert.Equal("block", result.FinalAction);
        Assert.True(result.WouldBlock);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void Simulate_RequireChallengeWhenScoreBetweenThresholds()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());
        service.AddRule(new AntiCrawlerRuleRequest("risky", true, "user-agent", "custom-test-agent", "challenge", 55, null), "test");

        AntiCrawlerSimulationResult result = service.Simulate(new AntiCrawlerSimulationRequest("GET", "/", "custom-test-agent", "1.2.3.4", null, 0));
        Assert.Equal("require_challenge", result.FinalAction);
        Assert.True(result.WouldRequireChallenge);
        Assert.False(result.WouldBlock);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void AddRule_NormalizesMatchTypeAndActionAndClampsScore()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());

        AntiCrawlerRuleResponse rule = service.AddRule(
            new AntiCrawlerRuleRequest("Test", true, "IP", "10.0.0.1", "BLOCK", 250, "notes"), "tester");

        Assert.Equal("ip", rule.MatchType);
        Assert.Equal("block", rule.Action);
        Assert.Equal(100, rule.Score);
        Assert.Equal("tester", rule.UpdatedBy);
        Assert.Equal("notes", rule.Notes);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void UpdateRule_ModifiesExistingRuleWithNormalizedFields()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());
        AntiCrawlerRuleResponse original = service.AddRule(
            new AntiCrawlerRuleRequest("Test", true, "path", "/old", "block", 10, null), "tester");

        AntiCrawlerRuleResponse? updated = service.UpdateRule(original.Id,
            new AntiCrawlerRuleRequest("Updated", false, "METHOD", "/new", "challenge", -5, null), "updater");

        Assert.NotNull(updated);
        Assert.Equal("Updated", updated!.Name);
        Assert.False(updated.Enabled);
        Assert.Equal("method", updated.MatchType);
        Assert.Equal("require_challenge", updated.Action);
        Assert.Equal(0, updated.Score);
        Assert.Equal("updater", updated.UpdatedBy);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative, InvariantId = "update-rule-not-found")]
    [Fact]
    public void UpdateRule_ReturnsNullForUnknownId()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());
        Assert.Null(service.UpdateRule("nonexistent",
            new AntiCrawlerRuleRequest("Test", true, "ip", "1.2.3.4", "block", 10, null), "tester"));
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void DeleteRule_RemovesExistingRule()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());
        AntiCrawlerRuleResponse rule = service.AddRule(
            new AntiCrawlerRuleRequest("Temp", true, "ip", "1.2.3.4", "block", 10, null), "tester");

        Assert.True(service.DeleteRule(rule.Id));
        Assert.DoesNotContain(service.ListRules(), r => r.Id == rule.Id);
        Assert.False(service.DeleteRule(rule.Id));
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void ListEntries_ReturnsCorrectListByType()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());
        service.AddEntry("allow", new AntiCrawlerListEntryRequest("10.0.0.1", "ip", "trusted", true), "tester");
        service.AddEntry("block", new AntiCrawlerListEntryRequest("10.0.0.2", "ip", "blocked", true), "tester");

        Assert.Contains(service.ListEntries("allow"), e => e.Value == "10.0.0.1");
        Assert.Contains(service.ListEntries("block"), e => e.Value == "10.0.0.2");
        Assert.Contains(service.ListEntries("allowlist"), e => e.Value == "10.0.0.1");
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void UpdateAntiCrawlerOptions_NormalizesPathPrefixesAndKeywords()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());

        AntiCrawlerPolicySnapshot updated = service.UpdateAntiCrawlerOptions(
            new AntiCrawlerOptionsUpdateRequest(
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
                GoogleCrawlerRangesUrl: null,
                BingCrawlerRangesUrl: null,
                SnapshotPath: null,
                SocialPreviewAllowedPathPrefixes: ["api", "  feed  ", ""],
                BlockedUserAgentKeywords: ["  scrapy  ", "", "megacrawler"],
                Reason: "tester"),
            "tester");

        Assert.Equal(["/api", "/feed"], updated.Options.SocialPreviewAllowedPathPrefixes);
        Assert.Equal(["scrapy", "megacrawler"], updated.Options.BlockedUserAgentKeywords);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void ListRiskSnapshots_OrdersByScoreThenUpdatedAt()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());
        DateTimeOffset baseTime = DateTimeOffset.Parse("2026-07-11T08:00:00Z");

        service.UpsertRiskSnapshot(new SecurityRiskSnapshotResponse("low", 10, "test", "anti-crawler", baseTime, baseTime.AddHours(1)));
        service.UpsertRiskSnapshot(new SecurityRiskSnapshotResponse("high", 90, "test", "anti-crawler", baseTime.AddSeconds(1), baseTime.AddHours(1)));
        service.UpsertRiskSnapshot(new SecurityRiskSnapshotResponse("mid", 50, "test", "anti-crawler", baseTime.AddSeconds(2), baseTime.AddHours(1)));

        IReadOnlyList<SecurityRiskSnapshotResponse> snapshots = service.ListRiskSnapshots(10);

        Assert.Equal(3, snapshots.Count);
        Assert.Equal("high", snapshots[0].Subject);
        Assert.Equal("mid", snapshots[1].Subject);
        Assert.Equal("low", snapshots[2].Subject);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void RollbackAntiCrawlerOptions_RevertsToPreviousSnapshot()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());
        string originalMode = service.Current.Options.Mode;

        service.UpdateAntiCrawlerOptions(
            new AntiCrawlerOptionsUpdateRequest(
                "observe", null, null, null, null, null, null, null, null,
                null, null, null, null, null, null, null, null, null, null, null, null,
                null, null, null, null, null, null, null, null, null),
            "tester");

        Assert.Equal("observe", service.Current.Options.Mode);

        AntiCrawlerPolicySnapshot rolled = service.RollbackAntiCrawlerOptions("tester");
        Assert.Equal(originalMode, rolled.Options.Mode);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void RollbackPowOptions_RevertsToPreviousSnapshot()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());
        int originalDifficulty = service.CurrentPow.Options.DefaultDifficulty;

        service.UpdatePowOptions(
            new PowOptionsUpdateRequest("observe", 8, false, 600, false, false, "tester"), "tester");

        Assert.Equal(8, service.CurrentPow.Options.DefaultDifficulty);

        PowPolicySnapshot rolled = service.RollbackPowOptions("tester");
        Assert.Equal(originalDifficulty, rolled.Options.DefaultDifficulty);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void BuildSecurityOverview_AggregatesCurrentState()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());
        RecordEvent(service, "ev-1", DateTimeOffset.UtcNow, SecurityRiskSources.AntiCrawler, "policy");

        SecurityOverviewResponse overview = service.BuildSecurityOverview(
            CrawlerRangeStatus.Empty,
            new CrawlerRangesAdminStatus(true, 1440, 30, 0, null, null, null, "idle", false, 0, 0, null, null, "empty", null, "https://developers.google.com", "https://www.bing.com", null));

        Assert.NotNull(overview);
        Assert.Equal("ok", overview.Status);
        Assert.True(overview.AntiCrawler.Enabled);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void BuildAntiCrawlerOverview_CountsAllEventCategories()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());
        DateTimeOffset now = DateTimeOffset.UtcNow;

        service.RecordRiskEvent(new AntiCrawlerRiskEventResponse(
            "verified", now, SecurityRiskSources.AntiCrawler, nameof(SecurityRiskReason.FakeCrawler), "block", 30, 30, "ip", "/path", "GET", null, "verified_crawler"));
        service.RecordRiskEvent(new AntiCrawlerRiskEventResponse(
            "social", now, SecurityRiskSources.AntiCrawler, nameof(SecurityRiskReason.UnknownBot), "observe", 15, 15, "ip", "/path", "GET", null, "social_preview"));
        service.RecordRiskEvent(new AntiCrawlerRiskEventResponse(
            "blocked", now, SecurityRiskSources.AntiCrawler, nameof(SecurityRiskReason.BlockedUserAgent), "block", 10, 10, "ip", "/path", "GET", null, null));

        AntiCrawlerOverviewResponse overview = service.BuildAntiCrawlerOverview(
            CrawlerRangeStatus.Empty,
            new CrawlerRangesAdminStatus(true, 1440, 30, 0, null, null, null, "idle", false, 0, 0, null, null, "empty", null, "https://developers.google.com", "https://www.bing.com", null));

        Assert.True(overview.Summary.EventsLastHour >= 3);
        Assert.Equal(1, overview.Summary.VerifiedCrawlerEvents);
        Assert.Equal(1, overview.Summary.SocialPreviewEvents);
        Assert.Equal(1, overview.Summary.FakeCrawlerEvents);
        Assert.Equal(1, overview.Summary.UnknownBotEvents);
        Assert.Equal(1, overview.Summary.BlockedUserAgentEvents);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void UpdateRiskControlPolicy_AppliesChangesAndRollback()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());

        SecurityRiskPolicySnapshotV2 updated = service.UpdateRiskControlPolicy(
            new RiskControlPolicyUpdateRequest(
                "strict", true, false, true, true, 150, "tester"), "tester");

        Assert.Equal("strict", updated.GlobalMode);
        Assert.Contains(SecurityRiskSources.PoSpace, updated.SubsystemModes.Keys);

        SecurityRiskPolicySnapshotV2 rolled = service.RollbackRiskControlPolicy("tester");
        Assert.NotEqual(updated.SnapshotId, rolled.SnapshotId);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void ApplyAntiCrawlerPolicySnapshot_PersistsExternalSnapshot()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());
        var original = service.Current;

        var externalSnapshot = new AntiCrawlerPolicySnapshot(
            "external-snapshot",
            DateTimeOffset.UtcNow,
            "external",
            "import",
            original.Options with { Mode = "observe" });

        service.ApplyAntiCrawlerPolicySnapshot(externalSnapshot);

        Assert.Equal("external-snapshot", service.Current.SnapshotId);
        Assert.Equal("observe", service.Current.Options.Mode);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void ApplyPowPolicySnapshot_PersistsExternalSnapshot()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());
        var original = service.CurrentPow;

        var externalSnapshot = new PowPolicySnapshot(
            "external-pow",
            DateTimeOffset.UtcNow,
            "external",
            "import",
            original.Options with { DefaultDifficulty = 7 });

        service.ApplyPowPolicySnapshot(externalSnapshot);

        Assert.Equal("external-pow", service.CurrentPow.SnapshotId);
        Assert.Equal(7, service.CurrentPow.Options.DefaultDifficulty);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void NormalizeRuleAction_AllInputsProduceExactOutput()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());

        AntiCrawlerRuleResponse allow = service.AddRule(
            new AntiCrawlerRuleRequest("a", true, "ip", "1.2.3.4", "allow", 10, null), "t");
        Assert.Equal("allow", allow.Action);

        AntiCrawlerRuleResponse challenge = service.AddRule(
            new AntiCrawlerRuleRequest("b", true, "ip", "1.2.3.4", "challenge", 10, null), "t");
        Assert.Equal("require_challenge", challenge.Action);

        AntiCrawlerRuleResponse rc = service.AddRule(
            new AntiCrawlerRuleRequest("c", true, "ip", "1.2.3.4", "require_challenge", 10, null), "t");
        Assert.Equal("require_challenge", rc.Action);

        AntiCrawlerRuleResponse block = service.AddRule(
            new AntiCrawlerRuleRequest("d", true, "ip", "1.2.3.4", "block", 10, null), "t");
        Assert.Equal("block", block.Action);

        AntiCrawlerRuleResponse unknown = service.AddRule(
            new AntiCrawlerRuleRequest("e", true, "ip", "1.2.3.4", "unknown_action", 10, null), "t");
        Assert.Equal("observe", unknown.Action);

        AntiCrawlerRuleResponse empty = service.AddRule(
            new AntiCrawlerRuleRequest("f", true, "ip", "1.2.3.4", "", 10, null), "t");
        Assert.Equal("observe", empty.Action);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Boundary)]
    [Fact]
    public void Simulate_RequireChallengeBoundaryAtExactThresholds()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());

        // Default: RequireChallengeScore=50, BlockScore=100
        // Add a rule that brings score to exactly 50 → require_challenge
        service.AddRule(new AntiCrawlerRuleRequest("at-threshold", true, "user-agent", "threshold-agent", "challenge", 50, null), "test");
        AntiCrawlerSimulationResult atThreshold = service.Simulate(new AntiCrawlerSimulationRequest("GET", "/", "threshold-agent", "1.2.3.4", null, 0));
        Assert.Equal("require_challenge", atThreshold.FinalAction);
        Assert.True(atThreshold.WouldRequireChallenge);
        Assert.False(atThreshold.WouldBlock);

        // Add a rule that brings score to exactly 100 → block
        service.AddRule(new AntiCrawlerRuleRequest("at-block", true, "user-agent", "block-agent", "block", 100, null), "test");
        AntiCrawlerSimulationResult atBlock = service.Simulate(new AntiCrawlerSimulationRequest("GET", "/", "block-agent", "1.2.3.4", null, 0));
        Assert.Equal("block", atBlock.FinalAction);
        Assert.True(atBlock.WouldBlock);

        // Score between thresholds: 50-99 → require_challenge
        service.AddRule(new AntiCrawlerRuleRequest("mid", true, "user-agent", "mid-agent", "challenge", 75, null), "test");
        AntiCrawlerSimulationResult midScore = service.Simulate(new AntiCrawlerSimulationRequest("GET", "/", "mid-agent", "1.2.3.4", null, 0));
        Assert.Equal("require_challenge", midScore.FinalAction);

        // Score below threshold: 49 → allow
        service.AddRule(new AntiCrawlerRuleRequest("low", true, "user-agent", "low-agent", "challenge", 49, null), "test");
        AntiCrawlerSimulationResult lowScore = service.Simulate(new AntiCrawlerSimulationRequest("GET", "/", "low-agent", "1.2.3.4", null, 0));
        Assert.Equal("allow", lowScore.FinalAction);
        Assert.False(lowScore.WouldRequireChallenge);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Boundary)]
    [Fact]
    public void Simulate_CurrentRiskScoreClampsToMaxRiskScore()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());

        // CurrentRiskScore + delta should clamp to MaxRiskScore (200)
        AntiCrawlerSimulationResult result = service.Simulate(
            new AntiCrawlerSimulationRequest("GET", "/", "Mozilla", "1.2.3.4", null, 195));
        Assert.Equal(195, result.ResultingRiskScore);
        Assert.True(result.WouldBlock);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void BuildPowOverview_CountsPowEventsWithinLastHour()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());
        DateTimeOffset now = DateTimeOffset.UtcNow;

        // Event within the last hour with PowInvalid reason
        service.RecordRiskEvent(new AntiCrawlerRiskEventResponse(
            "pow-invalid", now, SecurityRiskSources.Pow, nameof(SecurityRiskReason.PowInvalid), "block", 10, 10, "ip", "/path", "GET", null, null));

        // Event within the last hour with PowReplay reason
        service.RecordRiskEvent(new AntiCrawlerRiskEventResponse(
            "pow-replay", now, SecurityRiskSources.Pow, nameof(SecurityRiskReason.PowReplay), "block", 10, 10, "ip", "/path", "GET", null, null));

        // Event outside the last hour (2 hours ago) - should not be counted
        service.RecordRiskEvent(new AntiCrawlerRiskEventResponse(
            "pow-old", now.AddHours(-2), SecurityRiskSources.Pow, nameof(SecurityRiskReason.PowInvalid), "block", 10, 10, "ip", "/path", "GET", null, null));

        // PublicRead challenge required event
        service.RecordRiskEvent(new AntiCrawlerRiskEventResponse(
            "pub-read", now, SecurityRiskSources.PublicRead, nameof(SecurityRiskReason.PublicReadChallengeRequired), "challenge", 10, 10, "ip", "/path", "GET", null, null));

        PowOverviewResponse overview = service.BuildPowOverview();

        Assert.Equal(1, overview.ValidationFailuresLastHour);
        Assert.Equal(1, overview.ReplayRejectsLastHour);
        Assert.Equal(1, overview.ChallengeRequiredLastHour);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void UpdatePerceptionSealedV2Policy_ClampsSolveDurationRange()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());

        PerceptionSealedV2PolicySnapshot updated = service.UpdatePerceptionSealedV2Policy(
            new PerceptionSealedV2PolicyUpdateRequest(
                Enabled: null,
                LocalizationEnabled: null,
                MicroInteractionEnabled: null,
                PoSpaceFallbackEnabled: null,
                EarlyRejectThreshold: 50,  // Below min of 60 → should clamp to 60
                MaxAttempts: 20,  // Above max of 10 → should clamp to 10
                MinSolveDurationMs: -1,  // Below min of 0 → should clamp to 0
                MaxSolveDurationMs: 500,  // Below min of 1000 → should clamp to 1000
                Reason: "test"), "tester");

        Assert.Equal(60, updated.Options.EarlyRejectThreshold);
        Assert.Equal(10, updated.Options.MaxAttempts);
        Assert.Equal(0, updated.Options.MinSolveDurationMs);
        Assert.Equal(1000, updated.Options.MaxSolveDurationMs);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void RollbackPerceptionSealedV2Policy_RevertsToPreviousSnapshot()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());
        bool originalEnabled = service.CurrentPerceptionSealedV2.Options.Enabled;

        service.UpdatePerceptionSealedV2Policy(
            new PerceptionSealedV2PolicyUpdateRequest(
                false, null, null, null, null, null, null, null, "test"), "tester");

        Assert.False(service.CurrentPerceptionSealedV2.Options.Enabled);

        PerceptionSealedV2PolicySnapshot rolled = service.RollbackPerceptionSealedV2Policy("tester");
        Assert.Equal(originalEnabled, rolled.Options.Enabled);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void ApplyRiskControlPolicySnapshot_PersistsExternalSnapshot()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());
        var original = service.CurrentRiskPolicyV2;

        var externalSnapshot = original with
        {
            SnapshotId = "external-risk",
            GlobalMode = "strict"
        };

        service.ApplyRiskControlPolicySnapshot(externalSnapshot);

        Assert.Equal("external-risk", service.CurrentRiskPolicyV2.SnapshotId);
        Assert.Equal("strict", service.CurrentRiskPolicyV2.GlobalMode);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void ApplyPerceptionSealedV2PolicySnapshot_PersistsExternalSnapshot()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());
        var original = service.CurrentPerceptionSealedV2;

        var externalSnapshot = original with
        {
            SnapshotId = "external-perception",
            Options = original.Options with { Enabled = false }
        };

        service.ApplyPerceptionSealedV2PolicySnapshot(externalSnapshot);

        Assert.Equal("external-perception", service.CurrentPerceptionSealedV2.SnapshotId);
        Assert.False(service.CurrentPerceptionSealedV2.Options.Enabled);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void UpdateAntiCrawlerOptions_PreservesUnchangedFields()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());
        int originalBlockScore = service.Current.Options.BlockScore;
        int originalMaxRiskScore = service.Current.Options.MaxRiskScore;

        AntiCrawlerPolicySnapshot updated = service.UpdateAntiCrawlerOptions(
            new AntiCrawlerOptionsUpdateRequest(
                "observe", null, null, null, null, null, null, null, null,
                77, null, null, null, null, null, null, null, null, null, null, null,
                null, null, null, null, null, null, null, null, null), "tester");

        Assert.Equal("observe", updated.Options.Mode);
        Assert.Equal(77, updated.Options.RequireChallengeScore);
        Assert.Equal(originalBlockScore, updated.Options.BlockScore);
        Assert.Equal(originalMaxRiskScore, updated.Options.MaxRiskScore);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Boundary)]
    [Fact]
    public void UpdateAntiCrawlerOptions_CidrIntervalClampsToMinimum()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());

        // Set min interval to 120, then try to set interval to 60 → should clamp to 120
        AntiCrawlerPolicySnapshot updated = service.UpdateAntiCrawlerOptions(
            new AntiCrawlerOptionsUpdateRequest(
                null, null, null, null, null, null, null, null, null,
                null, null, null, null, null, null, null, null, null, null, null, null,
                60, null, 120, null, null, null, null, null, null), "tester");

        Assert.Equal(120, updated.Options.CidrUpdateIntervalMinutes);
        Assert.Equal(120, updated.Options.CidrMinUpdateIntervalMinutes);
    }

    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void ListEntries_AddEntryNormalizesListType()
    {
        var service = new SecurityAdminPolicyService(new ConfigurationBuilder().Build());

        AntiCrawlerListEntryResponse entry = service.AddEntry(
            "blocklist", new AntiCrawlerListEntryRequest("1.2.3.4", "ip", "test", true), "tester");

        Assert.Equal("block", entry.ListType);
        Assert.Contains(service.ListEntries("block"), e => e.Id == entry.Id);
    }

    private static void RecordEvent(
        SecurityAdminPolicyService service,
        string id,
        DateTimeOffset occurredAtUtc,
        string source,
        string reason)
        => service.RecordRiskEvent(new AntiCrawlerRiskEventResponse(
            id,
            occurredAtUtc,
            source,
            reason,
            "observe",
            1,
            1,
            "ip-hash",
            "/article/42",
            "GET",
            "unit-test",
            null));

    private static IConfiguration BuildConfiguration(
        params (string Key, string Value)[] settings)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(settings.ToDictionary(
                setting => setting.Key,
                setting => (string?)setting.Value))
            .Build();
}
