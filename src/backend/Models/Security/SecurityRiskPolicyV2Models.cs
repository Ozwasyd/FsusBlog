namespace FsusBlog.Server.Models.Security;

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

public sealed record SecurityRiskActionThresholds(
    int AllowScore,
    int ChallengeScore,
    int HardChallengeScore,
    int QueueScore,
    int BlockScore);

public sealed record SecurityRiskDecisionBand(
    string Outcome,
    int MinScore,
    int MaxScore,
    IReadOnlyList<string> ChallengeKinds,
    int EscalationLevel,
    string Reason);

public sealed record PerceptionChallengeGeneratorVariantPolicy(
    string Variant,
    int Weight,
    bool Enabled)
{
    public int RedTeamPenaltyPercent
    {
        get; init;
    }
}

public sealed record PerceptionChallengeGeneratorFamilyPolicy(
    string Family,
    int Weight,
    bool Enabled,
    IReadOnlyList<PerceptionChallengeGeneratorVariantPolicy> Variants)
{
    public int RedTeamPenaltyPercent
    {
        get; init;
    }
}

public sealed record PerceptionChallengeGeneratorOverride(
    IReadOnlyDictionary<string, int> FamilyWeights,
    IReadOnlyDictionary<string, IReadOnlyDictionary<string, int>> VariantWeights)
{
    public static PerceptionChallengeGeneratorOverride Empty
    {
        get;
    } = new(
        new Dictionary<string, int>(StringComparer.Ordinal),
        new Dictionary<string, IReadOnlyDictionary<string, int>>(StringComparer.Ordinal));
}

public sealed record PerceptionChallengeGeneratorRiskOverride(
    int MinEffectiveRiskScore,
    int MaxEffectiveRiskScore,
    PerceptionChallengeGeneratorOverride Override,
    string Reason);

