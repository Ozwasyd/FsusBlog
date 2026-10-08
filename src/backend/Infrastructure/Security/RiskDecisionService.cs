using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Models.Security;

namespace FsusBlog.Server.Infrastructure.Security;

/// <summary>
/// Identifies the enforcement disposition selected by risk policy evaluation.
/// </summary>
public enum RiskDecisionKind
{
    Allow,
    Challenge,
    StepUp,
    QueueForModeration,
    Throttle,
    Block
}

/// <summary>
/// Represents the resolved enforcement outcome together with challenge and audit rationale.
/// </summary>
/// <param name="Kind">Selected enforcement disposition.</param>
/// <param name="ActionName">Risk action evaluated by the policy.</param>
/// <param name="RouteKey">Route-specific policy key.</param>
/// <param name="RiskScore">Current stored score before policy adjustments.</param>
/// <param name="EffectiveRiskScore">Score after action and policy adjustments.</param>
/// <param name="EscalationLevel">Challenge escalation level selected by the decision band.</param>
/// <param name="RequiredChallenges">Ordered challenge kinds required before the action may continue.</param>
/// <param name="PolicyVersion">Policy version that produced the decision.</param>
/// <param name="Reasons">Machine-readable reasons explaining the outcome and any fallback.</param>
public sealed record RiskDecision(
    RiskDecisionKind Kind,
    string ActionName,
    string RouteKey,
    int RiskScore,
    int EffectiveRiskScore,
    int EscalationLevel,
    IReadOnlyList<string> RequiredChallenges,
    string PolicyVersion,
    IReadOnlyList<string> Reasons)
{
    public PerceptionChallengeGeneratorDistributionPolicy PerceptionGeneratorPolicy
    {
        get; init;
    } =
        PerceptionChallengeGeneratorDistributionPolicy.Default;
}

/// <summary>
/// Carries the resolved risk decision through the current HTTP request pipeline.
/// </summary>
/// <param name="Decision">Decision produced for the protected action.</param>
public sealed record RiskControlDecisionContext(RiskDecision Decision)
{
    public const string HttpContextItemKey = "__fsus_risk_decision_context";
}

/// <summary>
/// Evaluates normalized request context and accumulated score against a versioned risk policy.
/// </summary>
public interface IRiskDecisionService
{
    RiskDecision Decide(RiskControlContext context, SecurityRiskPolicy policy, int currentRiskScore);
}

/// <summary>
/// Maps policy bands to enforceable dispositions and available challenge subsystems.
/// </summary>
public sealed class RiskDecisionService : IRiskDecisionService
{
    private const string Argon2idPoSpaceV1ChallengeKind = "argon2idPoSpaceV1";
    private const string Sha256PowV1ChallengeKind = "sha256PowV1";
    private const string LegacyPowChallengeKind = "security.pow";
    private const string LocalizationV2ChallengeKind = "perceptionLocalizationV2";
    private const string MicroInteractionV2ChallengeKind = "perceptionMicroInteractionV2";

    /// <summary>
    /// Resolves an enforcement decision, including challenge fallback and trusted-request bypass rules.
    /// </summary>
    /// <param name="context">Normalized action, actor, device, region, and crawler context.</param>
    /// <param name="policy">Versioned policy snapshot used for this evaluation.</param>
    /// <param name="currentRiskScore">Accumulated non-negative score before action-specific policy evaluation.</param>
    /// <returns>The disposition, effective score, required challenges, and audit reasons.</returns>
    public RiskDecision Decide(RiskControlContext context, SecurityRiskPolicy policy, int currentRiskScore)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(policy);

        if (context.DevelopmentLocalBypass)
        {
            return RecordAndReturn(Allow(context, policy, currentRiskScore, "development_local_bypass"));
        }

        if (context.VerifiedCrawler)
        {
            return RecordAndReturn(Allow(context, policy, currentRiskScore, "verified_crawler"));
        }

        if (context.SocialPreviewBot)
        {
            return RecordAndReturn(Allow(context, policy, currentRiskScore, "social_preview_bot"));
        }

