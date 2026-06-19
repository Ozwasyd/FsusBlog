using System.Security.Cryptography;
using System.Text;
using FsusBlog.Server.Models.Security;

namespace FsusBlog.Server.Services.Security;

public readonly record struct PerceptionChallengeV2GeneratorSelection(string Family, string Variant);

public static class PerceptionChallengeV2GeneratorFamilyRegistry
{
    public const string TextStroke = "text-stroke";
    public const string SplineField = "spline-field";
    public const string FourierField = "fourier-field";
    public const string PiecewiseWarp = "piecewise-warp";
    public const string TopologyCut = "topology-cut";
    public const string LocalizationField = "localization-field";

    public static IReadOnlySet<string> SupportedFamilies { get; } = new HashSet<string>(StringComparer.Ordinal)
    {
        TextStroke,
        SplineField,
        FourierField,
        PiecewiseWarp,
        TopologyCut,
        LocalizationField
    };

    public static IReadOnlyList<PerceptionChallengeGeneratorVariantPolicy> DefaultVariants(string family)
        => NormalizeFamily(family) switch
        {
            TextStroke =>
            [
                new PerceptionChallengeGeneratorVariantPolicy("ink-quiet", 70, true),
                new PerceptionChallengeGeneratorVariantPolicy("ink-dense", 30, true)
            ],
            SplineField =>
            [
                new PerceptionChallengeGeneratorVariantPolicy("curve-soft", 60, true),
                new PerceptionChallengeGeneratorVariantPolicy("curve-split", 40, true)
            ],
            FourierField =>
            [
                new PerceptionChallengeGeneratorVariantPolicy("phase-low", 60, true),
                new PerceptionChallengeGeneratorVariantPolicy("phase-shift", 40, true)
            ],
            PiecewiseWarp =>
            [
                new PerceptionChallengeGeneratorVariantPolicy("warp-banded", 60, true),
                new PerceptionChallengeGeneratorVariantPolicy("warp-tiled", 40, true)
            ],
            TopologyCut =>
            [
                new PerceptionChallengeGeneratorVariantPolicy("cut-bridge", 60, true),
                new PerceptionChallengeGeneratorVariantPolicy("cut-island", 40, true)
            ],
            LocalizationField =>
            [
                new PerceptionChallengeGeneratorVariantPolicy("anchor-grid", 60, true),
                new PerceptionChallengeGeneratorVariantPolicy("anchor-region", 40, true)
            ],
            _ => [new PerceptionChallengeGeneratorVariantPolicy("ink-quiet", 100, true)]
        };

    public static string NormalizeFamily(string? family)
    {
        string normalized = (family ?? string.Empty).Trim();
        return SupportedFamilies.Contains(normalized) ? normalized : TextStroke;
    }

    public static string DefaultVariant(string family)
        => DefaultVariants(family)[0].Variant;
}

public static class PerceptionChallengeV2GeneratorSelector
{
    public static PerceptionChallengeV2GeneratorSelection Select(
        PerceptionChallengeGeneratorDistributionPolicy? policy,
        string? actionName,
        int effectiveRiskScore,
        string entropyMaterial)
    {
        PerceptionChallengeGeneratorDistributionPolicy resolvedPolicy =
            policy is null || policy.Families.Count == 0
                ? PerceptionChallengeGeneratorDistributionPolicy.Default
                : policy;
        string normalizedAction = NormalizeAction(actionName);
        PerceptionChallengeGeneratorOverride actionOverride = ResolveActionOverride(resolvedPolicy, normalizedAction);
        PerceptionChallengeGeneratorOverride riskOverride = ResolveRiskOverride(resolvedPolicy, effectiveRiskScore);

        IReadOnlyList<WeightedFamily> families = BuildFamilyCandidates(resolvedPolicy, actionOverride, riskOverride);
        if (families.Count == 0 && !ReferenceEquals(resolvedPolicy, PerceptionChallengeGeneratorDistributionPolicy.Default))
        {
            return Select(PerceptionChallengeGeneratorDistributionPolicy.Default, normalizedAction, effectiveRiskScore, entropyMaterial);
        }

        if (families.Count == 0)
        {
            string fallbackFamily = PerceptionChallengeV2GeneratorFamilyRegistry.TextStroke;
            return new PerceptionChallengeV2GeneratorSelection(
                fallbackFamily,
                PerceptionChallengeV2GeneratorFamilyRegistry.DefaultVariant(fallbackFamily));
        }

        WeightedFamily selectedFamily = Pick(families, entropyMaterial, "family");
        IReadOnlyList<WeightedVariant> variants = BuildVariantCandidates(selectedFamily.Policy, actionOverride, riskOverride);
        if (variants.Count == 0)
        {
            return new PerceptionChallengeV2GeneratorSelection(
                selectedFamily.Family,
                PerceptionChallengeV2GeneratorFamilyRegistry.DefaultVariant(selectedFamily.Family));
        }

        WeightedVariant selectedVariant = Pick(variants, entropyMaterial, "variant");
        return new PerceptionChallengeV2GeneratorSelection(selectedFamily.Family, selectedVariant.Variant);
    }

