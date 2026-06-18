using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.Security;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RiskDecisionServiceTests
{
    private readonly RiskDecisionService _service = new();

    [Fact]
    public void Decide_PublicReadBelowChallenge_Allows()
    {
        RiskDecision decision = _service.Decide(CreateContext(RiskActionNames.PublicRead), CreatePolicy(SecuritySystemModes.Enforce), 49);

        Assert.Equal(RiskDecisionKind.Allow, decision.Kind);
        Assert.Equal(49, decision.RiskScore);
        Assert.Empty(decision.RequiredChallenges);
        Assert.Equal(SecurityRiskPolicySnapshotV2Adapter.DefaultPolicyVersion, decision.PolicyVersion);
    }

    [Fact]
    public void Decide_PublicReadAtChallenge_ReturnsChallenge()
    {
        RiskDecision decision = _service.Decide(CreateContext(RiskActionNames.PublicRead), CreatePolicy(SecuritySystemModes.Enforce), 50);

        Assert.Equal(RiskDecisionKind.Challenge, decision.Kind);
        Assert.Equal(1, decision.EscalationLevel);
        Assert.Equal(["security.pow"], decision.RequiredChallenges);
        Assert.Contains(SecurityRiskPolicyOutcomes.Challenge, decision.Reasons);
    }

    [Fact]
    public void Decide_PublicReadAtBlock_ReturnsBlock()
    {
        RiskDecision decision = _service.Decide(CreateContext(RiskActionNames.PublicRead), CreatePolicy(SecuritySystemModes.Enforce), 100);

        Assert.Equal(RiskDecisionKind.Block, decision.Kind);
        Assert.Empty(decision.RequiredChallenges);
        Assert.Contains(SecurityRiskPolicyOutcomes.Block, decision.Reasons);
    }

    [Theory]
    [InlineData(true, false, "verified_crawler")]
    [InlineData(false, true, "social_preview_bot")]
    public void Decide_CrawlerMarks_AlwaysAllow(bool verifiedCrawler, bool socialPreviewBot, string expectedReason)
    {
        RiskControlContext context = CreateContext(
            RiskActionNames.PublicRead,
            verifiedCrawler: verifiedCrawler,
            socialPreviewBot: socialPreviewBot);

        RiskDecision decision = _service.Decide(context, CreatePolicy(SecuritySystemModes.Enforce), 200);

        Assert.Equal(RiskDecisionKind.Allow, decision.Kind);
        Assert.Equal([expectedReason], decision.Reasons);
    }

    [Fact]
    public void Decide_ObserveMode_AllowsEvenWhenThresholdWouldBlock()
    {
        RiskDecision decision = _service.Decide(CreateContext(RiskActionNames.PublicRead), CreatePolicy(SecuritySystemModes.Observe), 100);

        Assert.Equal(RiskDecisionKind.Allow, decision.Kind);
        Assert.Contains(SecurityRiskPolicyOutcomes.Block, decision.Reasons);
        Assert.Empty(decision.RequiredChallenges);
    }

    [Fact]
    public void Decide_StrictMode_UsesEffectiveRiskScore()
    {
        RiskDecision decision = _service.Decide(CreateContext(RiskActionNames.PublicRead), CreatePolicy(SecuritySystemModes.Strict), 40);

        Assert.Equal(RiskDecisionKind.Challenge, decision.Kind);
        Assert.Equal(40, decision.RiskScore);
        Assert.Equal(50, decision.EffectiveRiskScore);
    }

    [Fact]
    public void Decide_LockdownMode_BlocksAnonymousCommentWrite()
    {
        RiskDecision decision = _service.Decide(CreateContext(RiskActionNames.CommentCreate), CreatePolicy(SecuritySystemModes.Lockdown), 0);

        Assert.Equal(RiskDecisionKind.Block, decision.Kind);
        Assert.Contains("anonymous_write_lockdown", decision.Reasons);
    }

    [Fact]
    public void Decide_StepUpChallengeKind_ReturnsStepUp()
    {
        var overrides = new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal)
        {
            [RiskActionNames.AdminSecurityWrite] = CreateActionPolicy(RiskActionNames.AdminSecurityWrite, "passkey.step-up")
        };
        SecurityRiskPolicySnapshotV2 policy = CreatePolicy(SecuritySystemModes.Enforce, overrides);

        RiskDecision decision = _service.Decide(CreateContext(RiskActionNames.AdminSecurityWrite), policy, 50);

        Assert.Equal(RiskDecisionKind.StepUp, decision.Kind);
        Assert.Equal(["passkey.step-up"], decision.RequiredChallenges);
    }

    private static RiskControlContext CreateContext(
        string actionName,
        bool verifiedCrawler = false,
        bool socialPreviewBot = false)
        => new(
            actionName,
            actionName,
            RiskControlContextStatuses.Resolved,
            "198.51.100.17",
            "Mozilla/5.0",
            RiskControlContextStatuses.Present,
            new RiskControlActorContext(
                RiskControlActorStatuses.Anonymous,
                AnonymousIdentityRuntime.AnonymousAccountKind,
                null,
                null,
                null,
                null),
            new RiskControlDeviceFingerprintContext(RiskControlContextStatuses.Missing, 0, null, "missing"),
            new RiskControlRegionContext(RiskControlContextStatuses.Missing, "UNKNOWN", null, "missing"),
            verifiedCrawler,
            socialPreviewBot);

    private static SecurityRiskPolicySnapshotV2 CreatePolicy(
        string mode,
        IReadOnlyDictionary<string, SecurityRiskActionPolicy>? overrides = null)
    {
        SecurityRiskActionPolicy defaultAction = CreateActionPolicy("*", "security.pow");
        var actionOverrides = new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal)
        {
            [RiskActionNames.PublicRead] = defaultAction with
            {
                ActionName = RiskActionNames.PublicRead,
                AnonymousWriteAllowed = true
            },
            [RiskActionNames.CommentCreate] = defaultAction with { ActionName = RiskActionNames.CommentCreate }
        };
        if (overrides is not null)
        {
            foreach (KeyValuePair<string, SecurityRiskActionPolicy> item in overrides)
            {
                actionOverrides[item.Key] = item.Value;
            }
        }

        return new SecurityRiskPolicySnapshotV2(
            "risk:test",
            SecurityRiskPolicySnapshotV2Adapter.DefaultPolicyVersion,
            DateTimeOffset.UnixEpoch,
            mode,
            200,
            125,
            "risk:lkg",
            defaultAction,
            actionOverrides,
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                [SecurityRiskSources.AntiCrawler] = mode,
                [SecurityRiskSources.Pow] = SecuritySystemModes.Enforce
            });
    }

    private static SecurityRiskActionPolicy CreateActionPolicy(string actionName, string challengeKind)
        => new(
            actionName,
            new SecurityRiskActionThresholds(49, 50, 100, 100, 100),
            challengeKind,
            1,
            null,
            AnonymousWriteAllowed: false);
}