        SecurityRiskPolicyDecision policyDecision = policy.Evaluate(
            context.ActionName,
            currentRiskScore,
            IsAnonymousWrite(context));
        RiskDecisionKind kind = MapKind(policyDecision);
        if (TryResolvePoSpaceRouteRejection(context, policyDecision, policy, out string poSpaceRejectReason))
        {
            return RecordAndReturn(new RiskDecision(
                RiskDecisionKind.Block,
                context.ActionName,
                context.RouteKey,
                policyDecision.RiskScore,
                policyDecision.EffectiveRiskScore,
                policyDecision.EscalationLevel,
                [],
                policy.PolicyVersion,
                [policyDecision.Reason, poSpaceRejectReason])
            {
                PerceptionGeneratorPolicy = policy.PerceptionGeneratorPolicy
            });
        }

        (IReadOnlyList<string> requiredChallenges, IReadOnlyList<string> challengeReasons) = BuildRequiredChallenges(
            kind,
            policyDecision.RequiredChallengeKinds,
            context,
            policy);
        if (kind is RiskDecisionKind.Challenge or RiskDecisionKind.StepUp && requiredChallenges.Count == 0)
        {
            kind = RiskDecisionKind.Allow;
            challengeReasons = [.. challengeReasons, "challenge_subsystems_disabled"];
        }

        List<string> reasons = [policyDecision.Reason];
        reasons.AddRange(challengeReasons);
        if (context.ActionStatus == RiskControlContextStatuses.Missing)
        {
            reasons.Add("missing_action");
        }

