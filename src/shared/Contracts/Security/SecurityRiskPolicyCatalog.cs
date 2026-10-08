namespace FsusBlog.Shared.Contracts.Security;

public static class SecuritySystemModes
{
    public const string Disabled = "disabled";
    public const string Observe = "observe";
    public const string Enforce = "enforce";
    public const string Strict = "strict";
    public const string Lockdown = "lockdown";

    public static string Normalize(string? mode)
    {
        string value = mode?.Trim().ToLowerInvariant() ?? Enforce;
        return value is Disabled or Observe or Enforce or Strict or Lockdown ? value : Enforce;
    }

    public static bool IsEnforcing(string mode)
        => Normalize(mode) is Enforce or Strict or Lockdown;
}

public static class SecurityRiskPolicyOutcomes
{
    public const string Allow = "allow";
    public const string Observe = "observe";
    public const string Challenge = "challenge";
    public const string HardChallenge = "hard_challenge";
    public const string Queue = "queue";
    public const string Throttle = "throttle";
    public const string Block = "block";
    public const string LockdownBlock = "lockdown_block";
}

/// <summary>Owns the fixed current action-band boundaries across server and client projections.</summary>
public static class SecurityRiskPolicyCatalog
{
    public const int AllowScore = 19;
    public const int ChallengeScore = 20;
    public const int CharacterChallengeScore = 40;
    public const int HardChallengeScore = 60;
    public const int QueueScore = 80;
    public const int BlockScore = 90;
    public const int MaximumBandScore = 1000;
    public const int DefaultStrictRiskMultiplierPercent = 125;
}

/// <summary>Owns current canonical decision-band and evaluation reason codes.</summary>
public static class SecurityRiskPolicyReasons
{
    public const string AnonymousWriteLockdown = "anonymous_write_lockdown";
    public const string BelowThreshold = "below_threshold";
    public const string ModeDisabled = "mode_disabled";
    public const string NotificationSubscribeHeadlessPow = "notification_subscribe_headless_pow";
    public const string NotificationSubscribeMandatoryPow = "notification_subscribe_mandatory_pow";
    public const string PerceptionCharacterV3 = "perception_character_v3";
    public const string PerceptionCharacterV3DisabledPowFallback = "perception_character_v3_disabled_pow_fallback";
    public const string PerceptionSealedV2AdminStepUp = "perception_sealed_v2_admin_step_up";
    public const string PerceptionSealedV2Allow = "perception_sealed_v2_allow";
    public const string PerceptionSealedV2AuthThrottle = "perception_sealed_v2_auth_throttle";
    public const string PerceptionSealedV2Block = "perception_sealed_v2_block";
    public const string PerceptionSealedV2CommentQueue = "perception_sealed_v2_comment_queue";
    public const string PerceptionSealedV2LocalizationPow = "perception_sealed_v2_localization_pow";
    public const string PerceptionSealedV2MicroInteraction = "perception_sealed_v2_micro_interaction";
    public const string PerceptionSealedV2NotificationPospace = "perception_sealed_v2_notification_pospace";
    public const string PerceptionSealedV2Pow = "perception_sealed_v2_pow";
    public const string PerceptionSealedV2PublicReadThrottle = "perception_sealed_v2_public_read_throttle";
    public const string PerceptionSealedV2RecoveryThrottle = "perception_sealed_v2_recovery_throttle";
    public const string RecoveryKeyMandatoryCharacter = "recovery_key_mandatory_character";
    public const string RecoveryKeyMandatoryPowFallback = "recovery_key_mandatory_pow_fallback";
}
