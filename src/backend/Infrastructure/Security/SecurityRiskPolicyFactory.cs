using FsusBlog.Server.Models.Security;

namespace FsusBlog.Server.Infrastructure.Security;

/// <summary>Builds the canonical action policy from current typed subsystem inputs.</summary>
public static class SecurityRiskPolicyFactory
{
    public const string DefaultPolicyVersion = "risk-policy";
    public const string PerceptionSealedV2Matrix = "perception-sealed@v2";
    private const string DefaultActionName = "*";
    private static readonly string s_sha256PowV1ChallengeKind = SecurityChallengeContracts.ToWireName(SecurityChallengeKind.Sha256PowV1);
    private static readonly string s_argon2idPoSpaceV1ChallengeKind = SecurityChallengeContracts.ToWireName(SecurityChallengeKind.Argon2IdPoSpaceV1);
    private static readonly string s_characterV3ChallengeKind = SecurityChallengeContracts.ToWireName(SecurityChallengeKind.PerceptionCharacterV3);
    private static readonly string s_localizationV2ChallengeKind = SecurityChallengeContracts.ToWireName(SecurityChallengeKind.PerceptionLocalizationV2);
    private static readonly string s_microInteractionV2ChallengeKind = SecurityChallengeContracts.ToWireName(SecurityChallengeKind.PerceptionMicroInteractionV2);
    private static readonly string s_adminPasskeyStepUpV1ChallengeKind = SecurityChallengeContracts.ToWireName(SecurityChallengeKind.AdminPasskeyStepUpV1);

