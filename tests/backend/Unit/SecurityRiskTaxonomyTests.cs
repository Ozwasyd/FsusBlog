using System.Net;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Security;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Logging;

using NSubstitute;
namespace FsusBlog.Server.Tests.Unit;

public sealed class SecurityRiskTaxonomyTests
{
    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void SecurityRiskReason_PreservesLegacyValuesAndAddsProductionChallengeReasons()
    {
        var legacyValues = new (string Name, int Value)[]
        {
            ("VerifiedCrawler", 0),
            ("FakeCrawler", 1),
            ("UnknownBot", 2),
            ("BlockedUserAgent", 3),
            ("UserAgentMissing", 4),
            ("RateLimited", 5),
            ("PowInvalid", 6),
            ("PowReplay", 7),
            ("ReadProofAccepted", 8),
            ("ReadProofRejected", 9),
            ("PublicReadChallengeRequired", 10),
            ("PublicReadBlocked", 12),
            ("SecurityChallengeRejected", 13),
            ("AuthLoginFailed", 14),
            ("PasskeyAssertionFailed", 15),
            ("PasskeyAssertionAccepted", 16),
            ("CommentRegionCompliance", 17),
            ("CommentSpamPattern", 18),
            ("CommentNullifierAbuse", 19)
        };
        var productionReasons = new[]
        {
            "DeviceFingerprintMissing",
            "DeviceFingerprintChanged",
            "RegionPolicyHit",
            "CommentSpamPatternHit",
            "AnonymousNullifierAbuse",
            "AuthFailureBurst",
            "PasskeyAssertionFailure",
            "AdminStepUpRequired",
            "AdminStepUpFailed",
            "ChallengeExpired",
            "ChallengeKindMismatch",
            "ChallengeSignatureInvalid"
        };

        foreach ((string name, int value) in legacyValues)
        {
            Assert.True(Enum.TryParse(name, out SecurityRiskReason parsed), $"{name} should remain parseable");
            Assert.Equal(value, (int)parsed);
        }

        int expectedValue = 23;
        foreach (string name in productionReasons)
        {
            Assert.True(Enum.TryParse(name, out SecurityRiskReason parsed), $"{name} should be a stable reason name");
            Assert.Equal(expectedValue++, (int)parsed);
            Assert.Equal(name, parsed.ToString());
        }
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void SecurityRiskSources_ExposeStableProductionChallengeSources()
    {
        var expected = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            ["AntiCrawler"] = "anti-crawler",
            ["Auth"] = "auth",
            ["RateLimiter"] = "rate-limiter",
            ["Pow"] = "pow",
            ["HumanReadProof"] = "human-read-proof",
            ["Passkey"] = "passkey",
            ["PublicRead"] = "public-read",
            ["PoSpace"] = "pospace",
            ["RiskControl"] = "risk-control",
            ["DeviceFingerprint"] = "device-fingerprint",
            ["RegionPolicy"] = "region-policy",
            ["CommentGovernance"] = "comment-governance",
            ["AdminStepUp"] = "admin-step-up",
            ["PerceptionLocalization"] = "perception-localization",
            ["PerceptionMicroInteraction"] = "perception-micro-interaction"
        };

        foreach ((string name, string wireValue) in expected)
        {
            System.Reflection.FieldInfo field = typeof(SecurityRiskSources).GetField(name)
                ?? throw new InvalidOperationException($"Missing security risk source: {name}");
            Assert.True(field.IsPublic);
            Assert.True(field.IsStatic);
            Assert.True(field.IsLiteral);
            Assert.Equal(typeof(string), field.FieldType);
            Assert.Equal(wireValue, field.GetRawConstantValue());
        }
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task RiskSink_AcceptsNewReasonsAndWritesStableEventAndLogNames()
    {
        SecurityRiskReason reason = ParseReason("SecurityChallengeRejected");
        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        cache.IncrementClampedWithExpiryAsync(CachePolicyId.SecurityPowRisk, "198.51.100.18", 12, 200, Arg.Any<TimeSpan>(), Arg.Any<CancellationToken>())
            .Returns(12L);
        ISecurityAdminPolicyService policy = Substitute.For<ISecurityAdminPolicyService>();
        policy.Current.Returns(CreatePolicySnapshot());
        policy.CurrentRiskPolicy.Returns(SecurityRiskPolicyFactory.Create(new SecurityRiskPolicyInputs(
            CreatePolicySnapshot().Options.Mode, true, CreatePolicySnapshot().Options.MaxRiskScore)).Seal());
        var logger = new CapturingLogger<CrawlerRiskService>();
        var service = new CrawlerRiskService(cache, cache, cache, cache, policy, logger);
        DefaultHttpContext context = CreateContext("198.51.100.18");

        await service.AddRiskAsync(
            new SecurityRiskSignal(
                context,
                reason,
                12,
                TimeSpan.FromMinutes(5),
                SecurityRiskSources.RiskControl,
                RiskActionNames.AuthLogin,
                "challenge_rejected"),
            CancellationToken.None);

        policy.Received(1).RecordRiskEvent(Arg.Is<AntiCrawlerRiskEventResponse>(item =>
            item.Source == SecurityRiskSources.RiskControl &&
            item.Reason == "SecurityChallengeRejected" &&
            item.Action == RiskActionNames.AuthLogin &&
            item.ScoreDelta == 12 &&
            item.Detail == "challenge_rejected"));
        Assert.Contains(logger.Messages, message =>
            message.Contains(SecurityRiskSources.RiskControl, StringComparison.Ordinal) &&
            message.Contains("SecurityChallengeRejected", StringComparison.Ordinal));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task RiskSink_PreservesUnknownReasonValuesWithoutThrowing()
    {
        var unknownReason = (SecurityRiskReason)999;
        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        cache.GetStringAsync(CachePolicyId.SecurityPowRisk, "198.51.100.19", Arg.Any<CancellationToken>())
            .Returns("4");
        ISecurityAdminPolicyService policy = Substitute.For<ISecurityAdminPolicyService>();
        policy.Current.Returns(CreatePolicySnapshot());
        policy.CurrentRiskPolicy.Returns(SecurityRiskPolicyFactory.Create(new SecurityRiskPolicyInputs(
            CreatePolicySnapshot().Options.Mode, true, CreatePolicySnapshot().Options.MaxRiskScore)).Seal());
        var service = new CrawlerRiskService(cache, cache, cache, cache, policy, new CapturingLogger<CrawlerRiskService>());
        DefaultHttpContext context = CreateContext("198.51.100.19");

        await service.AddRiskAsync(
            new SecurityRiskSignal(
                context,
                unknownReason,
                0,
                TimeSpan.FromMinutes(5),
                "custom-provider",
                "custom.action"),
            CancellationToken.None);

        policy.Received(1).RecordRiskEvent(Arg.Is<AntiCrawlerRiskEventResponse>(item =>
            item.Source == "custom-provider" &&
            item.Reason == "999" &&
            item.Action == "custom.action"));
    }

    private static SecurityRiskReason ParseReason(string name)
    {
        Assert.True(Enum.TryParse(name, out SecurityRiskReason reason), $"{name} should parse");
        return reason;
    }

    private static DefaultHttpContext CreateContext(string ip)
    {
        var context = new DefaultHttpContext();
        context.Connection.RemoteIpAddress = IPAddress.Parse(ip);
        context.Request.Path = "/api/binary/security/challenge";
        context.Request.Method = HttpMethods.Post;
        context.Request.Headers.UserAgent = "Mozilla/5.0";
        return context;
    }

    private static AntiCrawlerPolicySnapshot CreatePolicySnapshot()
        => new(
            "anti:test",
            DateTimeOffset.UnixEpoch,
            "test",
            "unit",
            new AntiCrawlerPolicyOptions(
                SecuritySystemModes.Enforce,
                PublicReadChallengeEnabled: true,
                SearchCrawlerVerificationEnabled: true,
                SocialPreviewGuardEnabled: true,
                RiskScoringEnabled: true,
                EventPersistenceEnabled: true,
                DashboardAggregationEnabled: true,
                CidrAutoUpdateEnabled: false,
                IllegalPathHardAbortEnabled: true,
                RequireChallengeScore: 50,
                BlockScore: 100,
                MaxRiskScore: 200,
                DefaultRiskTtlSeconds: 600,
                FixedIpPermitLimit: 100,
                FixedIpQueueLimit: 2,
                VerifiedCrawlerFixedIpPermitLimit: 1000,
                PublicReadPermitLimit: 120,
                PublicReadQueueLimit: 2,
                VerifiedCrawlerPublicReadPermitLimit: 1000,
                SocialPreviewPublicReadPermitLimit: 30,
                ReadProofPermitLimit: 30,
                CidrUpdateIntervalMinutes: 1440,
                CidrInitialDelaySeconds: 0,
                CidrMinUpdateIntervalMinutes: 30,
                GoogleCrawlerRangesUrl: "https://example.invalid/googlebot.json",
                BingCrawlerRangesUrl: "https://example.invalid/bingbot.json",
                SnapshotPath: null,
                SocialPreviewAllowedPathPrefixes: ["/"],
                BlockedUserAgentKeywords: [],
                SecurityChallengeReference: "security.pow"));

    private sealed class CapturingLogger<T> : ILogger<T>
    {
        public List<string> Messages { get; } = [];

        public IDisposable? BeginScope<TState>(TState state)
            where TState : notnull
            => NullScope.Instance;

        public bool IsEnabled(LogLevel logLevel)
            => true;

        public void Log<TState>(
            LogLevel logLevel,
            EventId eventId,
            TState state,
            Exception? exception,
            Func<TState, Exception?, string> formatter)
            => Messages.Add(formatter(state, exception));
    }

    private sealed class NullScope : IDisposable
    {
        public static readonly NullScope Instance = new();

        public void Dispose()
        {
        }
    }
}
