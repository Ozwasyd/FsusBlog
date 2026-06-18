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
    bool AnonymousWriteAllowed)
{
    public IReadOnlyList<string> HardChallengeKinds { get; init; } = [];

    public int HardChallengeEscalationLevel { get; init; } = 2;
}

public sealed record SecurityRiskPolicyDecision(
    string ActionName,
    string Mode,
    string Outcome,
    bool Enforced,
    int RiskScore,
    int EffectiveRiskScore,
    string ChallengeKind,
    IReadOnlyList<string> RequiredChallengeKinds,
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
    {
        IReadOnlyList<string> requiredChallenges = ResolveRequiredChallenges(actionPolicy, outcome);
        return new SecurityRiskPolicyDecision(
            actionPolicy.ActionName,
            mode,
            outcome,
            enforced,
            riskScore,
            effectiveRiskScore,
            requiredChallenges.Count > 0 ? requiredChallenges[0] : string.Empty,
            requiredChallenges,
            requiredChallenges.Count > 0 ? ResolveEscalationLevel(actionPolicy, outcome) : 0,
            reason);
    }

    private static IReadOnlyList<string> ResolveRequiredChallenges(SecurityRiskActionPolicy actionPolicy, string outcome)
    {
        if (outcome is not (SecurityRiskPolicyOutcomes.Challenge or SecurityRiskPolicyOutcomes.HardChallenge))
        {
            return [];
        }

        IReadOnlyList<string> configured = outcome == SecurityRiskPolicyOutcomes.HardChallenge
            ? actionPolicy.HardChallengeKinds
            : [];
        if (configured.Count == 0)
        {
            configured = string.IsNullOrWhiteSpace(actionPolicy.ChallengeKind)
                ? []
                : [actionPolicy.ChallengeKind];
        }

        return NormalizeChallengeKinds(configured);
    }

    private static int ResolveEscalationLevel(SecurityRiskActionPolicy actionPolicy, string outcome)
        => outcome == SecurityRiskPolicyOutcomes.HardChallenge && actionPolicy.HardChallengeKinds.Count > 0
            ? Math.Max(actionPolicy.EscalationLevel, actionPolicy.HardChallengeEscalationLevel)
            : actionPolicy.EscalationLevel;

    private static IReadOnlyList<string> NormalizeChallengeKinds(IEnumerable<string> kinds)
    {
        var normalized = new List<string>();
        foreach (string kind in kinds)
        {
            string value = (kind ?? string.Empty).Trim();
            if (value.Length == 0 || normalized.Contains(value, StringComparer.Ordinal))
            {
                continue;
            }

            normalized.Add(value);
        }

        return normalized;
    }

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
