namespace FsusBlog.Server.Models.Moderation;

public static class RegionCodes
{
    public const string Global = "GLOBAL";
    public const string Unknown = "UNKNOWN";
    public const string MainlandChina = "CN-MAINLAND";
    public const string HongKong = "CN-HK";
    public const string Macao = "CN-MO";
    public const string Taiwan = "CN-TW";
    public const string Singapore = "SG";
    public const string UnitedStates = "US";
    public const string EuropeanUnion = "EU";
    public const string Germany = "EU-DE";
    public const string Japan = "JP";
    public const string Korea = "KR";
}

public static class ModerationRiskCategories
{
    public const string PoliticalSensitive = "political_sensitive";
    public const string Pornographic = "pornographic";
    public const string SexualExplicit = "sexual_explicit";
    public const string SexualSuggestionHigh = "sexual_suggestion_high";
    public const string Gambling = "gambling";
    public const string TerrorismExtremism = "terrorism_extremism";
    public const string ViolenceExtreme = "violence_extreme";
    public const string NationalSecurityRisk = "national_security_risk";
    public const string PublicOrderRisk = "public_order_risk";
}

public sealed record ClientRegionResolution(
    string Region,
    string Provider,
    double Confidence,
    string? ClientIp,
    string? ClientIpHash);

public sealed record RegionModerationRequest(
    string Content,
    int ArticleId,
    int UserId,
    string SubmitRegion,
    double SubmitRegionConfidence,
    string RegionProvider,
    string? SubmitIpHash,
    string? UserAgent,
    DateTime SubmittedAtUtc);

public sealed record RegionRuleHit(
    string RuleId,
    string Region,
    string Category,
    string Severity,
    string SubmitAction,
    string DisplayAction,
    string PublicReason,
    string InternalReason);

public sealed record RegionModerationDecision(
    bool CanPublish,
    string SubmitRegion,
    double SubmitRegionConfidence,
    string RegionProvider,
    string? SubmitIpHash,
    IReadOnlyList<string> BlockedRegions,
    IReadOnlyList<string> RiskLabels,
    IReadOnlyList<RegionRuleHit> RuleHits,
    string PolicyVersion,
    string DecisionReason,
    string PublicReason,
    bool RequiresManualReview,
    bool HideUntilReviewed);

public sealed record RegionPolicyReplayDiff(
    long CommentId,
    string PreviousPolicyVersion,
    string NextPolicyVersion,
    IReadOnlyList<string> AddedBlockedRegions,
    IReadOnlyList<string> RemovedBlockedRegions,
    IReadOnlyList<string> AddedRiskLabels,
    IReadOnlyList<string> RemovedRiskLabels,
    bool PublishabilityChanged,
    bool ManualReviewChanged,
    bool PublicVisibilityChanged);