    private static IReadOnlyList<WeightedFamily> BuildFamilyCandidates(
        PerceptionChallengeGeneratorDistributionPolicy policy,
        PerceptionChallengeGeneratorOverride actionOverride,
        PerceptionChallengeGeneratorOverride riskOverride)
    {
        var families = new List<WeightedFamily>();
        foreach (PerceptionChallengeGeneratorFamilyPolicy familyPolicy in policy.Families)
        {
            string family = (familyPolicy.Family ?? string.Empty).Trim();
            if (!familyPolicy.Enabled || !PerceptionChallengeV2GeneratorFamilyRegistry.SupportedFamilies.Contains(family))
            {
                continue;
            }

            int weight = ResolveWeight(
                familyPolicy.Weight,
                family,
                actionOverride.FamilyWeights,
                riskOverride.FamilyWeights);
            weight = ApplyPenalty(weight, familyPolicy.RedTeamPenaltyPercent);
            if (weight <= 0)
            {
                continue;
            }

            families.Add(new WeightedFamily(family, weight, familyPolicy));
        }

        return families;
    }

    private static IReadOnlyList<WeightedVariant> BuildVariantCandidates(
        PerceptionChallengeGeneratorFamilyPolicy familyPolicy,
        PerceptionChallengeGeneratorOverride actionOverride,
        PerceptionChallengeGeneratorOverride riskOverride)
    {
        string family = (familyPolicy.Family ?? string.Empty).Trim();
        IReadOnlyList<PerceptionChallengeGeneratorVariantPolicy> source =
            familyPolicy.Variants.Count > 0
                ? familyPolicy.Variants
                : PerceptionChallengeV2GeneratorFamilyRegistry.DefaultVariants(family);
        IReadOnlyDictionary<string, int> actionWeights = ResolveVariantWeights(actionOverride, family);
        IReadOnlyDictionary<string, int> riskWeights = ResolveVariantWeights(riskOverride, family);
        var variants = new List<WeightedVariant>();
        foreach (PerceptionChallengeGeneratorVariantPolicy variantPolicy in source)
        {
            string variant = (variantPolicy.Variant ?? string.Empty).Trim();
            if (!variantPolicy.Enabled || !IsSafeToken(variant))
            {
                continue;
            }

            int weight = ResolveWeight(
                variantPolicy.Weight,
                variant,
                actionWeights,
                riskWeights);
            weight = ApplyPenalty(weight, variantPolicy.RedTeamPenaltyPercent);
            if (weight <= 0)
            {
                continue;
            }

            variants.Add(new WeightedVariant(variant, weight));
        }

        return variants;
    }

    private static PerceptionChallengeGeneratorOverride ResolveActionOverride(
        PerceptionChallengeGeneratorDistributionPolicy policy,
        string actionName)
    {
        if (policy.ActionOverrides.TryGetValue(actionName, out PerceptionChallengeGeneratorOverride? specific))
        {
            return specific;
        }

        return policy.ActionOverrides.TryGetValue("*", out PerceptionChallengeGeneratorOverride? fallback)
            ? fallback
            : PerceptionChallengeGeneratorOverride.Empty;
    }

