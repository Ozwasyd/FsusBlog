using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.Security;
using System.Diagnostics.Metrics;

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

    [Fact]
    public void Decide_ChallengeQueueAndBlock_RecordDecisionMetrics()
    {
        var measurements = new List<string>();
        using var listener = new MeterListener();
        listener.InstrumentPublished = (instrument, meterListener) =>
        {
            if (string.Equals(instrument.Meter.Name, FsusObservability.MeterName, StringComparison.Ordinal)
                && string.Equals(instrument.Name, "fsus.security.decision.count", StringComparison.Ordinal))
            {
                meterListener.EnableMeasurementEvents(instrument);
            }
        };
        listener.SetMeasurementEventCallback<long>((instrument, _, _, _) => measurements.Add(instrument.Name));
        listener.Start();
        SecurityRiskPolicySnapshotV2 policy = CreatePolicy(
            SecuritySystemModes.Enforce,
            new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal)
            {
                [RiskActionNames.PublicRead] = new SecurityRiskActionPolicy(
                    RiskActionNames.PublicRead,
                    new SecurityRiskActionThresholds(9, 10, 20, 30, 40),
                    "security.pow",
                    1,
                    null,
                    AnonymousWriteAllowed: true)
            });

        Assert.Equal(RiskDecisionKind.Challenge, _service.Decide(CreateContext(RiskActionNames.PublicRead), policy, 10).Kind);
        Assert.Equal(RiskDecisionKind.QueueForModeration, _service.Decide(CreateContext(RiskActionNames.PublicRead), policy, 30).Kind);
        Assert.Equal(RiskDecisionKind.Block, _service.Decide(CreateContext(RiskActionNames.PublicRead), policy, 40).Kind);

        Assert.True(measurements.Count(item => string.Equals(item, "fsus.security.decision.count", StringComparison.Ordinal)) >= 3);
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

    [Fact]
    public void Decide_AuthLoginCaptchaPolicy_ReturnsMediumCaptchaAndHighComboChallenge()
    {
        SecurityRiskActionPolicy authPolicy = CreateCaptchaActionPolicy(RiskActionNames.AuthLogin) with
        {
            HardChallengeKinds = ["captchaV1", "sha256PowV1"],
            HardChallengeEscalationLevel = 2
        };
        var overrides = new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal)
        {
            [RiskActionNames.AuthLogin] = authPolicy
        };
        SecurityRiskPolicySnapshotV2 policy = CreatePolicy(SecuritySystemModes.Enforce, overrides);

        RiskDecision low = _service.Decide(CreateContext(RiskActionNames.AuthLogin), policy, 49);
        RiskDecision medium = _service.Decide(CreateContext(RiskActionNames.AuthLogin), policy, 50);
        RiskDecision high = _service.Decide(CreateContext(RiskActionNames.AuthLogin), policy, 75);

        Assert.Equal(RiskDecisionKind.Allow, low.Kind);
        Assert.Empty(low.RequiredChallenges);
        Assert.Equal(RiskDecisionKind.Challenge, medium.Kind);
        Assert.Equal(["captchaV1"], medium.RequiredChallenges);
        Assert.Equal(1, medium.EscalationLevel);
        Assert.Equal(RiskDecisionKind.Challenge, high.Kind);
        Assert.Equal(["captchaV1", "sha256PowV1"], high.RequiredChallenges);
        Assert.Equal(2, high.EscalationLevel);
    }

    [Fact]
    public void Decide_ObserveModeWithCaptchaPolicy_RecordsOnlyWithoutRequiredChallenges()
    {
        SecurityRiskActionPolicy authPolicy = CreateCaptchaActionPolicy(RiskActionNames.AuthLogin) with
        {
            HardChallengeKinds = ["captchaV1", "sha256PowV1"],
            HardChallengeEscalationLevel = 2
        };
        var overrides = new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal)
        {
            [RiskActionNames.AuthLogin] = authPolicy
        };
        SecurityRiskPolicySnapshotV2 policy = CreatePolicy(SecuritySystemModes.Observe, overrides);

        RiskDecision decision = _service.Decide(CreateContext(RiskActionNames.AuthLogin), policy, 75);

        Assert.Equal(RiskDecisionKind.Allow, decision.Kind);
        Assert.Empty(decision.RequiredChallenges);
        Assert.Contains(SecurityRiskPolicyOutcomes.HardChallenge, decision.Reasons);
    }

    [Fact]
    public void Decide_CaptchaSubsystemDisabled_DoesNotIssueCaptchaChallenge()
    {
        SecurityRiskActionPolicy authPolicy = CreateCaptchaActionPolicy(RiskActionNames.AuthLogin);
        SecurityRiskPolicySnapshotV2 policy = CreatePolicy(
            SecuritySystemModes.Enforce,
            new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal)
            {
                [RiskActionNames.AuthLogin] = authPolicy
            }) with
        {
            SubsystemModes = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                [SecurityRiskSources.Captcha] = SecuritySystemModes.Disabled
            }
        };

        RiskDecision decision = _service.Decide(CreateContext(RiskActionNames.AuthLogin), policy, 50);

        Assert.Equal(RiskDecisionKind.Allow, decision.Kind);
        Assert.Empty(decision.RequiredChallenges);
        Assert.Contains("captcha_disabled", decision.Reasons);
        Assert.Contains("challenge_subsystems_disabled", decision.Reasons);
    }

    [Fact]
    public void Decide_PoSpaceSubsystemDisabled_DowngradesToCaptcha()
    {
        SecurityRiskPolicySnapshotV2 policy = CreatePoSpacePolicy(SecuritySystemModes.Disabled);

        RiskDecision decision = _service.Decide(CreateContext(RiskActionNames.AuthLogin), policy, 75);

        Assert.Equal(RiskDecisionKind.Challenge, decision.Kind);
        Assert.Equal(["captchaV1"], decision.RequiredChallenges);
        Assert.Contains("pospace_disabled_downgraded", decision.Reasons);
    }

    [Fact]
    public void Decide_PoSpaceAndCaptchaSubsystemsDisabled_DoesNotIssueFallbackChallenge()
    {
        SecurityRiskPolicySnapshotV2 policy = CreatePoSpacePolicy(SecuritySystemModes.Disabled) with
        {
            SubsystemModes = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                [SecurityRiskSources.PoSpace] = SecuritySystemModes.Disabled,
                [SecurityRiskSources.Captcha] = SecuritySystemModes.Disabled
            }
        };

        RiskDecision decision = _service.Decide(CreateContext(RiskActionNames.AuthLogin), policy, 75);

        Assert.Equal(RiskDecisionKind.Allow, decision.Kind);
        Assert.Empty(decision.RequiredChallenges);
        Assert.Contains("pospace_disabled_downgraded", decision.Reasons);
        Assert.Contains("captcha_disabled", decision.Reasons);
        Assert.Contains("challenge_subsystems_disabled", decision.Reasons);
    }

    [Fact]
    public void Decide_PoSpaceSubsystemEnabledOnDesktop_ReturnsPoSpace()
    {
        SecurityRiskPolicySnapshotV2 policy = CreatePoSpacePolicy(SecuritySystemModes.Enforce);

        RiskDecision decision = _service.Decide(CreateContext(RiskActionNames.AuthLogin), policy, 75);

        Assert.Equal(RiskDecisionKind.Challenge, decision.Kind);
        Assert.Equal(["argon2idPoSpaceV1"], decision.RequiredChallenges);
    }

    [Fact]
    public void Decide_PoSpaceSubsystemEnabledOnMobile_DowngradesToCaptcha()
    {
        SecurityRiskPolicySnapshotV2 policy = CreatePoSpacePolicy(SecuritySystemModes.Enforce);

        RiskDecision decision = _service.Decide(
            CreateContext(RiskActionNames.AuthLogin, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"),
            policy,
            75);

        Assert.Equal(RiskDecisionKind.Challenge, decision.Kind);
        Assert.Equal(["captchaV1"], decision.RequiredChallenges);
        Assert.Contains("pospace_mobile_downgraded", decision.Reasons);
    }

    private static RiskControlContext CreateContext(
        string actionName,
        bool verifiedCrawler = false,
        bool socialPreviewBot = false,
        string userAgent = "Mozilla/5.0")
        => new(
            actionName,
            actionName,
            RiskControlContextStatuses.Resolved,
            "198.51.100.17",
            userAgent,
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

    private static SecurityRiskActionPolicy CreateCaptchaActionPolicy(string actionName)
        => new(
            actionName,
            new SecurityRiskActionThresholds(49, 50, 75, 100, 100),
            "captchaV1",
            1,
            null,
            AnonymousWriteAllowed: false);

    private static SecurityRiskPolicySnapshotV2 CreatePoSpacePolicy(string poSpaceMode)
    {
        SecurityRiskActionPolicy defaultAction = CreateActionPolicy("*", "security.pow");
        SecurityRiskActionPolicy authPolicy = CreateCaptchaActionPolicy(RiskActionNames.AuthLogin) with
        {
            HardChallengeKinds = ["argon2idPoSpaceV1"],
            HardChallengeEscalationLevel = 3
        };
        return new SecurityRiskPolicySnapshotV2(
            "risk:test",
            SecurityRiskPolicySnapshotV2Adapter.DefaultPolicyVersion,
            DateTimeOffset.UnixEpoch,
            SecuritySystemModes.Enforce,
            200,
            125,
            "risk:lkg",
            defaultAction,
            new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal)
            {
                [RiskActionNames.AuthLogin] = authPolicy
            },
            new Dictionary<string, string>(StringComparer.Ordinal)
            {
                [SecurityRiskSources.PoSpace] = poSpaceMode
            });
    }
}
