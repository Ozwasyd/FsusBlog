using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Services.Security;

using Microsoft.Extensions.Configuration;
using FsusBlog.Shared.Contracts.Governance;
namespace FsusBlog.Server.Tests.Unit;

public sealed class SecurityRiskPolicySnapshotV2Tests
{
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    [Fact]
    public void LegacyAdapter_PreservesDefaultPublicReadChallengeAndBlockBehavior()
    {
        SecurityRiskPolicySnapshotV2 snapshot = SecurityRiskPolicySnapshotV2Adapter.FromLegacy(CreateLegacySnapshot());

        Assert.Equal(SecurityRiskPolicyOutcomes.Allow, snapshot.Evaluate(RiskActionNames.PublicRead, 19).Outcome);
        Assert.Equal(SecuritySystemModes.Disabled, snapshot.SubsystemModes[SecurityRiskSources.PoSpace]);
        SecurityRiskPolicyDecision challenge = snapshot.Evaluate(RiskActionNames.PublicRead, 20);
        Assert.Equal(SecurityRiskPolicyOutcomes.Challenge, challenge.Outcome);
        Assert.True(challenge.Enforced);
        Assert.Equal("sha256PowV1", challenge.ChallengeKind);
        Assert.Equal(["sha256PowV1"], challenge.RequiredChallengeKinds);
        Assert.Equal(["perceptionCharacterV3"], snapshot.Evaluate(RiskActionNames.PublicRead, 40).RequiredChallengeKinds);
        Assert.Equal(["perceptionLocalizationV2", "sha256PowV1"], snapshot.Evaluate(RiskActionNames.PublicRead, 60).RequiredChallengeKinds);
        Assert.Equal(SecurityRiskPolicyOutcomes.Throttle, snapshot.Evaluate(RiskActionNames.PublicRead, 80).Outcome);
        Assert.Equal(SecurityRiskPolicyOutcomes.Block, snapshot.Evaluate(RiskActionNames.PublicRead, 90).Outcome);

        SecurityRiskPolicySnapshot legacy = SecurityRiskPolicySnapshotV2Adapter.ToLegacy(snapshot);
        Assert.Equal(20, legacy.RequireChallengeScore);
        Assert.Equal(90, legacy.BlockScore);
        Assert.True(legacy.PublicReadChallengeEnabled);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void DisabledMode_AllowsWithoutEnforcement()
    {
        SecurityRiskPolicySnapshotV2 snapshot = CreateSnapshot(SecuritySystemModes.Disabled);

        SecurityRiskPolicyDecision decision = snapshot.Evaluate(RiskActionNames.PublicRead, 200);

        Assert.Equal(SecurityRiskPolicyOutcomes.Allow, decision.Outcome);
        Assert.False(decision.Enforced);
        Assert.Equal("mode_disabled", decision.Reason);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void RequiresRiskScoreLookup_UsesResolvedActionMode()
    {
        SecurityRiskPolicySnapshotV2 snapshot = CreateSnapshot(SecuritySystemModes.Enforce);
        SecurityRiskActionPolicy publicRead = snapshot.ResolveActionPolicy(RiskActionNames.PublicRead);
        snapshot = snapshot with
        {
            ActionOverrides = new Dictionary<string, SecurityRiskActionPolicy>(snapshot.ActionOverrides, StringComparer.Ordinal)
            {
                [RiskActionNames.PublicRead] = publicRead with { ModeOverride = SecuritySystemModes.Disabled }
            }
        };

        Assert.False(snapshot.RequiresRiskScoreLookup(RiskActionNames.PublicRead));
        Assert.True(snapshot.RequiresRiskScoreLookup(RiskActionNames.CommentCreate));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void ObserveMode_RecordsOnlyWithoutChallengeOrBlock()
    {
        SecurityRiskPolicySnapshotV2 snapshot = CreateSnapshot(SecuritySystemModes.Observe);

        SecurityRiskPolicyDecision decision = snapshot.Evaluate(RiskActionNames.PublicRead, 150);

        Assert.Equal(SecurityRiskPolicyOutcomes.Observe, decision.Outcome);
        Assert.False(decision.Enforced);
        Assert.Equal(SecurityRiskPolicyOutcomes.Block, decision.Reason);
        Assert.Equal(string.Empty, decision.ChallengeKind);
        Assert.Empty(decision.RequiredChallengeKinds);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void EnforceMode_UsesActionThresholdsForChallengeQueueAndBlock()
    {
        SecurityRiskPolicySnapshotV2 snapshot = CreateSnapshot(SecuritySystemModes.Enforce);

        Assert.Equal(SecurityRiskPolicyOutcomes.Challenge, snapshot.Evaluate(RiskActionNames.PublicRead, 50).Outcome);
        Assert.Equal(SecurityRiskPolicyOutcomes.HardChallenge, snapshot.Evaluate(RiskActionNames.PublicRead, 70).Outcome);
        Assert.Equal(SecurityRiskPolicyOutcomes.Queue, snapshot.Evaluate(RiskActionNames.PublicRead, 85).Outcome);
        Assert.Equal(SecurityRiskPolicyOutcomes.Block, snapshot.Evaluate(RiskActionNames.PublicRead, 100).Outcome);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void StrictMode_AppliesRiskWeightBeforeThresholds()
    {
        SecurityRiskPolicySnapshotV2 snapshot = CreateSnapshot(SecuritySystemModes.Strict);

        SecurityRiskPolicyDecision decision = snapshot.Evaluate(RiskActionNames.PublicRead, 40);

        Assert.Equal(50, decision.EffectiveRiskScore);
        Assert.Equal(SecurityRiskPolicyOutcomes.Challenge, decision.Outcome);
        Assert.True(decision.Enforced);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void LockdownMode_BlocksAnonymousWritesBeforeScoreThresholds()
    {
        SecurityRiskPolicySnapshotV2 snapshot = CreateSnapshot(SecuritySystemModes.Lockdown);

        SecurityRiskPolicyDecision decision = snapshot.Evaluate(RiskActionNames.CommentCreate, 0, isAnonymousWrite: true);

        Assert.Equal(SecurityRiskPolicyOutcomes.LockdownBlock, decision.Outcome);
        Assert.True(decision.Enforced);
        Assert.Equal("anonymous_write_lockdown", decision.Reason);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void ActionOverride_ReplacesDefaultThresholds()
    {
        var overrides = new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal)
        {
            [RiskActionNames.AuthLogin] = CreateActionPolicy(RiskActionNames.AuthLogin, 10, 20, 40, 60)
        };
        SecurityRiskPolicySnapshotV2 snapshot = CreateSnapshot(SecuritySystemModes.Enforce, overrides);

        Assert.Equal(SecurityRiskPolicyOutcomes.Allow, snapshot.Evaluate(RiskActionNames.PublicRead, 10).Outcome);
        Assert.Equal(SecurityRiskPolicyOutcomes.Challenge, snapshot.Evaluate(RiskActionNames.AuthLogin, 10).Outcome);
        Assert.Equal(RiskActionNames.AuthLogin, snapshot.ResolveActionPolicy(RiskActionNames.AuthLogin).ActionName);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void LegacyAdapter_MapsAuthAndCommentRiskToPerceptionSealedV2Bands()
    {
        SecurityRiskPolicySnapshotV2 snapshot = SecurityRiskPolicySnapshotV2Adapter.FromLegacy(CreateLegacySnapshot());

        Assert.Equal(SecurityRiskPolicyOutcomes.Allow, snapshot.Evaluate(RiskActionNames.AuthLogin, 19).Outcome);

        SecurityRiskPolicyDecision powLogin = snapshot.Evaluate(RiskActionNames.AuthLogin, 20);
        Assert.Equal(SecurityRiskPolicyOutcomes.Challenge, powLogin.Outcome);
        Assert.Equal("sha256PowV1", powLogin.ChallengeKind);
        Assert.Equal(["sha256PowV1"], powLogin.RequiredChallengeKinds);
        Assert.Equal(1, powLogin.EscalationLevel);

        SecurityRiskPolicyDecision characterLogin = snapshot.Evaluate(RiskActionNames.AuthLogin, 40);
        Assert.Equal(SecurityRiskPolicyOutcomes.Challenge, characterLogin.Outcome);
        Assert.Equal(["perceptionCharacterV3"], characterLogin.RequiredChallengeKinds);
        Assert.Equal(2, characterLogin.EscalationLevel);

        SecurityRiskPolicyDecision highLogin = snapshot.Evaluate(RiskActionNames.AuthLogin, 60);
        Assert.Equal(SecurityRiskPolicyOutcomes.HardChallenge, highLogin.Outcome);
        Assert.Equal("perceptionLocalizationV2", highLogin.ChallengeKind);
        Assert.Equal(["perceptionLocalizationV2", "sha256PowV1"], highLogin.RequiredChallengeKinds);
        Assert.Equal(3, highLogin.EscalationLevel);

        SecurityRiskPolicyDecision queuedComment = snapshot.Evaluate(RiskActionNames.CommentCreate, 80);
        Assert.Equal(SecurityRiskPolicyOutcomes.Queue, queuedComment.Outcome);
        Assert.Empty(queuedComment.RequiredChallengeKinds);

        Assert.Equal(SecurityRiskPolicyOutcomes.Block, snapshot.Evaluate(RiskActionNames.AuthLogin, 90).Outcome);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void LegacyAdapter_UsesPerceptionSealedV2DefaultDecisionMatrix()
    {
        SecurityRiskPolicySnapshotV2 snapshot = SecurityRiskPolicySnapshotV2Adapter.FromLegacy(CreateLegacySnapshot());
        SecurityRiskActionPolicy commentPolicy = snapshot.ResolveActionPolicy(RiskActionNames.CommentCreate);

        Assert.Equal(SecurityRiskPolicySnapshotV2Adapter.PerceptionSealedV2Matrix, commentPolicy.DecisionMatrix);
        Assert.Equal(SecurityRiskPolicyOutcomes.Allow, snapshot.Evaluate(RiskActionNames.CommentCreate, 19).Outcome);

        SecurityRiskPolicyDecision pow = snapshot.Evaluate(RiskActionNames.CommentCreate, 20);
        Assert.Equal(SecurityRiskPolicyOutcomes.Challenge, pow.Outcome);
        Assert.Equal(["sha256PowV1"], pow.RequiredChallengeKinds);

        SecurityRiskPolicyDecision character = snapshot.Evaluate(RiskActionNames.CommentCreate, 40);
        Assert.Equal(SecurityRiskPolicyOutcomes.Challenge, character.Outcome);
        Assert.Equal(["perceptionCharacterV3"], character.RequiredChallengeKinds);

        SecurityRiskPolicyDecision localization = snapshot.Evaluate(RiskActionNames.CommentCreate, 60);
        Assert.Equal(SecurityRiskPolicyOutcomes.HardChallenge, localization.Outcome);
        Assert.Equal(["perceptionLocalizationV2", "sha256PowV1"], localization.RequiredChallengeKinds);

        SecurityRiskPolicyDecision queue = snapshot.Evaluate(RiskActionNames.CommentCreate, 80);
        Assert.Equal(SecurityRiskPolicyOutcomes.Queue, queue.Outcome);
        Assert.Empty(queue.RequiredChallengeKinds);

        SecurityRiskPolicyDecision block = snapshot.Evaluate(RiskActionNames.CommentCreate, 90);
        Assert.Equal(SecurityRiskPolicyOutcomes.Block, block.Outcome);
        Assert.Empty(block.RequiredChallengeKinds);
    }

    [Theory]
    [InlineData(RiskActionNames.PublicRead, SecurityRiskPolicyOutcomes.Throttle)]
    [InlineData(RiskActionNames.CommentCreate, SecurityRiskPolicyOutcomes.Queue)]
    [InlineData(RiskActionNames.AuthLogin, SecurityRiskPolicyOutcomes.Throttle)]
    [InlineData(RiskActionNames.RecoveryKeyVerify, SecurityRiskPolicyOutcomes.Throttle)]
    [InlineData(RiskActionNames.NotificationSubscribe, SecurityRiskPolicyOutcomes.HardChallenge)]
    [InlineData(RiskActionNames.AdminSecurityWrite, SecurityRiskPolicyOutcomes.HardChallenge)]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void LegacyAdapter_AddsPerceptionSealedV2ActionOverrides(string actionName, string expectedOutcomeAt80)
    {
        SecurityRiskPolicySnapshotV2 snapshot = SecurityRiskPolicySnapshotV2Adapter.FromLegacy(CreateLegacySnapshot());
        SecurityRiskActionPolicy action = snapshot.ResolveActionPolicy(actionName);

        Assert.Equal(SecurityRiskPolicySnapshotV2Adapter.PerceptionSealedV2Matrix, action.DecisionMatrix);
        Assert.Equal(expectedOutcomeAt80, snapshot.Evaluate(actionName, 80).Outcome);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void LegacyAdapter_MapsNotificationSubscribeToMandatoryPowAndCriticalPoSpace()
    {
        SecurityRiskPolicySnapshotV2 snapshot = SecurityRiskPolicySnapshotV2Adapter.FromLegacy(CreateLegacySnapshot());

        SecurityRiskPolicyDecision low = snapshot.Evaluate(RiskActionNames.NotificationSubscribe, 0);
        SecurityRiskPolicyDecision high = snapshot.Evaluate(RiskActionNames.NotificationSubscribe, 60);
        SecurityRiskPolicyDecision critical = snapshot.Evaluate(RiskActionNames.NotificationSubscribe, 80);

        Assert.Equal(SecurityRiskPolicyOutcomes.Challenge, low.Outcome);
        Assert.Equal("sha256PowV1", low.ChallengeKind);
        Assert.Equal(["sha256PowV1"], low.RequiredChallengeKinds);
        Assert.Equal(SecurityRiskPolicyOutcomes.HardChallenge, high.Outcome);
        Assert.Equal(["argon2idPoSpaceV1"], high.RequiredChallengeKinds);
        Assert.Equal(SecurityRiskPolicyOutcomes.HardChallenge, critical.Outcome);
        Assert.Equal(["argon2idPoSpaceV1"], critical.RequiredChallengeKinds);
        Assert.Equal(
            ["sha256PowV1"],
            snapshot.Evaluate(RiskActionNames.NotificationSubscribe, 40).RequiredChallengeKinds);
        Assert.True(snapshot.ResolveActionPolicy(RiskActionNames.NotificationSubscribe).AnonymousWriteAllowed);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void LegacyAdapter_ForcesRecoveryKeyVerifyCharacterChallengeChallengeAtZeroRisk()
    {
        SecurityRiskPolicySnapshotV2 snapshot = SecurityRiskPolicySnapshotV2Adapter.FromLegacy(CreateLegacySnapshot());

        SecurityRiskPolicyDecision decision = snapshot.Evaluate(RiskActionNames.RecoveryKeyVerify, 0);

        Assert.Equal(SecurityRiskPolicyOutcomes.Challenge, decision.Outcome);
        Assert.True(decision.Enforced);
        Assert.Equal("perceptionCharacterV3", decision.ChallengeKind);
        Assert.Equal(["perceptionCharacterV3"], decision.RequiredChallengeKinds);
        Assert.Equal(1, decision.EscalationLevel);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void LegacyAdapter_DisabledCharacterProviderUsesCanonicalPowFallback()
    {
        SecurityRiskPolicySnapshotV2 snapshot = SecurityRiskPolicySnapshotV2Adapter.FromLegacy(
            CreateLegacySnapshot(),
            perceptionCharacterV3Enabled: false);

        Assert.Equal(
            ["sha256PowV1"],
            snapshot.Evaluate(RiskActionNames.RecoveryKeyVerify, 0).RequiredChallengeKinds);
        Assert.Equal(
            ["sha256PowV1"],
            snapshot.Evaluate(RiskActionNames.AuthLogin, 40).RequiredChallengeKinds);
        Assert.DoesNotContain(
            snapshot.ActionOverrides.Values.Prepend(snapshot.DefaultAction)
                .SelectMany(static action => action.DecisionBands)
                .SelectMany(static band => band.ChallengeKinds),
            static kind => string.Equals(kind, "perceptionCharacterV3", StringComparison.Ordinal));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void LegacyAdapter_DisabledPublicReadChallengeDisablesOnlyPublicReadOverride()
    {
        SecurityRiskPolicySnapshotV2 snapshot = SecurityRiskPolicySnapshotV2Adapter.FromLegacy(
            CreateLegacySnapshot(publicReadChallengeEnabled: false));

        SecurityRiskPolicyDecision publicRead = snapshot.Evaluate(RiskActionNames.PublicRead, 100);
        SecurityRiskPolicyDecision authLogin = snapshot.Evaluate(RiskActionNames.AuthLogin, 100);

        Assert.Equal(SecurityRiskPolicyOutcomes.Allow, publicRead.Outcome);
        Assert.Equal(SecurityRiskPolicyOutcomes.Block, authLogin.Outcome);
        Assert.False(SecurityRiskPolicySnapshotV2Adapter.ToLegacy(snapshot).PublicReadChallengeEnabled);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void LegacyAdapter_InitializesRuntimeSubsystemModes()
    {
        SecurityRiskPolicySnapshotV2 snapshot = SecurityRiskPolicySnapshotV2Adapter.FromLegacy(CreateLegacySnapshot());

        Assert.Equal(SecuritySystemModes.Disabled, snapshot.SubsystemModes[SecurityRiskSources.PerceptionMicroInteraction]);
        Assert.Equal(SecuritySystemModes.Enforce, snapshot.SubsystemModes[SecurityRiskSources.Auth]);
        Assert.Equal(SecuritySystemModes.Enforce, snapshot.SubsystemModes[SecurityRiskSources.CommentGovernance]);
        Assert.Equal(SecuritySystemModes.Enforce, snapshot.SubsystemModes[SecurityRiskSources.PublicRead]);
        Assert.Equal(SecuritySystemModes.Disabled, snapshot.SubsystemModes[SecurityRiskSources.PoSpace]);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void SecurityAdminPolicyService_ReadsRiskControlEnvironmentFallbacks()
    {
        SecurityAdminPolicyService service = new(CreateConfiguration(new Dictionary<string, string?>
        {
            ["Security:RiskControl:GlobalMode"] = SecuritySystemModes.Observe,
            ["Security:RiskControl:PerceptionCharacterV3:Enabled"] = "false",
            ["Security:RiskControl:PoSpaceV1:Enabled"] = "true",
            ["Security:RiskControl:PublicReadChallenge:Enabled"] = "false",
            ["Security:RiskControl:CommentRiskControl:Enabled"] = "false",
            ["Security:RiskControl:AuthRiskControl:Enabled"] = "false",
            ["Security:RiskControl:StrictRiskMultiplierPercent"] = "175"
        }));

        SecurityRiskPolicySnapshotV2 snapshot = service.CurrentRiskPolicyV2;

        Assert.Equal(SecuritySystemModes.Observe, snapshot.GlobalMode);
        Assert.Equal(175, snapshot.StrictRiskMultiplierPercent);
        Assert.Equal(SecuritySystemModes.Disabled, snapshot.SubsystemModes[SecurityRiskSources.PerceptionMicroInteraction]);
        Assert.Equal(SecuritySystemModes.Enforce, snapshot.SubsystemModes[SecurityRiskSources.PoSpace]);
        Assert.Equal(SecuritySystemModes.Disabled, snapshot.ResolveActionPolicy(RiskActionNames.PublicRead).ModeOverride);
        Assert.Equal(SecuritySystemModes.Disabled, snapshot.ResolveActionPolicy(RiskActionNames.CommentCreate).ModeOverride);
        Assert.Equal(SecuritySystemModes.Disabled, snapshot.ResolveActionPolicy(RiskActionNames.AuthLogin).ModeOverride);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void SecurityAdminPolicyService_DerivesOnlyRuntimeEnabledCharacterChallenges()
    {
        SecurityAdminPolicyService disabled = new(CreateConfiguration());
        SecurityAdminPolicyService enabled = new(CreateConfiguration(new Dictionary<string, string?>
        {
            ["Security:PerceptionCharacterV3:Enabled"] = SecuritySystemModes.Enforce
        }));

        Assert.Equal(
            ["sha256PowV1"],
            disabled.CurrentRiskPolicyV2
                .Evaluate(RiskActionNames.RecoveryKeyVerify, 0)
                .RequiredChallengeKinds);
        Assert.Equal(
            ["perceptionCharacterV3"],
            enabled.CurrentRiskPolicyV2
                .Evaluate(RiskActionNames.RecoveryKeyVerify, 0)
                .RequiredChallengeKinds);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void SecurityAdminPolicyService_UpdateRiskControlPolicy_ProjectsEmergencySwitchesAndLkg()
    {
        SecurityAdminPolicyService service = new(CreateConfiguration());
        SecurityRiskPolicySnapshotV2 before = service.CurrentRiskPolicyV2;

        SecurityRiskPolicySnapshotV2 updated = service.UpdateRiskControlPolicy(
            new RiskControlPolicyUpdateRequest(
                SecuritySystemModes.Lockdown,
                PoSpaceV1Enabled: false,
                PublicReadChallengeEnabled: false,
                CommentRiskControlEnabled: false,
                AuthRiskControlEnabled: false,
                StrictRiskMultiplierPercent: 150,
                Reason: "incident"),
            "admin:7");

        Assert.Equal(SecuritySystemModes.Lockdown, updated.GlobalMode);
        Assert.Equal(150, updated.StrictRiskMultiplierPercent);
        Assert.Equal(before.SnapshotId, updated.LastKnownGoodSnapshotId);
        Assert.Equal(SecuritySystemModes.Disabled, updated.SubsystemModes[SecurityRiskSources.PerceptionMicroInteraction]);
        Assert.Equal(SecuritySystemModes.Disabled, updated.SubsystemModes[SecurityRiskSources.PoSpace]);
        Assert.Equal(SecuritySystemModes.Disabled, updated.ResolveActionPolicy(RiskActionNames.PublicRead).ModeOverride);
        Assert.Equal(SecuritySystemModes.Disabled, updated.ResolveActionPolicy(RiskActionNames.CommentReply).ModeOverride);
        Assert.Equal(SecuritySystemModes.Disabled, updated.ResolveActionPolicy(RiskActionNames.RecoveryKeyVerify).ModeOverride);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void SecurityAdminPolicyService_ReadsPerceptionV2EnvironmentFallbacks()
    {
        SecurityAdminPolicyService service = new(CreateConfiguration(new Dictionary<string, string?>
        {
            ["Security:PerceptionV2:Enabled"] = "false",
            ["Security:PerceptionV2:Localization:Enabled"] = "true",
            ["Security:PerceptionV2:MicroInteraction:Enabled"] = "true",
            ["Security:PerceptionV2:PoSpaceFallback:Enabled"] = "true",
            ["Security:PerceptionV2:EarlyRejectThreshold"] = "87",
            ["Security:PerceptionV2:MaxAttempts"] = "5",
            ["Security:PerceptionV2:MinSolveDurationMs"] = "1200",
            ["Security:PerceptionV2:MaxSolveDurationMs"] = "45000"
        }));

        PerceptionSealedV2PolicySnapshot snapshot = service.CurrentPerceptionSealedV2;

        Assert.False(snapshot.Options.Enabled);
        Assert.True(snapshot.Options.LocalizationEnabled);
        Assert.True(snapshot.Options.MicroInteractionEnabled);
        Assert.True(snapshot.Options.PoSpaceFallbackEnabled);
        Assert.Equal(87, snapshot.Options.EarlyRejectThreshold);
        Assert.Equal(5, snapshot.Options.MaxAttempts);
        Assert.Equal(1200, snapshot.Options.MinSolveDurationMs);
        Assert.Equal(45000, snapshot.Options.MaxSolveDurationMs);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void SecurityAdminPolicyService_UpdatePerceptionV2Policy_ProjectsRuntimeSwitchesAndLkg()
    {
        SecurityAdminPolicyService service = new(CreateConfiguration());
        PerceptionSealedV2PolicySnapshot before = service.CurrentPerceptionSealedV2;

        PerceptionSealedV2PolicySnapshot updated = service.UpdatePerceptionSealedV2Policy(
            new PerceptionSealedV2PolicyUpdateRequest(
                Enabled: true,
                LocalizationEnabled: true,
                MicroInteractionEnabled: true,
                PoSpaceFallbackEnabled: true,
                EarlyRejectThreshold: 88,
                MaxAttempts: 6,
                MinSolveDurationMs: 1000,
                MaxSolveDurationMs: 45000,
                Reason: "rollout"),
            "admin:7");

        Assert.Equal(before.SnapshotId, updated.LastKnownGoodSnapshotId);
        Assert.Equal("admin:7", updated.UpdatedBy);
        Assert.Equal("rollout", updated.Reason);
        Assert.True(updated.Options.Enabled);
        Assert.True(updated.Options.LocalizationEnabled);
        Assert.True(updated.Options.MicroInteractionEnabled);
        Assert.True(updated.Options.PoSpaceFallbackEnabled);
        Assert.Equal(88, updated.Options.EarlyRejectThreshold);
        Assert.Equal(6, updated.Options.MaxAttempts);
        Assert.Equal(1000, updated.Options.MinSolveDurationMs);
        Assert.Equal(45000, updated.Options.MaxSolveDurationMs);

        SecurityRiskPolicySnapshotV2 riskPolicy = service.CurrentRiskPolicyV2;
        Assert.Equal(SecuritySystemModes.Enforce, riskPolicy.SubsystemModes[SecurityRiskSources.PerceptionLocalization]);
        Assert.Equal(SecuritySystemModes.Enforce, riskPolicy.SubsystemModes[SecurityRiskSources.PerceptionMicroInteraction]);
        Assert.Equal(SecuritySystemModes.Enforce, riskPolicy.SubsystemModes[SecurityRiskSources.PoSpace]);
    }

    private static SecurityRiskPolicySnapshotV2 CreateSnapshot(
        string mode,
        IReadOnlyDictionary<string, SecurityRiskActionPolicy>? overrides = null)
    {
        SecurityRiskActionPolicy defaultAction = CreateActionPolicy("*", 50, 70, 85, 100);
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

    private static SecurityRiskActionPolicy CreateActionPolicy(
        string actionName,
        int challengeScore,
        int hardChallengeScore,
        int queueScore,
        int blockScore)
        => new(
            actionName,
            new SecurityRiskActionThresholds(Math.Max(0, challengeScore - 1), challengeScore, hardChallengeScore, queueScore, blockScore),
            "security.pow",
            1,
            null,
            AnonymousWriteAllowed: false);

    private static AntiCrawlerPolicySnapshot CreateLegacySnapshot(
        string mode = SecuritySystemModes.Enforce,
        bool publicReadChallengeEnabled = true)
        => new(
            "anti:test",
            DateTimeOffset.UnixEpoch,
            "test",
            "unit",
            new AntiCrawlerPolicyOptions(
                mode,
                publicReadChallengeEnabled,
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

    private static IConfiguration CreateConfiguration(IReadOnlyDictionary<string, string?>? values = null)
        => new ConfigurationBuilder()
            .AddInMemoryCollection(values ?? new Dictionary<string, string?>())
            .Build();
}
