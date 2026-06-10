using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Moderation;

namespace FsusBlog.Server.Services.Moderation;

public sealed class RegionLegalModerationService : IRegionLegalModerationService
{
    public const string CurrentPolicyVersion = "region-policy-v2026-06";

    private static readonly string[] EnabledViewerRegions =
    [
        RegionCodes.MainlandChina,
        RegionCodes.HongKong,
        RegionCodes.Macao,
        RegionCodes.Taiwan,
        RegionCodes.Singapore,
        RegionCodes.UnitedStates,
        RegionCodes.Germany,
        RegionCodes.Japan,
        RegionCodes.Korea,
        RegionCodes.Unknown
    ];

    private static readonly Dictionary<string, string[]> CategoryTokens = new(StringComparer.Ordinal)
    {
        [ModerationRiskCategories.PoliticalSensitive] =
        [
            "political_sensitive",
            "cn_mainland_political_sensitive",
            "六四",
            "天安门事件"
        ],
        [ModerationRiskCategories.Pornographic] =
        [
            "pornographic",
            "cn_mainland_pornographic",
            "色情",
            "黄色内容"
        ],
        [ModerationRiskCategories.SexualExplicit] =
        [
            "sexual_explicit",
            "露骨色情"
        ],
        [ModerationRiskCategories.SexualSuggestionHigh] =
        [
            "sexual_suggestion_high",
            "高风险性暗示"
        ],
        [ModerationRiskCategories.Gambling] =
        [
            "gambling",
            "博彩引流"
        ],
        [ModerationRiskCategories.TerrorismExtremism] =
        [
            "terrorism_extremism",
            "极端主义"
        ],
        [ModerationRiskCategories.ViolenceExtreme] =
        [
            "violence_extreme",
            "极端暴力"
        ],
        [ModerationRiskCategories.NationalSecurityRisk] =
        [
            "national_security_risk"
        ],
        [ModerationRiskCategories.PublicOrderRisk] =
        [
            "public_order_risk",
            "rumor_disrupting_public_order"
        ]
    };

    private static readonly HashSet<string> MainlandStrictCategories =
    [
        ModerationRiskCategories.PoliticalSensitive,
        ModerationRiskCategories.Pornographic,
        ModerationRiskCategories.SexualExplicit,
        ModerationRiskCategories.SexualSuggestionHigh,
        ModerationRiskCategories.Gambling,
        ModerationRiskCategories.TerrorismExtremism,
        ModerationRiskCategories.ViolenceExtreme,
        ModerationRiskCategories.NationalSecurityRisk,
        ModerationRiskCategories.PublicOrderRisk
    ];

    public RegionModerationDecision EvaluateOnSubmit(RegionModerationRequest request)
    {
        string submitRegion = NormalizeRegion(request.SubmitRegion);
        string[] categories = DetectCategories(request.Content);
        var blockedRegions = new SortedSet<string>(StringComparer.Ordinal);
        var riskLabels = new SortedSet<string>(StringComparer.Ordinal);
        var hits = new List<RegionRuleHit>();

        foreach (string viewerRegion in EnabledViewerRegions)
        {
            if (viewerRegion == RegionCodes.MainlandChina && HasMainlandStrictHit(categories))
            {
                blockedRegions.Add(RegionCodes.MainlandChina);
                foreach (string category in categories.Where(MainlandStrictCategories.Contains))
                {
                    riskLabels.Add($"cn_mainland_{category}");
                    hits.Add(BuildMainlandHit(category, submitRegion));
                }
            }
        }

        bool unknownSubmit = submitRegion == RegionCodes.Unknown;
        bool submitRejected = submitRegion == RegionCodes.MainlandChina && HasMainlandStrictHit(categories);
        bool requiresManualReview = unknownSubmit;
        bool hideUntilReviewed = unknownSubmit;
        string decisionReason = submitRejected
            ? "submit_region_policy_reject"
            : unknownSubmit
                ? "unknown_submit_region_manual_review_no_public_display"
                : blockedRegions.Count > 0
                    ? "viewer_region_geo_block"
                    : "region_policy_allow";

        return new RegionModerationDecision(
            CanPublish: !submitRejected,
            SubmitRegion: submitRegion,
            SubmitRegionConfidence: Math.Clamp(request.SubmitRegionConfidence, 0d, 1d),
            RegionProvider: string.IsNullOrWhiteSpace(request.RegionProvider) ? "unknown" : request.RegionProvider,
            SubmitIpHash: request.SubmitIpHash,
            BlockedRegions: blockedRegions.ToArray(),
            RiskLabels: riskLabels.ToArray(),
            RuleHits: hits.ToArray(),
            PolicyVersion: CurrentPolicyVersion,
            DecisionReason: decisionReason,
            PublicReason: submitRejected ? "该内容不符合当前地区发布规则。" : string.Empty,
            RequiresManualReview: requiresManualReview,
            HideUntilReviewed: hideUntilReviewed);
    }

    public bool IsBlockedForViewer(string viewerRegion, string blockedRegions)
    {
        string normalizedRegion = NormalizeRegion(viewerRegion);
        string value = blockedRegions ?? string.Empty;
        if (string.IsNullOrWhiteSpace(value))
        {
            return false;
        }

        if (normalizedRegion == RegionCodes.Unknown)
        {
            return true;
        }

        return value.Contains(BuildRegionToken(normalizedRegion), StringComparison.Ordinal);
    }

