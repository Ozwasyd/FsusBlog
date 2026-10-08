using System.Diagnostics.Metrics;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.Security;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RiskDecisionServiceTests
{
    private readonly RiskDecisionService _service = new();

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void Decide_PublicReadBelowChallenge_Allows()
    {
        RiskDecision decision = _service.Decide(CreateContext(RiskActionNames.PublicRead), CreatePolicy(SecuritySystemModes.Enforce), 49);

        Assert.Equal(RiskDecisionKind.Allow, decision.Kind);
        Assert.Equal(49, decision.RiskScore);
        Assert.Empty(decision.RequiredChallenges);
        Assert.Equal(SecurityRiskPolicyFactory.DefaultPolicyVersion, decision.PolicyVersion);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void Decide_PublicReadAtChallenge_ReturnsChallenge()
    {
        RiskDecision decision = _service.Decide(CreateContext(RiskActionNames.PublicRead), CreatePolicy(SecuritySystemModes.Enforce), 50);

        Assert.Equal(RiskDecisionKind.Challenge, decision.Kind);
        Assert.Equal(1, decision.EscalationLevel);
        Assert.Equal(["security.pow"], decision.RequiredChallenges);
        Assert.Contains(SecurityRiskPolicyOutcomes.Challenge, decision.Reasons);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void Decide_PublicReadAtBlock_ReturnsBlock()
    {
        RiskDecision decision = _service.Decide(CreateContext(RiskActionNames.PublicRead), CreatePolicy(SecuritySystemModes.Enforce), 100);

        Assert.Equal(RiskDecisionKind.Block, decision.Kind);
        Assert.Empty(decision.RequiredChallenges);
        Assert.Contains(SecurityRiskPolicyOutcomes.Block, decision.Reasons);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void Decide_DevelopmentLocalBypass_AllowsRiskControl()
    {
        RiskDecision decision = _service.Decide(
            CreateContext(RiskActionNames.PublicRead) with
            {
                DevelopmentLocalBypass = true
            },
            CreatePolicy(SecuritySystemModes.Enforce),
            100);

        Assert.Equal(RiskDecisionKind.Allow, decision.Kind);
        Assert.Empty(decision.RequiredChallenges);
        Assert.Contains("development_local_bypass", decision.Reasons);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
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
        SecurityRiskPolicy policy = CreatePolicy(
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
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
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
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void Decide_ObserveMode_AllowsEvenWhenThresholdWouldBlock()
    {
        RiskDecision decision = _service.Decide(CreateContext(RiskActionNames.PublicRead), CreatePolicy(SecuritySystemModes.Observe), 100);

        Assert.Equal(RiskDecisionKind.Allow, decision.Kind);
        Assert.Contains(SecurityRiskPolicyOutcomes.Block, decision.Reasons);
        Assert.Empty(decision.RequiredChallenges);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void Decide_StrictMode_UsesEffectiveRiskScore()
    {
        RiskDecision decision = _service.Decide(CreateContext(RiskActionNames.PublicRead), CreatePolicy(SecuritySystemModes.Strict), 40);

        Assert.Equal(RiskDecisionKind.Challenge, decision.Kind);
        Assert.Equal(40, decision.RiskScore);
        Assert.Equal(50, decision.EffectiveRiskScore);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void Decide_LockdownMode_BlocksAnonymousCommentWrite()
    {
        RiskDecision decision = _service.Decide(CreateContext(RiskActionNames.CommentCreate), CreatePolicy(SecuritySystemModes.Lockdown), 0);

        Assert.Equal(RiskDecisionKind.Block, decision.Kind);
        Assert.Contains("anonymous_write_lockdown", decision.Reasons);
    }

    [Theory]
    [InlineData("passkeyStepUpV1")]
    [InlineData("adminPasskeyStepUpV1")]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void Decide_StepUpChallengeKind_ReturnsStepUp(string challengeKind)
    {
        var overrides = new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal)
        {
            [RiskActionNames.AdminSecurityWrite] = CreateActionPolicy(RiskActionNames.AdminSecurityWrite, challengeKind)
        };
        SecurityRiskPolicy policy = CreatePolicy(SecuritySystemModes.Enforce, overrides);

        RiskDecision decision = _service.Decide(CreateContext(RiskActionNames.AdminSecurityWrite), policy, 50);

        Assert.Equal(RiskDecisionKind.StepUp, decision.Kind);
        Assert.Equal([challengeKind], decision.RequiredChallenges);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void Decide_PasskeySubstitutionPolicy_OmitsPerceptionCharacterV3()
    {
        var overrides = new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal)
        {
            [RiskActionNames.AdminSecurityWrite] = CreateActionPolicy(
                RiskActionNames.AdminSecurityWrite,
                "adminPasskeyStepUpV1")
        };
        SecurityRiskPolicy policy = CreatePolicy(SecuritySystemModes.Enforce, overrides);

        RiskDecision decision = _service.Decide(
            CreateContext(RiskActionNames.AdminSecurityWrite),
            policy,
            50);

        Assert.Equal(RiskDecisionKind.StepUp, decision.Kind);
        Assert.Equal(["adminPasskeyStepUpV1"], decision.RequiredChallenges);
        Assert.DoesNotContain("perceptionCharacterV3", decision.RequiredChallenges);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void Decide_AuthLoginCharacterChallengePolicy_ReturnsMediumCharacterChallengeAndHighComboChallenge()
    {
        SecurityRiskActionPolicy authPolicy = CreateCharacterChallengeActionPolicy(RiskActionNames.AuthLogin) with
        {
            HardChallengeKinds = ["perceptionCharacterV3", "sha256PowV1"],
            HardChallengeEscalationLevel = 2
        };
        var overrides = new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal)
        {
            [RiskActionNames.AuthLogin] = authPolicy
        };
        SecurityRiskPolicy policy = CreatePolicy(SecuritySystemModes.Enforce, overrides);

        RiskDecision low = _service.Decide(CreateContext(RiskActionNames.AuthLogin), policy, 49);
        RiskDecision medium = _service.Decide(CreateContext(RiskActionNames.AuthLogin), policy, 50);
        RiskDecision high = _service.Decide(CreateContext(RiskActionNames.AuthLogin), policy, 75);

        Assert.Equal(RiskDecisionKind.Allow, low.Kind);
        Assert.Empty(low.RequiredChallenges);
        Assert.Equal(RiskDecisionKind.Challenge, medium.Kind);
        Assert.Equal(["perceptionCharacterV3"], medium.RequiredChallenges);
        Assert.Equal(1, medium.EscalationLevel);
        Assert.Equal(RiskDecisionKind.Challenge, high.Kind);
        Assert.Equal(["perceptionCharacterV3", "sha256PowV1"], high.RequiredChallenges);
        Assert.Equal(2, high.EscalationLevel);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void Decide_PerceptionSealedV2Matrix_CoversRiskBandsWithoutIssuingCriticalChallenges()
    {
        SecurityRiskPolicy policy = SecurityRiskPolicyFactory.Create(CreateRiskInputs());

        RiskDecision low = _service.Decide(CreateContext(RiskActionNames.CommentCreate), policy, 19);
        RiskDecision pow = _service.Decide(CreateContext(RiskActionNames.CommentCreate), policy, 20);
        RiskDecision character = _service.Decide(CreateContext(RiskActionNames.CommentCreate), policy, 40);
        RiskDecision localization = _service.Decide(CreateContext(RiskActionNames.CommentCreate), policy, 60);
        RiskDecision queue = _service.Decide(CreateContext(RiskActionNames.CommentCreate), policy, 80);
        RiskDecision block = _service.Decide(CreateContext(RiskActionNames.CommentCreate), policy, 90);

        Assert.Equal(RiskDecisionKind.Allow, low.Kind);
        Assert.Empty(low.RequiredChallenges);
        Assert.Equal(RiskDecisionKind.Challenge, pow.Kind);
        Assert.Equal(["sha256PowV1"], pow.RequiredChallenges);
        Assert.Equal(RiskDecisionKind.Challenge, character.Kind);
        Assert.Equal(["perceptionCharacterV3"], character.RequiredChallenges);
        Assert.Equal(RiskDecisionKind.Challenge, localization.Kind);
        Assert.Equal(["perceptionLocalizationV2", "sha256PowV1"], localization.RequiredChallenges);
        Assert.Equal(RiskDecisionKind.QueueForModeration, queue.Kind);
        Assert.Empty(queue.RequiredChallenges);
        Assert.Equal(RiskDecisionKind.Block, block.Kind);
        Assert.Empty(block.RequiredChallenges);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void Decide_CriticalRiskRouting_UsesActionSpecificEarlyControl()
    {
        SecurityRiskPolicy policy = SecurityRiskPolicyFactory.Create(CreateRiskInputs()) with
        {
            SubsystemModes = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                [SecurityRiskSources.Pow] = SecuritySystemModes.Enforce,
                [SecurityRiskSources.PoSpace] = SecuritySystemModes.Enforce
            }
        };

        Assert.Equal(RiskDecisionKind.Throttle, _service.Decide(CreateContext(RiskActionNames.PublicRead), policy, 80).Kind);
        Assert.Equal(RiskDecisionKind.QueueForModeration, _service.Decide(CreateContext(RiskActionNames.CommentCreate), policy, 80).Kind);
        Assert.Equal(RiskDecisionKind.Throttle, _service.Decide(CreateContext(RiskActionNames.AuthLogin), policy, 80).Kind);
        Assert.Equal(RiskDecisionKind.Throttle, _service.Decide(CreateContext(RiskActionNames.RecoveryKeyVerify), policy, 80).Kind);

        RiskDecision notification = _service.Decide(CreateContext(RiskActionNames.NotificationSubscribe), policy, 80);
        Assert.Equal(RiskDecisionKind.Challenge, notification.Kind);
        Assert.Equal(["argon2idPoSpaceV1"], notification.RequiredChallenges);

        RiskDecision admin = _service.Decide(CreateContext(RiskActionNames.AdminSecurityWrite), policy, 80);
        Assert.Equal(RiskDecisionKind.StepUp, admin.Kind);
        Assert.Equal(["adminPasskeyStepUpV1"], admin.RequiredChallenges);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void Decide_CriticalNotificationSubscribe_RejectsWhenPoSpaceCannotRoute()
    {
        SecurityRiskPolicy policy = SecurityRiskPolicyFactory.Create(CreateRiskInputs());

        RiskDecision decision = _service.Decide(CreateContext(RiskActionNames.NotificationSubscribe), policy, 80);

        Assert.Equal(RiskDecisionKind.Block, decision.Kind);
        Assert.Empty(decision.RequiredChallenges);
        Assert.Contains("pospace_disabled_rejected", decision.Reasons);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void Decide_ObserveModeWithCharacterChallengePolicy_RecordsOnlyWithoutRequiredChallenges()
    {
        SecurityRiskActionPolicy authPolicy = CreateCharacterChallengeActionPolicy(RiskActionNames.AuthLogin) with
        {
            HardChallengeKinds = ["perceptionCharacterV3", "sha256PowV1"],
            HardChallengeEscalationLevel = 2
        };
        var overrides = new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal)
        {
            [RiskActionNames.AuthLogin] = authPolicy
        };
        SecurityRiskPolicy policy = CreatePolicy(SecuritySystemModes.Observe, overrides);

        RiskDecision decision = _service.Decide(CreateContext(RiskActionNames.AuthLogin), policy, 75);

        Assert.Equal(RiskDecisionKind.Allow, decision.Kind);
        Assert.Empty(decision.RequiredChallenges);
        Assert.Contains(SecurityRiskPolicyOutcomes.HardChallenge, decision.Reasons);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void Decide_CharacterChallengeSubsystemDisabled_DoesNotIssueCharacterChallengeChallenge()
    {
        SecurityRiskActionPolicy authPolicy = CreateCharacterChallengeActionPolicy(RiskActionNames.AuthLogin);
        SecurityRiskPolicy policy = CreatePolicy(
            SecuritySystemModes.Enforce,
            new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal)
            {
                [RiskActionNames.AuthLogin] = authPolicy
            }) with
        {
            SubsystemModes = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                [SecurityRiskSources.PerceptionMicroInteraction] = SecuritySystemModes.Disabled
            }
        };

        RiskDecision decision = _service.Decide(CreateContext(RiskActionNames.AuthLogin), policy, 50);

        Assert.Equal(RiskDecisionKind.Challenge, decision.Kind);
        Assert.Equal(["perceptionCharacterV3"], decision.RequiredChallenges);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void Decide_PoSpaceSubsystemDisabled_DowngradesToCharacterChallenge()
    {
        SecurityRiskPolicy policy = CreatePoSpacePolicy(SecuritySystemModes.Disabled);

        RiskDecision decision = _service.Decide(CreateContext(RiskActionNames.AuthLogin), policy, 75);

        Assert.Equal(RiskDecisionKind.Allow, decision.Kind);
        Assert.Empty(decision.RequiredChallenges);
        Assert.Contains("pospace_disabled", decision.Reasons);
        Assert.Contains("challenge_subsystems_disabled", decision.Reasons);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void Decide_PoSpaceAndCharacterChallengeSubsystemsDisabled_DoesNotIssueFallbackChallenge()
    {
        SecurityRiskPolicy policy = CreatePoSpacePolicy(SecuritySystemModes.Disabled) with
        {
            SubsystemModes = new Dictionary<string, string>(StringComparer.Ordinal)
            {
                [SecurityRiskSources.PoSpace] = SecuritySystemModes.Disabled,
                [SecurityRiskSources.PerceptionMicroInteraction] = SecuritySystemModes.Disabled
            }
        };

        RiskDecision decision = _service.Decide(CreateContext(RiskActionNames.AuthLogin), policy, 75);

        Assert.Equal(RiskDecisionKind.Allow, decision.Kind);
        Assert.Empty(decision.RequiredChallenges);
        Assert.Contains("pospace_disabled", decision.Reasons);
        Assert.Contains("challenge_subsystems_disabled", decision.Reasons);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void Decide_PoSpaceSubsystemEnabledOnDesktop_ReturnsPoSpace()
    {
        SecurityRiskPolicy policy = CreatePoSpacePolicy(SecuritySystemModes.Enforce);

        RiskDecision decision = _service.Decide(CreateContext(RiskActionNames.AuthLogin), policy, 75);

        Assert.Equal(RiskDecisionKind.Challenge, decision.Kind);
        Assert.Equal(["argon2idPoSpaceV1"], decision.RequiredChallenges);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void Decide_PoSpaceSubsystemEnabledOnMobile_DowngradesToCharacterChallenge()
    {
        SecurityRiskPolicy policy = CreatePoSpacePolicy(SecuritySystemModes.Enforce);

        RiskDecision decision = _service.Decide(
            CreateContext(RiskActionNames.AuthLogin, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)"),
            policy,
            75);

        Assert.Equal(RiskDecisionKind.Challenge, decision.Kind);
        Assert.Equal(["argon2idPoSpaceV1"], decision.RequiredChallenges);
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
                null,
                null),
            new RiskControlDeviceFingerprintContext(RiskControlContextStatuses.Missing, 0, null, "missing"),
            new RiskControlRegionContext(RiskControlContextStatuses.Missing, "UNKNOWN", null, "missing"),
            verifiedCrawler,
            socialPreviewBot);

    private static SecurityRiskPolicyInputs CreateRiskInputs()
        => new(SecuritySystemModes.Enforce, true, 200);

    private static AntiCrawlerPolicySnapshot CreateLegacySnapshot()
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
                CidrAutoUpdateEnabled: true,
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

    private static SecurityRiskPolicy CreatePolicy(
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

        return new SecurityRiskPolicy(
            "risk:test",
            SecurityRiskPolicyFactory.DefaultPolicyVersion,
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

    private static SecurityRiskActionPolicy CreateCharacterChallengeActionPolicy(string actionName)
        => new(
            actionName,
            new SecurityRiskActionThresholds(49, 50, 75, 100, 100),
            "perceptionCharacterV3",
            1,
            null,
            AnonymousWriteAllowed: false);

    private static SecurityRiskPolicy CreatePoSpacePolicy(string poSpaceMode)
    {
        SecurityRiskActionPolicy defaultAction = CreateActionPolicy("*", "security.pow");
        SecurityRiskActionPolicy authPolicy = CreateCharacterChallengeActionPolicy(RiskActionNames.AuthLogin) with
        {
            HardChallengeKinds = ["argon2idPoSpaceV1"],
            HardChallengeEscalationLevel = 3
        };
        return new SecurityRiskPolicy(
            "risk:test",
            SecurityRiskPolicyFactory.DefaultPolicyVersion,
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
