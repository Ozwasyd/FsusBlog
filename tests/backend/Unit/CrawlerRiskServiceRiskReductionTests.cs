using System.Net;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.Security;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;
namespace FsusBlog.Server.Tests.Unit;

public sealed class CrawlerRiskServiceRiskReductionTests
{
    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task AddRiskAsync_PositiveSignal_UsesAtomicClampedIncrementWithoutReadModifyWrite()
    {
        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        cache.IncrementClampedWithExpiryAsync(
                CachePolicyId.SecurityPowRisk,
                "198.51.100.16",
                25,
                200,
                Arg.Any<TimeSpan>(),
                Arg.Any<CancellationToken>())
            .Returns(85L);
        ISecurityAdminPolicyService policy = Substitute.For<ISecurityAdminPolicyService>();
        policy.Current.Returns(CreatePolicySnapshot());
        policy.CurrentRiskPolicy.Returns(SecurityRiskPolicyFactory.Create(new SecurityRiskPolicyInputs(
            CreatePolicySnapshot().Options.Mode, true, CreatePolicySnapshot().Options.MaxRiskScore)).Seal());
        var service = new CrawlerRiskService(cache, cache, cache, cache, policy, NullLogger<CrawlerRiskService>.Instance);
        var context = new DefaultHttpContext();
        context.Connection.RemoteIpAddress = IPAddress.Parse("198.51.100.16");
        context.Request.Path = "/article/42";
        context.Request.Method = HttpMethods.Get;
        context.Request.Headers.UserAgent = "Mozilla/5.0";

        await service.AddRiskAsync(
            new SecurityRiskSignal(
                context,
                SecurityRiskReason.PublicReadChallengeRequired,
                25,
                TimeSpan.FromMinutes(10),
                SecurityRiskSources.PublicRead,
                RiskActionNames.PublicRead,
                "pow_required"),
            CancellationToken.None);

        await cache.Received(1).IncrementClampedWithExpiryAsync(
            CachePolicyId.SecurityPowRisk,
            "198.51.100.16",
            25,
            200,
            Arg.Is<TimeSpan>(ttl => ttl == TimeSpan.FromMinutes(10)),
            Arg.Any<CancellationToken>());
        await cache.DidNotReceive().GetStringAsync(CachePolicyId.SecurityPowRisk, "198.51.100.16", Arg.Any<CancellationToken>());
        await cache.DidNotReceive().SetStringAsync(
            CachePolicyId.SecurityPowRisk,
            "198.51.100.16",
            Arg.Any<string>(),
            Arg.Any<TimeSpan?>(),
            Arg.Any<CancellationToken>());
        policy.Received(1).RecordRiskEvent(Arg.Is<AntiCrawlerRiskEventResponse>(item =>
            item.ScoreDelta == 25 &&
            item.TotalScore == 85));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Boundary)]
    public async Task AddRiskAsync_ZeroDeltaSignal_RecordsEventWithoutRiskScoreRedisReadOrWrite()
    {
        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        ISecurityAdminPolicyService policy = Substitute.For<ISecurityAdminPolicyService>();
        policy.Current.Returns(CreatePolicySnapshot());
        policy.CurrentRiskPolicy.Returns(SecurityRiskPolicyFactory.Create(new SecurityRiskPolicyInputs(
            CreatePolicySnapshot().Options.Mode, true, CreatePolicySnapshot().Options.MaxRiskScore)).Seal());
        var service = new CrawlerRiskService(cache, cache, cache, cache, policy, NullLogger<CrawlerRiskService>.Instance);
        var context = new DefaultHttpContext();
        context.Connection.RemoteIpAddress = IPAddress.Parse("198.51.100.15");
        context.Request.Path = "/article/42";
        context.Request.Method = HttpMethods.Get;
        context.Request.Headers.UserAgent = "Mozilla/5.0";

        await service.AddRiskAsync(
            new SecurityRiskSignal(
                context,
                SecurityRiskReason.ReadProofAccepted,
                0,
                TimeSpan.FromMinutes(10),
                SecurityRiskSources.HumanReadProof,
                RiskActionNames.PublicRead,
                "observed"),
            CancellationToken.None);

        await cache.DidNotReceive().GetStringAsync(CachePolicyId.SecurityPowRisk, "198.51.100.15", Arg.Any<CancellationToken>());
        await cache.DidNotReceive().SetStringAsync(
            CachePolicyId.SecurityPowRisk,
            "198.51.100.15",
            Arg.Any<string>(),
            Arg.Any<TimeSpan?>(),
            Arg.Any<CancellationToken>());
        await cache.DidNotReceive().IncrementClampedWithExpiryAsync(
            CachePolicyId.SecurityPowRisk,
            "198.51.100.15",
            Arg.Any<long>(),
            Arg.Any<long>(),
            Arg.Any<TimeSpan>(),
            Arg.Any<CancellationToken>());
        policy.Received(1).RecordRiskEvent(Arg.Is<AntiCrawlerRiskEventResponse>(item =>
            item.ScoreDelta == 0 &&
            item.TotalScore == 0));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task AddRiskAsync_ReadProofAcceptedSignal_ReducesExistingPublicReadRiskScore()
    {
        IUnifiedCache cache = Substitute.For<IUnifiedCache>();
        cache.GetStringAsync(CachePolicyId.SecurityPowRisk, "198.51.100.17", Arg.Any<CancellationToken>())
            .Returns("60");
        ISecurityAdminPolicyService policy = Substitute.For<ISecurityAdminPolicyService>();
        policy.Current.Returns(CreatePolicySnapshot());
        policy.CurrentRiskPolicy.Returns(SecurityRiskPolicyFactory.Create(new SecurityRiskPolicyInputs(
            CreatePolicySnapshot().Options.Mode, true, CreatePolicySnapshot().Options.MaxRiskScore)).Seal());
        var service = new CrawlerRiskService(cache, cache, cache, cache, policy, NullLogger<CrawlerRiskService>.Instance);
        var context = new DefaultHttpContext();
        context.Connection.RemoteIpAddress = IPAddress.Parse("198.51.100.17");
        context.Request.Path = "/article/42";
        context.Request.Method = HttpMethods.Get;
        context.Request.Headers.UserAgent = "Mozilla/5.0";

        await service.AddRiskAsync(
            new SecurityRiskSignal(
                context,
                SecurityRiskReason.ReadProofAccepted,
                -20,
                TimeSpan.FromMinutes(10),
                SecurityRiskSources.HumanReadProof,
                RiskActionNames.PublicRead,
                "counted"),
            CancellationToken.None);

        await cache.Received(1).SetStringAsync(
            CachePolicyId.SecurityPowRisk,
            "198.51.100.17",
            "40",
            Arg.Any<TimeSpan?>(),
            Arg.Any<CancellationToken>());
        policy.Received(1).RecordRiskEvent(Arg.Is<AntiCrawlerRiskEventResponse>(item =>
            item.Source == SecurityRiskSources.HumanReadProof &&
            item.Reason == nameof(SecurityRiskReason.ReadProofAccepted) &&
            item.Action == RiskActionNames.PublicRead &&
            item.ScoreDelta == -20 &&
            item.TotalScore == 40));
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
}