public sealed record PerceptionChallengeGeneratorDistributionPolicy(
    string PolicyId,
    IReadOnlyList<PerceptionChallengeGeneratorFamilyPolicy> Families)
{
    public IReadOnlyDictionary<string, PerceptionChallengeGeneratorOverride> ActionOverrides
    {
        get; init;
    } =
        new Dictionary<string, PerceptionChallengeGeneratorOverride>(StringComparer.Ordinal);

    public IReadOnlyList<PerceptionChallengeGeneratorRiskOverride> RiskOverrides { get; init; } = [];

    public static PerceptionChallengeGeneratorDistributionPolicy Default
    {
        get;
    } = new(
        "perception-generator-default",
        [
            new PerceptionChallengeGeneratorFamilyPolicy(
                "text-stroke",
                40,
                true,
                [
                    new PerceptionChallengeGeneratorVariantPolicy("ink-quiet", 70, true),
                    new PerceptionChallengeGeneratorVariantPolicy("ink-dense", 30, true)
                ]),
            new PerceptionChallengeGeneratorFamilyPolicy(
                "spline-field",
                20,
                true,
                [
                    new PerceptionChallengeGeneratorVariantPolicy("curve-soft", 60, true),
                    new PerceptionChallengeGeneratorVariantPolicy("curve-split", 40, true)
                ]),
            new PerceptionChallengeGeneratorFamilyPolicy(
                "fourier-field",
                15,
                true,
                [
                    new PerceptionChallengeGeneratorVariantPolicy("phase-low", 60, true),
                    new PerceptionChallengeGeneratorVariantPolicy("phase-shift", 40, true)
                ]),
            new PerceptionChallengeGeneratorFamilyPolicy(
                "piecewise-warp",
                10,
                true,
                [
                    new PerceptionChallengeGeneratorVariantPolicy("warp-banded", 60, true),
                    new PerceptionChallengeGeneratorVariantPolicy("warp-tiled", 40, true)
                ]),
            new PerceptionChallengeGeneratorFamilyPolicy(
                "topology-cut",
                10,
                true,
                [
                    new PerceptionChallengeGeneratorVariantPolicy("cut-bridge", 60, true),
                    new PerceptionChallengeGeneratorVariantPolicy("cut-island", 40, true)
                ]),
            new PerceptionChallengeGeneratorFamilyPolicy(
                "localization-field",
                5,
                true,
                [
                    new PerceptionChallengeGeneratorVariantPolicy("anchor-grid", 60, true),
                    new PerceptionChallengeGeneratorVariantPolicy("anchor-region", 40, true)
                ])
        ]);
}

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

    public string DecisionMatrix { get; init; } = string.Empty;

    public IReadOnlyList<SecurityRiskDecisionBand> DecisionBands { get; init; } = [];
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
    public PerceptionChallengeGeneratorDistributionPolicy PerceptionGeneratorPolicy
    {
        get; init;
    } =
        PerceptionChallengeGeneratorDistributionPolicy.Default;

    public SecurityRiskActionPolicy ResolveActionPolicy(string? actionName)
    {
        string normalizedAction = NormalizeActionName(actionName);
        if (ActionOverrides.TryGetValue(normalizedAction, out SecurityRiskActionPolicy? actionPolicy))
        {
            return actionPolicy;
        }

        return DefaultAction with
        {
            ActionName = normalizedAction
        };
    }

    public bool RequiresRiskScoreLookup(string? actionName)
    {
        SecurityRiskActionPolicy actionPolicy = ResolveActionPolicy(actionName);
        string mode = SecuritySystemModes.Normalize(actionPolicy.ModeOverride ?? GlobalMode);
        return mode != SecuritySystemModes.Disabled;
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

        SecurityRiskDecisionBand? decisionBand = ResolveDecisionBand(actionPolicy, effectiveRiskScore);
        string thresholdOutcome = decisionBand?.Outcome ?? ResolveThresholdOutcome(effectiveRiskScore, thresholds);
        if (mode == SecuritySystemModes.Observe)
        {
            return thresholdOutcome == SecurityRiskPolicyOutcomes.Allow
                ? BuildDecision(actionPolicy, mode, SecurityRiskPolicyOutcomes.Allow, false, boundedRiskScore, effectiveRiskScore, "below_threshold")
                : BuildDecision(actionPolicy, mode, SecurityRiskPolicyOutcomes.Observe, false, boundedRiskScore, effectiveRiskScore, decisionBand?.Reason ?? thresholdOutcome);
        }

        if (mode == SecuritySystemModes.Lockdown && isAnonymousWrite && !actionPolicy.AnonymousWriteAllowed)
        {
            return BuildDecision(actionPolicy, mode, SecurityRiskPolicyOutcomes.LockdownBlock, true, boundedRiskScore, effectiveRiskScore, "anonymous_write_lockdown");
        }

        if (decisionBand is not null)
        {
            return BuildDecision(actionPolicy, mode, decisionBand, boundedRiskScore, effectiveRiskScore);
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

    private static SecurityRiskPolicyDecision BuildDecision(
        SecurityRiskActionPolicy actionPolicy,
        string mode,
        SecurityRiskDecisionBand decisionBand,
        int riskScore,
        int effectiveRiskScore)
    {
        string outcome = NormalizeOutcome(decisionBand.Outcome);
        IReadOnlyList<string> requiredChallenges = ResolveRequiredChallenges(actionPolicy, outcome, decisionBand.ChallengeKinds);
        return new SecurityRiskPolicyDecision(
            actionPolicy.ActionName,
            mode,
            outcome,
            outcome != SecurityRiskPolicyOutcomes.Allow,
            riskScore,
            effectiveRiskScore,
            requiredChallenges.Count > 0 ? requiredChallenges[0] : string.Empty,
            requiredChallenges,
            requiredChallenges.Count > 0 ? Math.Max(0, decisionBand.EscalationLevel) : 0,
            string.IsNullOrWhiteSpace(decisionBand.Reason) ? outcome : decisionBand.Reason.Trim());
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

    private static IReadOnlyList<string> ResolveRequiredChallenges(
        SecurityRiskActionPolicy actionPolicy,
        string outcome,
        IReadOnlyList<string> configured)
    {
        if (outcome is not (SecurityRiskPolicyOutcomes.Challenge or SecurityRiskPolicyOutcomes.HardChallenge))
        {
            return [];
        }

        return configured.Count == 0
            ? ResolveRequiredChallenges(actionPolicy, outcome)
            : NormalizeChallengeKinds(configured);
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

    private static SecurityRiskDecisionBand? ResolveDecisionBand(SecurityRiskActionPolicy actionPolicy, int effectiveRiskScore)
    {
        foreach (SecurityRiskDecisionBand band in actionPolicy.DecisionBands)
        {
            int min = Math.Max(0, band.MinScore);
            int max = Math.Max(min, band.MaxScore);
            if (effectiveRiskScore >= min && effectiveRiskScore <= max)
            {
                return band;
            }
        }

        return null;
    }

    private static string NormalizeOutcome(string? outcome)
    {
        string normalized = (outcome ?? string.Empty).Trim();
        return normalized switch
        {
            SecurityRiskPolicyOutcomes.Allow => SecurityRiskPolicyOutcomes.Allow,
            SecurityRiskPolicyOutcomes.Challenge => SecurityRiskPolicyOutcomes.Challenge,
            SecurityRiskPolicyOutcomes.HardChallenge => SecurityRiskPolicyOutcomes.HardChallenge,
            SecurityRiskPolicyOutcomes.Queue => SecurityRiskPolicyOutcomes.Queue,
            SecurityRiskPolicyOutcomes.Throttle => SecurityRiskPolicyOutcomes.Throttle,
            SecurityRiskPolicyOutcomes.Block => SecurityRiskPolicyOutcomes.Block,
            SecurityRiskPolicyOutcomes.LockdownBlock => SecurityRiskPolicyOutcomes.LockdownBlock,
            SecurityRiskPolicyOutcomes.Observe => SecurityRiskPolicyOutcomes.Observe,
            _ => SecurityRiskPolicyOutcomes.Throttle
        };
    }

    private static string NormalizeActionName(string? actionName)
    {
        string normalized = (actionName ?? string.Empty).Trim();
        return normalized.Length == 0 ? "*" : normalized;
    }
}
