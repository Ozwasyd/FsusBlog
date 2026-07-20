using FsusBlog.Server.Models.Security;

namespace FsusBlog.Server.Infrastructure.Security;

/// <summary>Converts between legacy anti-crawler risk settings and the versioned action-policy model.</summary>
public static class SecurityRiskPolicySnapshotV2Adapter
{
    public const string DefaultPolicyVersion = "risk-policy-v2";
    public const string PerceptionSealedV2Matrix = "perception-sealed@v2";
    private const string DefaultActionName = "*";
    private const string Sha256PowV1ChallengeKind = "sha256PowV1";
    private const string Argon2idPoSpaceV1ChallengeKind = "argon2idPoSpaceV1";
    private const string CharacterV3ChallengeKind = "perceptionCharacterV3";
    private const string LocalizationV2ChallengeKind = "perceptionLocalizationV2";
    private const string MicroInteractionV2ChallengeKind = "perceptionMicroInteractionV2";
    private const string AdminPasskeyStepUpV1ChallengeKind = "adminPasskeyStepUpV1";

    /// <summary>Builds the versioned perception-sealed policy matrix from legacy anti-crawler and proof-of-work settings.</summary>
    /// <param name="antiCrawler">The authoritative legacy anti-crawler snapshot.</param>
    /// <param name="pow">An optional proof-of-work snapshot used to derive the proof subsystem mode.</param>
    /// <returns>A versioned action and subsystem policy snapshot.</returns>
    public static SecurityRiskPolicySnapshotV2 FromLegacy(AntiCrawlerPolicySnapshot antiCrawler, PowPolicySnapshot? pow = null)
    {
        ArgumentNullException.ThrowIfNull(antiCrawler);

        AntiCrawlerPolicyOptions options = antiCrawler.Options;
        var defaultPolicy = CreatePerceptionSealedV2Policy(
            DefaultActionName,
            SecurityRiskPolicyOutcomes.HardChallenge,
            [MicroInteractionV2ChallengeKind],
            4,
            "perception_sealed_v2_micro_interaction",
            anonymousWriteAllowed: false);
        var publicReadPolicy = CreatePerceptionSealedV2Policy(
            RiskActionNames.PublicRead,
            SecurityRiskPolicyOutcomes.Throttle,
            [],
            0,
            "perception_sealed_v2_public_read_throttle",
            anonymousWriteAllowed: true);
        var commentCreatePolicy = CreatePerceptionSealedV2Policy(
            RiskActionNames.CommentCreate,
            SecurityRiskPolicyOutcomes.Queue,
            [],
            0,
            "perception_sealed_v2_comment_queue",
            anonymousWriteAllowed: false);
        var authLoginPolicy = CreatePerceptionSealedV2Policy(
            RiskActionNames.AuthLogin,
            SecurityRiskPolicyOutcomes.Throttle,
            [],
            0,
            "perception_sealed_v2_auth_throttle",
            anonymousWriteAllowed: false);
        var recoveryKeyVerifyPolicy = CreatePerceptionSealedV2Policy(
            RiskActionNames.RecoveryKeyVerify,
            SecurityRiskPolicyOutcomes.Throttle,
            [],
            0,
            "perception_sealed_v2_recovery_throttle",
            anonymousWriteAllowed: false,
            lowBand: new SecurityRiskDecisionBand(
                SecurityRiskPolicyOutcomes.Challenge,
                0,
                19,
                [CharacterV3ChallengeKind],
                1,
                "recovery_key_mandatory_character"));
        var notificationSubscribePolicy = CreatePerceptionSealedV2Policy(
            RiskActionNames.NotificationSubscribe,
            SecurityRiskPolicyOutcomes.HardChallenge,
            [Argon2idPoSpaceV1ChallengeKind],
            4,
            "perception_sealed_v2_notification_pospace",
            anonymousWriteAllowed: true,
            lowBand: new SecurityRiskDecisionBand(
                SecurityRiskPolicyOutcomes.Challenge,
                0,
                19,
                [Sha256PowV1ChallengeKind],
                1,
                "notification_subscribe_mandatory_pow"));
        var adminSecurityWritePolicy = CreatePerceptionSealedV2Policy(
            RiskActionNames.AdminSecurityWrite,
            SecurityRiskPolicyOutcomes.HardChallenge,
            [AdminPasskeyStepUpV1ChallengeKind],
            4,
            "perception_sealed_v2_admin_step_up",
            anonymousWriteAllowed: true);
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
            [SecurityRiskSources.Pow] = SecuritySystemModes.Normalize(pow?.Options.Mode ?? SecuritySystemModes.Enforce),
            [SecurityRiskSources.PublicRead] = options.PublicReadChallengeEnabled ? SecuritySystemModes.Enforce : SecuritySystemModes.Disabled,
            [SecurityRiskSources.PoSpace] = SecuritySystemModes.Disabled,
            [SecurityRiskSources.PerceptionLocalization] = SecuritySystemModes.Enforce,
            [SecurityRiskSources.PerceptionMicroInteraction] = SecuritySystemModes.Disabled
        };

