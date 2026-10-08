using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Models.Security;
using FsusBlog.Server.Services.Security;

using Microsoft.Extensions.Configuration;
namespace FsusBlog.Server.Tests.Unit;

public sealed class SecurityRiskPolicySnapshotV2Tests
{
    [Fact]
    public void LegacyAdapter_PreservesDefaultPublicReadChallengeAndBlockBehavior()
    {
        SecurityRiskPolicy snapshot = SecurityRiskPolicyFactory.Create(CreateRiskInputs());

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

        Assert.Equal(20, snapshot.ResolveActionPolicy(RiskActionNames.PublicRead).Thresholds.ChallengeScore);
        Assert.Equal(90, snapshot.ResolveActionPolicy(RiskActionNames.PublicRead).Thresholds.BlockScore);
        Assert.True(snapshot.RequiresRiskScoreLookup(RiskActionNames.PublicRead));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void DisabledMode_AllowsWithoutEnforcement()
    {
        SecurityRiskPolicy snapshot = CreateSnapshot(SecuritySystemModes.Disabled);

        SecurityRiskPolicyDecision decision = snapshot.Evaluate(RiskActionNames.PublicRead, 200);

        Assert.Equal(SecurityRiskPolicyOutcomes.Allow, decision.Outcome);
        Assert.False(decision.Enforced);
        Assert.Equal("mode_disabled", decision.Reason);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void RequiresRiskScoreLookup_UsesResolvedActionMode()
    {
        SecurityRiskPolicy snapshot = CreateSnapshot(SecuritySystemModes.Enforce);
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
        SecurityRiskPolicy snapshot = CreateSnapshot(SecuritySystemModes.Observe);

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
        SecurityRiskPolicy snapshot = CreateSnapshot(SecuritySystemModes.Enforce);

        Assert.Equal(SecurityRiskPolicyOutcomes.Challenge, snapshot.Evaluate(RiskActionNames.PublicRead, 50).Outcome);
        Assert.Equal(SecurityRiskPolicyOutcomes.HardChallenge, snapshot.Evaluate(RiskActionNames.PublicRead, 70).Outcome);
        Assert.Equal(SecurityRiskPolicyOutcomes.Queue, snapshot.Evaluate(RiskActionNames.PublicRead, 85).Outcome);
        Assert.Equal(SecurityRiskPolicyOutcomes.Block, snapshot.Evaluate(RiskActionNames.PublicRead, 100).Outcome);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void StrictMode_AppliesRiskWeightBeforeThresholds()
    {
        SecurityRiskPolicy snapshot = CreateSnapshot(SecuritySystemModes.Strict);

        SecurityRiskPolicyDecision decision = snapshot.Evaluate(RiskActionNames.PublicRead, 40);

        Assert.Equal(50, decision.EffectiveRiskScore);
        Assert.Equal(SecurityRiskPolicyOutcomes.Challenge, decision.Outcome);
        Assert.True(decision.Enforced);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void LockdownMode_BlocksAnonymousWritesBeforeScoreThresholds()
    {
        SecurityRiskPolicy snapshot = CreateSnapshot(SecuritySystemModes.Lockdown);

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
        SecurityRiskPolicy snapshot = CreateSnapshot(SecuritySystemModes.Enforce, overrides);

        Assert.Equal(SecurityRiskPolicyOutcomes.Allow, snapshot.Evaluate(RiskActionNames.PublicRead, 10).Outcome);
        Assert.Equal(SecurityRiskPolicyOutcomes.Challenge, snapshot.Evaluate(RiskActionNames.AuthLogin, 10).Outcome);
        Assert.Equal(RiskActionNames.AuthLogin, snapshot.ResolveActionPolicy(RiskActionNames.AuthLogin).ActionName);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void LegacyAdapter_MapsAuthAndCommentRiskToPerceptionSealedV2Bands()
    {
        SecurityRiskPolicy snapshot = SecurityRiskPolicyFactory.Create(CreateRiskInputs());

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
        SecurityRiskPolicy snapshot = SecurityRiskPolicyFactory.Create(CreateRiskInputs());
        SecurityRiskActionPolicy commentPolicy = snapshot.ResolveActionPolicy(RiskActionNames.CommentCreate);

        Assert.Equal(SecurityRiskPolicyFactory.PerceptionSealedV2Matrix, commentPolicy.DecisionMatrix);
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
        SecurityRiskPolicy snapshot = SecurityRiskPolicyFactory.Create(CreateRiskInputs());
        SecurityRiskActionPolicy action = snapshot.ResolveActionPolicy(actionName);

        Assert.Equal(SecurityRiskPolicyFactory.PerceptionSealedV2Matrix, action.DecisionMatrix);
        Assert.Equal(expectedOutcomeAt80, snapshot.Evaluate(actionName, 80).Outcome);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void LegacyAdapter_MapsNotificationSubscribeToMandatoryPowAndCriticalPoSpace()
    {
        SecurityRiskPolicy snapshot = SecurityRiskPolicyFactory.Create(CreateRiskInputs());

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
        SecurityRiskPolicy snapshot = SecurityRiskPolicyFactory.Create(CreateRiskInputs());

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
        SecurityRiskPolicy snapshot = SecurityRiskPolicyFactory.Create(
            CreateRiskInputs() with { PerceptionCharacterV3Enabled = false });

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
        SecurityRiskPolicy snapshot = SecurityRiskPolicyFactory.Create(
            CreateRiskInputs() with { PublicReadChallengeEnabled = false });

        SecurityRiskPolicyDecision publicRead = snapshot.Evaluate(RiskActionNames.PublicRead, 100);
        SecurityRiskPolicyDecision authLogin = snapshot.Evaluate(RiskActionNames.AuthLogin, 100);

        Assert.Equal(SecurityRiskPolicyOutcomes.Allow, publicRead.Outcome);
        Assert.Equal(SecurityRiskPolicyOutcomes.Block, authLogin.Outcome);
        Assert.False(snapshot.RequiresRiskScoreLookup(RiskActionNames.PublicRead));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void LegacyAdapter_InitializesRuntimeSubsystemModes()
    {
        SecurityRiskPolicy snapshot = SecurityRiskPolicyFactory.Create(CreateRiskInputs());

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
        SecurityAdminPolicyService service = new(CurrentRiskPolicyTestConfiguration.WithCurrentRiskPolicy(CreateConfiguration(new Dictionary<string, string?>
        {
            ["Security:RiskControl:GlobalMode"] = SecuritySystemModes.Observe,
            ["Security:RiskControl:PoSpaceV1:Enabled"] = "true",
            ["Security:RiskControl:PublicReadChallenge:Enabled"] = "false",
            ["Security:RiskControl:CommentRiskControl:Enabled"] = "false",
            ["Security:RiskControl:AuthRiskControl:Enabled"] = "false",
            ["Security:RiskControl:StrictRiskMultiplierPercent"] = "175"
        })));

        SecurityRiskPolicy snapshot = service.CurrentRiskPolicy;

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
        SecurityAdminPolicyService disabled = new(CurrentRiskPolicyTestConfiguration.WithCurrentRiskPolicy(CreateConfiguration()));
        SecurityAdminPolicyService enabled = new(CurrentRiskPolicyTestConfiguration.WithCurrentRiskPolicy(CreateConfiguration(new Dictionary<string, string?>
        {
            ["Security:PerceptionCharacterV3:Enabled"] = SecuritySystemModes.Enforce
        })));

        Assert.Equal(
            ["sha256PowV1"],
            disabled.CurrentRiskPolicy
                .Evaluate(RiskActionNames.RecoveryKeyVerify, 0)
                .RequiredChallengeKinds);
        Assert.Equal(
            ["perceptionCharacterV3"],
            enabled.CurrentRiskPolicy
                .Evaluate(RiskActionNames.RecoveryKeyVerify, 0)
                .RequiredChallengeKinds);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Positive)]
    public void SecurityAdminPolicyService_UpdateRiskControlPolicy_ProjectsEmergencySwitchesAndLkg()
    {
        SecurityAdminPolicyService service = new(CurrentRiskPolicyTestConfiguration.WithCurrentRiskPolicy(CreateConfiguration()));
        SecurityRiskPolicy before = service.CurrentRiskPolicy;

        SecurityRiskPolicy updated = service.UpdateRiskControlPolicy(
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
        SecurityAdminPolicyService service = new(CurrentRiskPolicyTestConfiguration.WithCurrentRiskPolicy(CreateConfiguration(new Dictionary<string, string?>
        {
            ["Security:PerceptionV2:Enabled"] = "false",
            ["Security:PerceptionV2:Localization:Enabled"] = "true",
            ["Security:PerceptionV2:MicroInteraction:Enabled"] = "true",
            ["Security:PerceptionV2:PoSpaceFallback:Enabled"] = "true",
            ["Security:PerceptionV2:EarlyRejectThreshold"] = "87",
            ["Security:PerceptionV2:MaxAttempts"] = "5",
            ["Security:PerceptionV2:MinSolveDurationMs"] = "1200",
            ["Security:PerceptionV2:MaxSolveDurationMs"] = "45000"
        })));

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
        SecurityAdminPolicyService service = new(CurrentRiskPolicyTestConfiguration.WithCurrentRiskPolicy(CreateConfiguration()));
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

        SecurityRiskPolicy riskPolicy = service.CurrentRiskPolicy;
        Assert.Equal(SecuritySystemModes.Enforce, riskPolicy.SubsystemModes[SecurityRiskSources.PerceptionLocalization]);
        Assert.Equal(SecuritySystemModes.Enforce, riskPolicy.SubsystemModes[SecurityRiskSources.PerceptionMicroInteraction]);
        Assert.Equal(SecuritySystemModes.Enforce, riskPolicy.SubsystemModes[SecurityRiskSources.PoSpace]);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative)]
    public void CurrentConfiguration_RejectsMissingAndLegacyOnlyPolicy()
    {
        Assert.Throws<ArgumentException>(() => new SecurityAdminPolicyService(new ConfigurationBuilder().Build()));
        Assert.Throws<ArgumentException>(() => new SecurityAdminPolicyService(CreateConfiguration(new Dictionary<string, string?>
        {
            ["AntiCrawler:Mode"] = "disabled",
            ["Security:Risk:RequireChallengeScore"] = "1"
        })));
    }

    [Theory]
    [InlineData("RiskControl:GlobalMode", "disabled")]
    [InlineData("Security:RiskControl:PublicReadChallengeEnabled", "false")]
    [InlineData("Security:RiskControl:GlobalMode", "unsupported")]
    [InlineData("Security:RiskControl:CommentRiskControl:Enabled", "invalid")]
    [InlineData("Security:RiskControl:PerceptionCharacterV3:Enabled", "false")]
    [InlineData("Security:RiskControl:CommentRiskControl:Enabled", "1")]
    [InlineData("Security:RiskControl:StrictRiskMultiplierPercent", "invalid")]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative)]
    public void CurrentConfiguration_RejectsAliasesAndIllegalValues(string key, string value)
    {
        IConfiguration configuration = CurrentRiskPolicyTestConfiguration.WithCurrentRiskPolicy(CreateConfiguration(new Dictionary<string, string?> { [key] = value }));
        Assert.Throws<ArgumentException>(() => new SecurityAdminPolicyService(configuration));
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative)]
    public void CanonicalPolicy_SealsCallerOwnedActionAndBandCollections()
    {
        SecurityRiskPolicy source = CreateSnapshot(SecuritySystemModes.Enforce);
        var actions = new Dictionary<string, SecurityRiskActionPolicy>(source.ActionOverrides);
        SecurityRiskPolicy policy = (source with { ActionOverrides = actions }).Seal();
        string digest = policy.Digest;
        actions[RiskActionNames.PublicRead] = actions[RiskActionNames.PublicRead] with
        {
            ModeOverride = SecuritySystemModes.Disabled
        };
        Assert.True(policy.RequiresRiskScoreLookup(RiskActionNames.PublicRead));
        Assert.Equal(digest, policy.Seal().Digest);
        Assert.NotEqual(digest, (source with { ActionOverrides = actions }).Seal().Digest);
    }

    [Fact]
    [CoversBehavior("configuration-error-security-policy", BehaviorTestKind.Negative)]
    public void CanonicalRollback_RestoresExactSnapshotDigestAndSubsystemCommandState()
    {
        var service = new SecurityAdminPolicyService(CurrentRiskPolicyTestConfiguration.WithCurrentRiskPolicy(CreateConfiguration()));
        SecurityRiskPolicy before = service.CurrentRiskPolicy;
        PowPolicySnapshot pow = service.CurrentPow;
        long builds = service.PolicyBuildCount;
        service.UpdatePowOptions(new PowOptionsUpdateRequest(SecuritySystemModes.Disabled, null, null, null, null, null, null), "admin:test");
        Assert.Equal(builds + 1, service.PolicyBuildCount);
        Assert.NotEqual(before.Digest, service.CurrentRiskPolicy.Digest);
        service.RollbackRiskControlPolicy("admin:test");
        Assert.Same(before, service.CurrentRiskPolicy);
        Assert.Equal(before.Digest, service.CurrentRiskPolicy.Digest);
        Assert.Same(pow, service.CurrentPow);
        Assert.Equal(builds + 1, service.PolicyBuildCount);
    }

    private static SecurityRiskPolicy CreateSnapshot(
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

    private static SecurityRiskPolicyInputs CreateRiskInputs()
        => new(SecuritySystemModes.Enforce, true, 200);

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