    private static PerceptionChallengeGeneratorOverride ResolveRiskOverride(
        PerceptionChallengeGeneratorDistributionPolicy policy,
        int effectiveRiskScore)
    {
        int score = Math.Max(0, effectiveRiskScore);
        foreach (PerceptionChallengeGeneratorRiskOverride riskOverride in policy.RiskOverrides)
        {
            int min = Math.Max(0, riskOverride.MinEffectiveRiskScore);
            int max = Math.Max(min, riskOverride.MaxEffectiveRiskScore);
            if (score >= min && score <= max)
            {
                return riskOverride.Override ?? PerceptionChallengeGeneratorOverride.Empty;
            }
        }

        return PerceptionChallengeGeneratorOverride.Empty;
    }

    private static IReadOnlyDictionary<string, int> ResolveVariantWeights(
        PerceptionChallengeGeneratorOverride generatorOverride,
        string family)
        => generatorOverride.VariantWeights.TryGetValue(family, out IReadOnlyDictionary<string, int>? weights)
            ? weights
            : new Dictionary<string, int>(0, StringComparer.Ordinal);

    private static int ResolveWeight(
        int fallback,
        string key,
        IReadOnlyDictionary<string, int> actionWeights,
        IReadOnlyDictionary<string, int> riskWeights)
    {
        int weight = fallback;
        if (actionWeights.TryGetValue(key, out int actionWeight))
        {
            weight = actionWeight;
        }

        if (riskWeights.TryGetValue(key, out int riskWeight))
        {
            weight = riskWeight;
        }

        return Math.Max(0, weight);
    }

    private static int ApplyPenalty(int weight, int penaltyPercent)
    {
        int penalty = Math.Clamp(penaltyPercent, 0, 100);
        return penalty == 0 ? weight : (weight * Math.Max(0, 100 - penalty)) / 100;
    }

    private static T Pick<T>(IReadOnlyList<T> candidates, string entropyMaterial, string salt)
        where T : IWeightedCandidate
    {
        long total = 0;
        for (int i = 0; i < candidates.Count; i++)
        {
            total += candidates[i].Weight;
        }

        if (total <= 0)
        {
            return candidates[0];
        }

        long bucket = (long)(ReadEntropy(entropyMaterial, salt) % (ulong)total);
        long cursor = 0;
        for (int i = 0; i < candidates.Count; i++)
        {
            cursor += candidates[i].Weight;
            if (bucket < cursor)
            {
                return candidates[i];
            }
        }

        return candidates[^1];
    }

    private static ulong ReadEntropy(string entropyMaterial, string salt)
    {
        byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes(string.Join('|', salt, entropyMaterial ?? string.Empty)));
        return BitConverter.ToUInt64(hash, 0);
    }

    private static string NormalizeAction(string? actionName)
    {
        string normalized = (actionName ?? string.Empty).Trim();
        return normalized.Length == 0 ? "*" : normalized;
    }

    private static bool IsSafeToken(string value)
    {
        if (value.Length is <= 0 or > 64)
        {
            return false;
        }

        for (int i = 0; i < value.Length; i++)
        {
            char ch = value[i];
            if (!((ch >= 'a' && ch <= 'z') ||
                  (ch >= 'A' && ch <= 'Z') ||
                  (ch >= '0' && ch <= '9') ||
                  ch is '-' or '_' or ':' or '.'))
            {
                return false;
            }
        }

        return true;
    }

    private interface IWeightedCandidate
    {
        int Weight { get; }
    }

    private sealed record WeightedFamily(
        string Family,
        int Weight,
        PerceptionChallengeGeneratorFamilyPolicy Policy) : IWeightedCandidate;

    private sealed record WeightedVariant(string Variant, int Weight) : IWeightedCandidate;
}