        return new SecurityRiskPolicySnapshotV2(
            antiCrawler.SnapshotId,
            DefaultPolicyVersion,
            antiCrawler.UpdatedAtUtc,
            SecuritySystemModes.Normalize(options.Mode),
            options.MaxRiskScore,
            125,
            antiCrawler.SnapshotId,
            defaultPolicy,
            actionOverrides,
            subsystemModes);
    }

    /// <summary>Projects a versioned policy into the compatibility thresholds consumed by legacy readers.</summary>
    /// <param name="snapshot">The versioned policy snapshot to project.</param>
    /// <returns>A legacy snapshot derived from the public-read action and global limits.</returns>
    public static SecurityRiskPolicySnapshot ToLegacy(SecurityRiskPolicySnapshotV2 snapshot)
    {
        ArgumentNullException.ThrowIfNull(snapshot);

        SecurityRiskActionPolicy publicRead = snapshot.ResolveActionPolicy(RiskActionNames.PublicRead);
        SecurityRiskActionThresholds thresholds = publicRead.Thresholds;
        string mode = SecuritySystemModes.Normalize(publicRead.ModeOverride ?? snapshot.GlobalMode);
        return new SecurityRiskPolicySnapshot(
            snapshot.SnapshotId,
            thresholds.ChallengeScore,
            thresholds.BlockScore,
            snapshot.MaxRiskScore,
            SecuritySystemModes.IsEnforcing(mode),
            mode != SecuritySystemModes.Disabled,
            mode);
    }

    private static SecurityRiskActionPolicy CreatePerceptionSealedV2Policy(
        string actionName,
        string band80Outcome,
        IReadOnlyList<string> band80ChallengeKinds,
        int band80EscalationLevel,
        string band80Reason,
        bool anonymousWriteAllowed,
        SecurityRiskDecisionBand? lowBand = null)
        => new(
            actionName,
            BuildPerceptionSealedV2Thresholds(),
            Sha256PowV1ChallengeKind,
            1,
            null,
            anonymousWriteAllowed)
        {
            HardChallengeKinds = [LocalizationV2ChallengeKind, Sha256PowV1ChallengeKind],
            HardChallengeEscalationLevel = 3,
            DecisionMatrix = PerceptionSealedV2Matrix,
            DecisionBands =
            [
                lowBand ?? new SecurityRiskDecisionBand(SecurityRiskPolicyOutcomes.Allow, 0, 19, [], 0, "perception_sealed_v2_allow"),
                new SecurityRiskDecisionBand(SecurityRiskPolicyOutcomes.Challenge, 20, 39, [Sha256PowV1ChallengeKind], 1, "perception_sealed_v2_pow"),
                new SecurityRiskDecisionBand(SecurityRiskPolicyOutcomes.Challenge, 40, 59, [CharacterV3ChallengeKind], 2, "perception_character_v3"),
                new SecurityRiskDecisionBand(SecurityRiskPolicyOutcomes.HardChallenge, 60, 79, [LocalizationV2ChallengeKind, Sha256PowV1ChallengeKind], 3, "perception_sealed_v2_localization_pow"),
                new SecurityRiskDecisionBand(band80Outcome, 80, 89, band80ChallengeKinds, band80EscalationLevel, band80Reason),
                new SecurityRiskDecisionBand(SecurityRiskPolicyOutcomes.Block, 90, 1000, [], 0, "perception_sealed_v2_block")
            ]
        };

    private static SecurityRiskActionThresholds BuildPerceptionSealedV2Thresholds()
        => new(
            AllowScore: 19,
            ChallengeScore: 20,
            HardChallengeScore: 60,
            QueueScore: 80,
            BlockScore: 90);
}
