using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Models.Security;

namespace FsusBlog.Server.Infrastructure.Security;

public enum RiskDecisionKind
{
    Allow,
    Challenge,
    StepUp,
    QueueForModeration,
    Throttle,
    Block
}

public sealed record RiskDecision(
    RiskDecisionKind Kind,
    string ActionName,
    string RouteKey,
    int RiskScore,
    int EffectiveRiskScore,
    int EscalationLevel,
    IReadOnlyList<string> RequiredChallenges,
    string PolicyVersion,
    IReadOnlyList<string> Reasons);

public sealed record RiskControlDecisionContext(RiskDecision Decision)
{
    public const string HttpContextItemKey = "__fsus_risk_decision_context";
}

public interface IRiskDecisionService
{
    RiskDecision Decide(RiskControlContext context, SecurityRiskPolicySnapshotV2 policy, int currentRiskScore);
}

public sealed class RiskDecisionService : IRiskDecisionService
{
    private const string CaptchaV1ChallengeKind = "captchaV1";
    private const string Argon2idPoSpaceV1ChallengeKind = "argon2idPoSpaceV1";
    private const string Sha256PowV1ChallengeKind = "sha256PowV1";
    private const string LegacyPowChallengeKind = "security.pow";

    public RiskDecision Decide(RiskControlContext context, SecurityRiskPolicySnapshotV2 policy, int currentRiskScore)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(policy);

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
            reasons));
    }

    private static RiskDecision RecordAndReturn(RiskDecision decision)
    {
        FsusObservability.RecordSecurityDecision(decision);
        return decision;
    }

    private static RiskDecision Allow(RiskControlContext context, SecurityRiskPolicySnapshotV2 policy, int currentRiskScore, string reason)
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
            SecurityRiskPolicyOutcomes.Block or SecurityRiskPolicyOutcomes.LockdownBlock => RiskDecisionKind.Block,
            _ => RiskDecisionKind.Throttle
        };

    private static (IReadOnlyList<string> RequiredChallenges, IReadOnlyList<string> Reasons) BuildRequiredChallenges(
        RiskDecisionKind kind,
        IReadOnlyList<string> challengeKinds,
        RiskControlContext context,
        SecurityRiskPolicySnapshotV2 policy)
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

            if (string.Equals(challengeKind, Argon2idPoSpaceV1ChallengeKind, StringComparison.Ordinal))
            {
                if (!IsChallengeSubsystemEnforcing(policy, challengeKind))
                {
                    AddChallengeKindIfEnabled(required, CaptchaV1ChallengeKind, policy, reasons);
                    reasons.Add("pospace_disabled_downgraded");
                    continue;
                }

                if (IsMobileUserAgent(context.UserAgent))
                {
                    AddChallengeKindIfEnabled(required, CaptchaV1ChallengeKind, policy, reasons);
                    reasons.Add("pospace_mobile_downgraded");
                    continue;
                }
            }

            AddChallengeKindIfEnabled(required, challengeKind, policy, reasons);
        }

        return (required, reasons);
    }

    private static void AddChallengeKindIfEnabled(
        List<string> required,
        string challengeKind,
        SecurityRiskPolicySnapshotV2 policy,
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

    private static bool IsChallengeSubsystemEnforcing(SecurityRiskPolicySnapshotV2 policy, string challengeKind)
    {
        string? subsystem = challengeKind switch
        {
            CaptchaV1ChallengeKind => SecurityRiskSources.Captcha,
            Argon2idPoSpaceV1ChallengeKind => SecurityRiskSources.PoSpace,
            Sha256PowV1ChallengeKind or LegacyPowChallengeKind => SecurityRiskSources.Pow,
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
            CaptchaV1ChallengeKind => "captcha",
            Argon2idPoSpaceV1ChallengeKind => "pospace",
            Sha256PowV1ChallengeKind or LegacyPowChallengeKind => "pow",
            _ => "challenge"
        };

    private static bool IsAnonymousWrite(RiskControlContext context)
        => context.ActionName is RiskActionNames.CommentCreate or RiskActionNames.CommentReply
            && (context.Actor.Status == RiskControlActorStatuses.Anonymous
                || string.Equals(context.Actor.IdentityKind, RiskControlIdentityKinds.Anonymous, StringComparison.Ordinal)
                || string.Equals(context.Actor.IdentityKind, AnonymousIdentityRuntime.AnonymousAccountKind, StringComparison.Ordinal));
}