    public RegionPolicyReplayDiff PreviewReplay(CommentRegionCompliance current, RegionModerationDecision nextDecision)
    {
        string[] previousBlockedRegions = [.. DeserializeRegions(current.BlockedRegions)];
        string[] nextBlockedRegions = [.. nextDecision.BlockedRegions
            .Where(static region => !string.IsNullOrWhiteSpace(region))
            .Select(static region => region.Trim().ToUpperInvariant())
            .Distinct(StringComparer.Ordinal)
            .OrderBy(static region => region, StringComparer.Ordinal)];
        string[] previousRiskLabels = ParseLabels(current.RiskLabels);
        string[] nextRiskLabels = [.. nextDecision.RiskLabels
            .Where(static label => !string.IsNullOrWhiteSpace(label))
            .Select(static label => label.Trim())
            .Distinct(StringComparer.Ordinal)
            .OrderBy(static label => label, StringComparer.Ordinal)];

        string[] addedBlocked = [.. nextBlockedRegions.Except(previousBlockedRegions, StringComparer.Ordinal).OrderBy(static region => region, StringComparer.Ordinal)];
        string[] removedBlocked = [.. previousBlockedRegions.Except(nextBlockedRegions, StringComparer.Ordinal).OrderBy(static region => region, StringComparer.Ordinal)];
        string[] addedLabels = [.. nextRiskLabels.Except(previousRiskLabels, StringComparer.Ordinal).OrderBy(static label => label, StringComparer.Ordinal)];
        string[] removedLabels = [.. previousRiskLabels.Except(nextRiskLabels, StringComparer.Ordinal).OrderBy(static label => label, StringComparer.Ordinal)];
        bool publishabilityChanged = current.CanPublish != nextDecision.CanPublish;
        bool manualReviewChanged = current.RequiresManualReview != nextDecision.RequiresManualReview
            || current.HideUntilReviewed != nextDecision.HideUntilReviewed;

        return new RegionPolicyReplayDiff(
            current.CommentId,
            current.PolicyVersion,
            nextDecision.PolicyVersion,
            addedBlocked,
            removedBlocked,
            addedLabels,
            removedLabels,
            publishabilityChanged,
            manualReviewChanged,
            addedBlocked.Length > 0 || removedBlocked.Length > 0 || publishabilityChanged || manualReviewChanged);
    }

    public string NormalizeRegion(string? region)
        => (region ?? string.Empty).Trim().ToUpperInvariant() switch
        {
            "GLOBAL" => RegionCodes.Global,
            "UNKNOWN" or "" => RegionCodes.Unknown,
            "CN" or "CN-MAINLAND" or "MAINLAND" => RegionCodes.MainlandChina,
            "HK" or "CN-HK" => RegionCodes.HongKong,
            "MO" or "CN-MO" => RegionCodes.Macao,
            "TW" or "CN-TW" => RegionCodes.Taiwan,
            "SG" => RegionCodes.Singapore,
            "US" => RegionCodes.UnitedStates,
            "DE" or "EU-DE" => RegionCodes.Germany,
            "EU" => RegionCodes.EuropeanUnion,
            "JP" => RegionCodes.Japan,
            "KR" => RegionCodes.Korea,
            var value => value.Length is > 0 and <= 64 ? value : RegionCodes.Unknown
        };

    public static string SerializeRegions(IEnumerable<string> regions)
    {
        string[] normalized = [.. regions
            .Where(static region => !string.IsNullOrWhiteSpace(region))
            .Select(static region => region.Trim().ToUpperInvariant())
            .Distinct(StringComparer.Ordinal)
            .OrderBy(static region => region, StringComparer.Ordinal)];
        return normalized.Length == 0 ? string.Empty : $",{string.Join(',', normalized)},";
    }

    public static IReadOnlyList<string> DeserializeRegions(string? stored)
        => (stored ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(static region => region, StringComparer.Ordinal)
            .ToArray();

    private static string[] ParseLabels(string? stored)
        => (stored ?? string.Empty)
            .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
            .Distinct(StringComparer.Ordinal)
            .OrderBy(static label => label, StringComparer.Ordinal)
            .ToArray();

    private static string[] DetectCategories(string content)
    {
        if (string.IsNullOrWhiteSpace(content))
        {
            return [];
        }

        var categories = new SortedSet<string>(StringComparer.Ordinal);
        foreach ((string category, string[] tokens) in CategoryTokens)
        {
            if (tokens.Any(token => content.Contains(token, StringComparison.OrdinalIgnoreCase)))
            {
                categories.Add(category);
            }
        }

        return categories.ToArray();
    }

    private static bool HasMainlandStrictHit(IEnumerable<string> categories)
        => categories.Any(MainlandStrictCategories.Contains);

    private static RegionRuleHit BuildMainlandHit(string category, string submitRegion)
    {
        string submitAction = submitRegion == RegionCodes.MainlandChina
            ? "reject_submit"
            : "allow_submit";
        return new RegionRuleHit(
            $"cn-mainland.strict.{category}",
            RegionCodes.MainlandChina,
            category,
            category == ModerationRiskCategories.SexualSuggestionHigh ? "high" : "critical",
            submitAction,
            "geo_block",
            "当前地区不可发布或展示",
            "CN-MAINLAND strict policy applies only to CN-MAINLAND submit/viewer regions.");
    }

    private static string BuildRegionToken(string region)
        => $",{region},";
}