    public static SecurityRiskPolicy Create(
        SecurityRiskPolicyInputs options,
        string snapshotId = "risk-policy",
        DateTimeOffset? updatedAtUtc = null)
    {
        ArgumentNullException.ThrowIfNull(options);
        bool perceptionCharacterV3Enabled = options.PerceptionCharacterV3Enabled;
        string characterChallengeKind = perceptionCharacterV3Enabled
            ? s_characterV3ChallengeKind
            : s_sha256PowV1ChallengeKind;
        string recoveryChallengeReason = perceptionCharacterV3Enabled
            ? SecurityRiskPolicyReasons.RecoveryKeyMandatoryCharacter
            : SecurityRiskPolicyReasons.RecoveryKeyMandatoryPowFallback;
        var defaultPolicy = CreatePerceptionSealedV2Policy(
            DefaultActionName,
            SecurityRiskPolicyOutcomes.HardChallenge,
            [s_microInteractionV2ChallengeKind],
            4,
            SecurityRiskPolicyReasons.PerceptionSealedV2MicroInteraction,
            anonymousWriteAllowed: false,
            characterChallengeKind);
        var publicReadPolicy = CreatePerceptionSealedV2Policy(
            RiskActionNames.PublicRead,
            SecurityRiskPolicyOutcomes.Throttle,
            [],
            0,
            SecurityRiskPolicyReasons.PerceptionSealedV2PublicReadThrottle,
            anonymousWriteAllowed: true,
            characterChallengeKind);
        var commentCreatePolicy = CreatePerceptionSealedV2Policy(
            RiskActionNames.CommentCreate,
            SecurityRiskPolicyOutcomes.Queue,
            [],
            0,
            SecurityRiskPolicyReasons.PerceptionSealedV2CommentQueue,
            anonymousWriteAllowed: false,
            characterChallengeKind);
        var authLoginPolicy = CreatePerceptionSealedV2Policy(
            RiskActionNames.AuthLogin,
            SecurityRiskPolicyOutcomes.Throttle,
            [],
            0,
            SecurityRiskPolicyReasons.PerceptionSealedV2AuthThrottle,
            anonymousWriteAllowed: false,
            characterChallengeKind);
        var recoveryKeyVerifyPolicy = CreatePerceptionSealedV2Policy(
            RiskActionNames.RecoveryKeyVerify,
            SecurityRiskPolicyOutcomes.Throttle,
            [],
            0,
            SecurityRiskPolicyReasons.PerceptionSealedV2RecoveryThrottle,
            anonymousWriteAllowed: false,
            characterChallengeKind,
            lowBand: new SecurityRiskDecisionBand(
                SecurityRiskPolicyOutcomes.Challenge,
                0,
                SecurityRiskPolicyCatalog.AllowScore,
                [characterChallengeKind],
                1,
                recoveryChallengeReason));
        var notificationSubscribePolicy = CreatePerceptionSealedV2Policy(
            RiskActionNames.NotificationSubscribe,
            SecurityRiskPolicyOutcomes.HardChallenge,
            [s_argon2idPoSpaceV1ChallengeKind],
            4,
            SecurityRiskPolicyReasons.PerceptionSealedV2NotificationPospace,
            anonymousWriteAllowed: true,
            s_sha256PowV1ChallengeKind,
            hardChallengeKinds: [s_argon2idPoSpaceV1ChallengeKind],
            lowBand: new SecurityRiskDecisionBand(
                SecurityRiskPolicyOutcomes.Challenge,
                0,
                SecurityRiskPolicyCatalog.AllowScore,
                [s_sha256PowV1ChallengeKind],
                1,
                SecurityRiskPolicyReasons.NotificationSubscribeMandatoryPow),
            characterChallengeReason: SecurityRiskPolicyReasons.NotificationSubscribeHeadlessPow);
        var adminSecurityWritePolicy = CreatePerceptionSealedV2Policy(
            RiskActionNames.AdminSecurityWrite,
            SecurityRiskPolicyOutcomes.HardChallenge,
            [s_adminPasskeyStepUpV1ChallengeKind],
            4,
            SecurityRiskPolicyReasons.PerceptionSealedV2AdminStepUp,
            anonymousWriteAllowed: true,
            characterChallengeKind);
        var actionOverrides = new Dictionary<string, SecurityRiskActionPolicy>(StringComparer.Ordinal)
        {
            [RiskActionNames.PublicRead] = publicReadPolicy with
            {
                ModeOverride = options.PublicReadChallengeEnabled ? null : SecuritySystemModes.Disabled,
                AnonymousWriteAllowed = true
            },
            [RiskActionNames.CommentCreate] = commentCreatePolicy,
            [RiskActionNames.CommentReply] = commentCreatePolicy with { ActionName = RiskActionNames.CommentReply },
            [RiskActionNames.AuthLogin] = authLoginPolicy,
            [RiskActionNames.AuthPasskeyBegin] = defaultPolicy with { ActionName = RiskActionNames.AuthPasskeyBegin },
            [RiskActionNames.AuthPasskeyComplete] = defaultPolicy with { ActionName = RiskActionNames.AuthPasskeyComplete },
            [RiskActionNames.RecoveryKeyVerify] = recoveryKeyVerifyPolicy,
            [RiskActionNames.NotificationSubscribe] = notificationSubscribePolicy,
            [RiskActionNames.AdminSecurityWrite] = adminSecurityWritePolicy,
            [RiskActionNames.AdminCommentBatch] = defaultPolicy with
            {
                ActionName = RiskActionNames.AdminCommentBatch,
                AnonymousWriteAllowed = true
            }
        };
        var subsystemModes = new Dictionary<string, string>(StringComparer.Ordinal)
        {
            [SecurityRiskSources.AntiCrawler] = SecuritySystemModes.Normalize(options.Mode),
            [SecurityRiskSources.Auth] = SecuritySystemModes.Enforce,
            [SecurityRiskSources.CommentGovernance] = SecuritySystemModes.Enforce,
            [SecurityRiskSources.Pow] = SecuritySystemModes.Normalize(options.PowMode),
            [SecurityRiskSources.PublicRead] = options.PublicReadChallengeEnabled ? SecuritySystemModes.Enforce : SecuritySystemModes.Disabled,
            [SecurityRiskSources.PoSpace] = SecuritySystemModes.Disabled,
            [SecurityRiskSources.PerceptionLocalization] = SecuritySystemModes.Enforce,
            [SecurityRiskSources.PerceptionMicroInteraction] = SecuritySystemModes.Disabled
        };

        return new SecurityRiskPolicy(
            snapshotId,
            DefaultPolicyVersion,
            updatedAtUtc ?? DateTimeOffset.UtcNow,
            SecuritySystemModes.Normalize(options.Mode),
            options.MaxRiskScore,
            SecurityRiskPolicyCatalog.DefaultStrictRiskMultiplierPercent,
            snapshotId,
            defaultPolicy,
            actionOverrides,
            subsystemModes);
    }

