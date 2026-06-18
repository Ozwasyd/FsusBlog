namespace FsusBlog.Server.Models.Security;

public static class SecurityRiskPolicyOutcomes
{
    public const string Allow = "allow";
    public const string Observe = "observe";
    public const string Challenge = "challenge";
    public const string HardChallenge = "hard_challenge";
    public const string Queue = "queue";
    public const string Block = "block";
    public const string LockdownBlock = "lockdown_block";
}

public sealed record SecurityRiskActionThresholds(
    int AllowScore,
    int ChallengeScore,
    int HardChallengeScore,
    int QueueScore,
    int BlockScore);

public sealed record SecurityRiskActionPolicy(
    string ActionName,
    SecurityRiskActionThresholds Thresholds,
    string ChallengeKind,
    int EscalationLevel,
    string? ModeOverride,
    bool AnonymousWriteAllowed);

public sealed record SecurityRiskPolicyDecision(
    string ActionName,
    string Mode,
    string Outcome,
    bool Enforced,
    int RiskScore,
    int EffectiveRiskScore,
    string ChallengeKind,
    int EscalationLevel,
    string Reason);

public sealed record SecurityRiskPolicySnapshotV2(
    string SnapshotId,
    string PolicyVersion,
    DateTimeOffset UpdatedAtUtc,
    string GlobalMode,
    int MaxRiskScore,
    int StrictRiskMultiplierPercent,
    string? LastKnownGoodSnapshotId,
    SecurityRiskActionPolicy DefaultAction,
    IReadOnlyDictionary<string, SecurityRiskActionPolicy> ActionOverrides,
    IReadOnlyDictionary<string, string> SubsystemModes)
{
    public SecurityRiskActionPolicy ResolveActionPolicy(string? actionName)
    {
        string normalizedAction = NormalizeActionName(actionName);
        if (ActionOverrides.TryGetValue(normalizedAction, out SecurityRiskActionPolicy? actionPolicy))
        {
            return actionPolicy;
        }

        return DefaultAction with { ActionName = normalizedAction };
    }

    public SecurityRiskPolicyDecision Evaluate(string? actionName, int riskScore, bool isAnonymousWrite = false)
    {
        SecurityRiskActionPolicy actionPolicy = ResolveActionPolicy(actionName);
        string mode = SecuritySystemModes.Normalize(actionPolicy.ModeOverride ?? GlobalMode);
        SecurityRiskActionThresholds thresholds = NormalizeThresholds(actionPolicy.Thresholds);
        int boundedRiskScore = Math.Clamp(riskScore, 0, Math.Max(MaxRiskScore, thresholds.BlockScore));
        int effectiveRiskScore = mode == SecuritySystemModes.Strict
            ? ApplyStrictRiskWeight(boundedRiskScore)
            : boundedRiskScore;

        if (mode == SecuritySystemModes.Disabled)
        {
            return BuildDecision(actionPolicy, mode, SecurityRiskPolicyOutcomes.Allow, false, boundedRiskScore, effectiveRiskScore, "mode_disabled");
        }

        string thresholdOutcome = ResolveThresholdOutcome(effectiveRiskScore, thresholds);
        if (mode == SecuritySystemModes.Observe)
        {
            return thresholdOutcome == SecurityRiskPolicyOutcomes.Allow
                ? BuildDecision(actionPolicy, mode, SecurityRiskPolicyOutcomes.Allow, false, boundedRiskScore, effectiveRiskScore, "below_threshold")
                : BuildDecision(actionPolicy, mode, SecurityRiskPolicyOutcomes.Observe, false, boundedRiskScore, effectiveRiskScore, thresholdOutcome);
        }

        if (mode == SecuritySystemModes.Lockdown && isAnonymousWrite && !actionPolicy.AnonymousWriteAllowed)
        {
            return BuildDecision(actionPolicy, mode, SecurityRiskPolicyOutcomes.LockdownBlock, true, boundedRiskScore, effectiveRiskScore, "anonymous_write_lockdown");
        }

        return BuildDecision(
            actionPolicy,
            mode,
            thresholdOutcome,
            thresholdOutcome != SecurityRiskPolicyOutcomes.Allow,
            boundedRiskScore,
            effectiveRiskScore,
            thresholdOutcome == SecurityRiskPolicyOutcomes.Allow ? "below_threshold" : thresholdOutcome);
    }

    private int ApplyStrictRiskWeight(int riskScore)
    {
        int multiplier = Math.Clamp(StrictRiskMultiplierPercent, 100, 1000);
        long weighted = ((long)riskScore * multiplier + 99) / 100;
        return (int)Math.Clamp(weighted, 0, Math.Max(MaxRiskScore, riskScore));
    }

    private static SecurityRiskPolicyDecision BuildDecision(
        SecurityRiskActionPolicy actionPolicy,
        string mode,
        string outcome,
        bool enforced,
        int riskScore,
        int effectiveRiskScore,
        string reason)
        => new(
            actionPolicy.ActionName,
            mode,
            outcome,
            enforced,
            riskScore,
            effectiveRiskScore,
            outcome is SecurityRiskPolicyOutcomes.Challenge or SecurityRiskPolicyOutcomes.HardChallenge
                ? actionPolicy.ChallengeKind
                : string.Empty,
            outcome is SecurityRiskPolicyOutcomes.Challenge or SecurityRiskPolicyOutcomes.HardChallenge
                ? actionPolicy.EscalationLevel
                : 0,
            reason);

    private static string ResolveThresholdOutcome(int effectiveRiskScore, SecurityRiskActionThresholds thresholds)
    {
        if (effectiveRiskScore >= thresholds.BlockScore)
        {
            return SecurityRiskPolicyOutcomes.Block;
        }

        if (effectiveRiskScore >= thresholds.QueueScore)
        {
            return SecurityRiskPolicyOutcomes.Queue;
        }

        if (effectiveRiskScore >= thresholds.HardChallengeScore)
        {
            return SecurityRiskPolicyOutcomes.HardChallenge;
        }

        return effectiveRiskScore >= thresholds.ChallengeScore
            ? SecurityRiskPolicyOutcomes.Challenge
            : SecurityRiskPolicyOutcomes.Allow;
    }

    private static SecurityRiskActionThresholds NormalizeThresholds(SecurityRiskActionThresholds thresholds)
    {
        int challenge = Math.Max(0, thresholds.ChallengeScore);
        int allow = Math.Clamp(thresholds.AllowScore, 0, Math.Max(0, challenge - 1));
        int hardChallenge = Math.Max(challenge, thresholds.HardChallengeScore);
        int queue = Math.Max(hardChallenge, thresholds.QueueScore);
        int block = Math.Max(queue, thresholds.BlockScore);
        return new SecurityRiskActionThresholds(allow, challenge, hardChallenge, queue, block);
    }

    private static string NormalizeActionName(string? actionName)
    {
        string normalized = (actionName ?? string.Empty).Trim();
        return normalized.Length == 0 ? "*" : normalized;
    }
}