        return RecordAndReturn(new RiskDecision(
            kind,
            context.ActionName,
            context.RouteKey,
            policyDecision.RiskScore,
            policyDecision.EffectiveRiskScore,
            policyDecision.EscalationLevel,
            requiredChallenges,
            policy.PolicyVersion,
            reasons)
        {
            PerceptionGeneratorPolicy = policy.PerceptionGeneratorPolicy
        });
    }

    private static RiskDecision RecordAndReturn(RiskDecision decision)
    {
        FsusObservability.RecordSecurityDecision(decision);
        return decision;
    }

    private static RiskDecision Allow(RiskControlContext context, SecurityRiskPolicy policy, int currentRiskScore, string reason)
        => new(
            RiskDecisionKind.Allow,
            context.ActionName,
            context.RouteKey,
            Math.Max(0, currentRiskScore),
            Math.Max(0, currentRiskScore),
            0,
            [],
            policy.PolicyVersion,
            [reason]);

    private static RiskDecisionKind MapKind(SecurityRiskPolicyDecision policyDecision)
        => policyDecision.Outcome switch
        {
            SecurityRiskPolicyOutcomes.Allow => RiskDecisionKind.Allow,
            SecurityRiskPolicyOutcomes.Observe => RiskDecisionKind.Allow,
            SecurityRiskPolicyOutcomes.Challenge or SecurityRiskPolicyOutcomes.HardChallenge => IsStepUpChallenge(policyDecision.RequiredChallengeKinds)
                ? RiskDecisionKind.StepUp
                : RiskDecisionKind.Challenge,
            SecurityRiskPolicyOutcomes.Queue => RiskDecisionKind.QueueForModeration,
            SecurityRiskPolicyOutcomes.Throttle => RiskDecisionKind.Throttle,
            SecurityRiskPolicyOutcomes.Block or SecurityRiskPolicyOutcomes.LockdownBlock => RiskDecisionKind.Block,
            _ => RiskDecisionKind.Throttle
        };

    private static (IReadOnlyList<string> RequiredChallenges, IReadOnlyList<string> Reasons) BuildRequiredChallenges(
        RiskDecisionKind kind,
        IReadOnlyList<string> challengeKinds,
        RiskControlContext context,
        SecurityRiskPolicy policy)
    {
        if (kind is not (RiskDecisionKind.Challenge or RiskDecisionKind.StepUp))
        {
            return ([], []);
        }

        var required = new List<string>();
        var reasons = new List<string>();
        foreach (string rawKind in challengeKinds)
        {
            string challengeKind = (rawKind ?? string.Empty).Trim();
            if (challengeKind.Length == 0)
            {
                continue;
            }

            AddChallengeKindIfEnabled(required, challengeKind, policy, reasons);
        }

        return (required, reasons);
    }

    private static void AddChallengeKindIfEnabled(
        List<string> required,
        string challengeKind,
        SecurityRiskPolicy policy,
        List<string> reasons)
    {
        if (!IsChallengeSubsystemEnforcing(policy, challengeKind))
        {
            reasons.Add($"{NormalizeChallengeKindReason(challengeKind)}_disabled");
            return;
        }

        AddChallengeKind(required, challengeKind);
    }

    private static void AddChallengeKind(List<string> required, string challengeKind)
    {
        if (!required.Contains(challengeKind, StringComparer.Ordinal))
        {
            required.Add(challengeKind);
        }
    }

    private static bool IsMobileUserAgent(string userAgent)
    {
        string value = userAgent ?? string.Empty;
        return value.Contains("Android", StringComparison.OrdinalIgnoreCase)
            || value.Contains("iPhone", StringComparison.OrdinalIgnoreCase)
            || value.Contains("iPad", StringComparison.OrdinalIgnoreCase)
            || value.Contains("Mobile", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsStepUpChallenge(IReadOnlyList<string> challengeKinds)
        => challengeKinds.Any(static challengeKind =>
            challengeKind.Contains("step-up", StringComparison.OrdinalIgnoreCase)
            || challengeKind.Contains("stepup", StringComparison.OrdinalIgnoreCase));

    private static bool TryResolvePoSpaceRouteRejection(
        RiskControlContext context,
        SecurityRiskPolicyDecision policyDecision,
        SecurityRiskPolicy policy,
        out string reason)
    {
        reason = string.Empty;
        if (context.ActionName != RiskActionNames.NotificationSubscribe
            || !policyDecision.RequiredChallengeKinds.Contains(Argon2idPoSpaceV1ChallengeKind, StringComparer.Ordinal))
        {
            return false;
        }

        if (!IsChallengeSubsystemEnforcing(policy, Argon2idPoSpaceV1ChallengeKind))
        {
            reason = "pospace_disabled_rejected";
            return true;
        }

        if (IsMobileUserAgent(context.UserAgent))
        {
            reason = "pospace_mobile_rejected";
            return true;
        }

        return false;
    }

    private static bool IsChallengeSubsystemEnforcing(SecurityRiskPolicy policy, string challengeKind)
    {
        string? subsystem = challengeKind switch
        {
            Argon2idPoSpaceV1ChallengeKind => SecurityRiskSources.PoSpace,
            Sha256PowV1ChallengeKind or LegacyPowChallengeKind => SecurityRiskSources.Pow,
            LocalizationV2ChallengeKind => SecurityRiskSources.PerceptionLocalization,
            MicroInteractionV2ChallengeKind => SecurityRiskSources.PerceptionMicroInteraction,
            _ => null
        };
        if (subsystem is null)
        {
            return true;
        }

        return !policy.SubsystemModes.TryGetValue(subsystem, out string? mode)
            || SecuritySystemModes.IsEnforcing(mode);
    }

    private static string NormalizeChallengeKindReason(string challengeKind)
        => challengeKind switch
        {
            Argon2idPoSpaceV1ChallengeKind => "pospace",
            Sha256PowV1ChallengeKind or LegacyPowChallengeKind => "pow",
            LocalizationV2ChallengeKind => "perception_localization",
            MicroInteractionV2ChallengeKind => "perception_micro_interaction",
            _ => "challenge"
        };

    private static bool IsAnonymousWrite(RiskControlContext context)
        => context.ActionName is RiskActionNames.CommentCreate or RiskActionNames.CommentReply
            && (context.Actor.Status == RiskControlActorStatuses.Anonymous
                || string.Equals(context.Actor.IdentityKind, RiskControlIdentityKinds.Anonymous, StringComparison.Ordinal)
                || string.Equals(context.Actor.IdentityKind, AnonymousIdentityRuntime.AnonymousAccountKind, StringComparison.Ordinal));
}
