using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Modules.Endpoints;

using Microsoft.AspNetCore.Http;
namespace FsusBlog.Server.Tests.Unit;

public sealed class RiskControlSimulatorContractTests
{
    [Theory]
    [InlineData(10, RiskDecisionKind.Allow, "allow")]
    [InlineData(50, RiskDecisionKind.Challenge, "challenge")]
    [InlineData(90, RiskDecisionKind.QueueForModeration, "queue_for_moderation")]
    [InlineData(125, RiskDecisionKind.Block, "block")]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task BuildRiskControlSimulationAsync_UsesProductionRiskDecisionService(
        int riskScore,
        RiskDecisionKind expectedKind,
        string expectedDecision)
    {
        var response = await SecurityEndpoints.BuildRiskControlSimulationAsync(
            new RiskControlSimulationRequest(
                RiskActionNames.CommentCreate,
                "comment.create",
                "ip:203.0.113.10",
                riskScore,
                "203.0.113.10",
                "Mozilla/5.0",
                "device-123456",
                "CN",
                RiskControlActorStatuses.Anonymous,
                RiskControlIdentityKinds.Anonymous,
                VerifiedCrawler: false,
                SocialPreviewBot: false),
            CreateHttpContext(),
            new RecordingRiskScoreReader(0),
            new FixedRiskPolicyProvider(CreatePolicy()),
            new RiskDecisionService(),
            CancellationToken.None);

        Assert.Equal(expectedDecision, response.Decision);
        Assert.Equal(expectedKind.ToString(), response.DecisionKind);
        Assert.Equal(riskScore, response.RiskScore);
        Assert.Equal(SecurityRiskPolicyFactory.DefaultPolicyVersion, response.PolicyVersion);
        Assert.Equal(RiskActionNames.CommentCreate, response.Action);
        Assert.Equal("comment.create", response.RouteKey);
        if (expectedKind == RiskDecisionKind.Challenge)
        {
            Assert.Equal(["perceptionCharacterV3"], response.RequiredChallenges);
        }
        else
        {
            Assert.Empty(response.RequiredChallenges);
        }
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public async Task BuildRiskControlSimulationAsync_ReadsCurrentScoreWithoutResettingRiskState()
    {
        var riskScores = new RecordingRiskScoreReader(72);

        RiskControlSimulationResponse response = await SecurityEndpoints.BuildRiskControlSimulationAsync(
            new RiskControlSimulationRequest(
                RiskActionNames.AuthLogin,
                "auth.login",
                "user:42",
                RiskScore: null,
                ClientIp: "198.51.100.42",
                UserAgent: "Mozilla/5.0",
                DeviceFingerprint: "device-654321",
                Region: "US",
                ActorStatus: RiskControlActorStatuses.Authenticated,
                IdentityKind: RiskControlIdentityKinds.LegacyUser,
                VerifiedCrawler: false,
                SocialPreviewBot: false),
            CreateHttpContext(),
            riskScores,
            new FixedRiskPolicyProvider(CreatePolicy()),
            new RiskDecisionService(),
            CancellationToken.None);

        Assert.Equal(72, response.RiskScore);
        Assert.Equal("user:42", Assert.Single(riskScores.SubjectReads));
        Assert.Equal(0, riskScores.ContextReads);
        Assert.Equal(0, riskScores.ResetCalls);
    }

    private static DefaultHttpContext CreateHttpContext()
    {
        var context = new DefaultHttpContext();
        context.Connection.RemoteIpAddress = System.Net.IPAddress.Parse("127.0.0.1");
        context.Request.Headers.UserAgent = "AdminConsoleTest/1.0";
        return context;
    }

    private static SecurityRiskPolicy CreatePolicy()
    {
        var defaultPolicy = new SecurityRiskActionPolicy(
            "*",
            new SecurityRiskActionThresholds(49, 50, 70, 90, 120),
            "perceptionCharacterV3",
            1,
            null,
            AnonymousWriteAllowed: true);

        return new SecurityRiskPolicy(
            "risk:test",
            SecurityRiskPolicyFactory.DefaultPolicyVersion,
            DateTimeOffset.UnixEpoch,
            SecuritySystemModes.Enforce,
            200,
            125,
            "risk:lkg",
            defaultPolicy,
            new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal)
            {
                [RiskActionNames.CommentCreate] = defaultPolicy with { ActionName = RiskActionNames.CommentCreate },
                [RiskActionNames.AuthLogin] = defaultPolicy with { ActionName = RiskActionNames.AuthLogin }
            },
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                [SecurityRiskSources.RiskControl] = SecuritySystemModes.Enforce,
                [SecurityRiskSources.PoSpace] = SecuritySystemModes.Enforce
            });
    }

    private sealed class RecordingRiskScoreReader(int riskScore) : ISecurityRiskScoreReader
    {
        public List<string> SubjectReads { get; } = [];
        public int ContextReads
        {
            get; private set;
        }
        public int ResetCalls
        {
            get; private set;
        }

        public Task<int> GetRiskScoreAsync(SecurityRiskSubject subject, CancellationToken cancellationToken = default)
        {
            SubjectReads.Add(subject.Identity);
            return Task.FromResult(riskScore);
        }

        public Task<int> GetRiskScoreAsync(HttpContext context, CancellationToken cancellationToken = default)
        {
            ContextReads++;
            return Task.FromResult(riskScore);
        }

        public Task ResetRiskAsync(SecurityRiskSubject subject, CancellationToken cancellationToken = default)
        {
            ResetCalls++;
            return Task.CompletedTask;
        }
    }

    private sealed class FixedRiskPolicyProvider(SecurityRiskPolicy policy) : ISecurityRiskPolicyProvider
    {
        public SecurityRiskPolicy CurrentRiskPolicy => policy;
    }
}