    private static SecurityRiskActionPolicy CreatePerceptionSealedV2Policy(
        string actionName,
        string band80Outcome,
        IReadOnlyList<string> band80ChallengeKinds,
        int band80EscalationLevel,
        string band80Reason,
        bool anonymousWriteAllowed,
        string characterChallengeKind,
        IReadOnlyList<string>? hardChallengeKinds = null,
        SecurityRiskDecisionBand? lowBand = null,
        string? characterChallengeReason = null)
    {
        string resolvedCharacterChallengeReason = characterChallengeReason ?? (string.Equals(
            characterChallengeKind,
            s_characterV3ChallengeKind,
            StringComparison.Ordinal)
            ? SecurityRiskPolicyReasons.PerceptionCharacterV3
            : SecurityRiskPolicyReasons.PerceptionCharacterV3DisabledPowFallback);
        IReadOnlyList<string> resolvedHardChallengeKinds = hardChallengeKinds
            ?? [s_localizationV2ChallengeKind, s_sha256PowV1ChallengeKind];
        return new(
            actionName,
            BuildPerceptionSealedV2Thresholds(),
            s_sha256PowV1ChallengeKind,
            1,
            null,
            anonymousWriteAllowed)
        {
            HardChallengeKinds = resolvedHardChallengeKinds,
            HardChallengeEscalationLevel = 3,
            DecisionMatrix = PerceptionSealedV2Matrix,
            DecisionBands =
            [
                lowBand ?? new SecurityRiskDecisionBand(SecurityRiskPolicyOutcomes.Allow, 0, SecurityRiskPolicyCatalog.AllowScore, [], 0, SecurityRiskPolicyReasons.PerceptionSealedV2Allow),
                new SecurityRiskDecisionBand(SecurityRiskPolicyOutcomes.Challenge, SecurityRiskPolicyCatalog.ChallengeScore, SecurityRiskPolicyCatalog.CharacterChallengeScore - 1, [s_sha256PowV1ChallengeKind], 1, SecurityRiskPolicyReasons.PerceptionSealedV2Pow),
                new SecurityRiskDecisionBand(SecurityRiskPolicyOutcomes.Challenge, SecurityRiskPolicyCatalog.CharacterChallengeScore, SecurityRiskPolicyCatalog.HardChallengeScore - 1, [characterChallengeKind], 2, resolvedCharacterChallengeReason),
                new SecurityRiskDecisionBand(SecurityRiskPolicyOutcomes.HardChallenge, SecurityRiskPolicyCatalog.HardChallengeScore, SecurityRiskPolicyCatalog.QueueScore - 1, resolvedHardChallengeKinds, 3, SecurityRiskPolicyReasons.PerceptionSealedV2LocalizationPow),
                new SecurityRiskDecisionBand(band80Outcome, SecurityRiskPolicyCatalog.QueueScore, SecurityRiskPolicyCatalog.BlockScore - 1, band80ChallengeKinds, band80EscalationLevel, band80Reason),
                new SecurityRiskDecisionBand(SecurityRiskPolicyOutcomes.Block, SecurityRiskPolicyCatalog.BlockScore, SecurityRiskPolicyCatalog.MaximumBandScore, [], 0, SecurityRiskPolicyReasons.PerceptionSealedV2Block)
            ]
        };
    }

    private static SecurityRiskActionThresholds BuildPerceptionSealedV2Thresholds()
        => new(
            AllowScore: SecurityRiskPolicyCatalog.AllowScore,
            ChallengeScore: SecurityRiskPolicyCatalog.ChallengeScore,
            HardChallengeScore: SecurityRiskPolicyCatalog.HardChallengeScore,
            QueueScore: SecurityRiskPolicyCatalog.QueueScore,
            BlockScore: SecurityRiskPolicyCatalog.BlockScore);
}
