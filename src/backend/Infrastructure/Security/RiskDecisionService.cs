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

public interface IRiskDecisionService
{
    RiskDecision Decide(RiskControlContext context, SecurityRiskPolicySnapshotV2 policy, int currentRiskScore);
}

public sealed class RiskDecisionService : IRiskDecisionService
{
    public RiskDecision Decide(RiskControlContext context, SecurityRiskPolicySnapshotV2 policy, int currentRiskScore)
    {
        ArgumentNullException.ThrowIfNull(context);
        ArgumentNullException.ThrowIfNull(policy);

        if (context.VerifiedCrawler)
        {
            return Allow(context, policy, currentRiskScore, "verified_crawler");
        }

        if (context.SocialPreviewBot)
        {
            return Allow(context, policy, currentRiskScore, "social_preview_bot");
        }

        SecurityRiskPolicyDecision policyDecision = policy.Evaluate(
            context.ActionName,
            currentRiskScore,
            IsAnonymousWrite(context));
        RiskDecisionKind kind = MapKind(policyDecision);
        IReadOnlyList<string> requiredChallenges = BuildRequiredChallenges(kind, policyDecision.ChallengeKind);
        List<string> reasons = [policyDecision.Reason];
        if (context.ActionStatus == RiskControlContextStatuses.Missing)
        {
            reasons.Add("missing_action");
        }

        return new RiskDecision(
            kind,
            context.ActionName,
            context.RouteKey,
            policyDecision.RiskScore,
            policyDecision.EffectiveRiskScore,
            policyDecision.EscalationLevel,
            requiredChallenges,
            policy.PolicyVersion,
            reasons);
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
            SecurityRiskPolicyOutcomes.Challenge or SecurityRiskPolicyOutcomes.HardChallenge => IsStepUpChallenge(policyDecision.ChallengeKind)
                ? RiskDecisionKind.StepUp
                : RiskDecisionKind.Challenge,
            SecurityRiskPolicyOutcomes.Queue => RiskDecisionKind.QueueForModeration,
            SecurityRiskPolicyOutcomes.Block or SecurityRiskPolicyOutcomes.LockdownBlock => RiskDecisionKind.Block,
            _ => RiskDecisionKind.Throttle
        };

    private static IReadOnlyList<string> BuildRequiredChallenges(RiskDecisionKind kind, string challengeKind)
        => (kind is RiskDecisionKind.Challenge or RiskDecisionKind.StepUp) && !string.IsNullOrWhiteSpace(challengeKind)
            ? [challengeKind]
            : [];

    private static bool IsStepUpChallenge(string challengeKind)
        => challengeKind.Contains("step-up", StringComparison.OrdinalIgnoreCase)
            || challengeKind.Contains("stepup", StringComparison.OrdinalIgnoreCase);

    private static bool IsAnonymousWrite(RiskControlContext context)
        => context.Actor.Status == RiskControlActorStatuses.Anonymous
            && context.ActionName is RiskActionNames.CommentCreate or RiskActionNames.CommentReply;
}
