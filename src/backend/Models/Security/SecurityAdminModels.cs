namespace FsusBlog.Server.Models.Security;

public static class SecuritySystemModes
{
    public const string Disabled = "disabled";
    public const string Observe = "observe";
    public const string Enforce = "enforce";
    public const string Strict = "strict";

    public static string Normalize(string? mode)
    {
        string value = string.IsNullOrWhiteSpace(mode)
            ? Enforce
            : mode.Trim().ToLowerInvariant();
        return value is Disabled or Observe or Enforce or Strict ? value : Enforce;
    }

    public static bool IsEnforcing(string mode)
        => Normalize(mode) is Enforce or Strict;
}

public sealed record AntiCrawlerPolicyOptions(
    string Mode,
    bool PublicReadChallengeEnabled,
    bool SearchCrawlerVerificationEnabled,
    bool SocialPreviewGuardEnabled,
    bool RiskScoringEnabled,
    bool EventPersistenceEnabled,
    bool DashboardAggregationEnabled,
    bool CidrAutoUpdateEnabled,
    bool IllegalPathHardAbortEnabled,
    int RequireChallengeScore,
    int BlockScore,
    int MaxRiskScore,
    int DefaultRiskTtlSeconds,
    int ZeroRiskCacheTtlSeconds,
    int FixedIpPermitLimit,
    int FixedIpQueueLimit,
    int VerifiedCrawlerFixedIpPermitLimit,
    int PublicReadPermitLimit,
    int PublicReadQueueLimit,
    int VerifiedCrawlerPublicReadPermitLimit,
    int SocialPreviewPublicReadPermitLimit,
    int ReadProofPermitLimit,
    int CidrUpdateIntervalMinutes,
    int CidrInitialDelaySeconds,
    int CidrMinUpdateIntervalMinutes,
    string GoogleCrawlerRangesUrl,
    string BingCrawlerRangesUrl,
    string? SnapshotPath,
    IReadOnlyList<string> SocialPreviewAllowedPathPrefixes,
    IReadOnlyList<string> BlockedUserAgentKeywords,
    string SecurityChallengeReference);

public sealed record AntiCrawlerOptionsUpdateRequest(
    string? Mode,
    bool? PublicReadChallengeEnabled,
    bool? SearchCrawlerVerificationEnabled,
    bool? SocialPreviewGuardEnabled,
    bool? RiskScoringEnabled,
    bool? EventPersistenceEnabled,
    bool? DashboardAggregationEnabled,
    bool? CidrAutoUpdateEnabled,
    bool? IllegalPathHardAbortEnabled,
    int? RequireChallengeScore,
    int? BlockScore,
    int? MaxRiskScore,
    int? DefaultRiskTtlSeconds,
    int? ZeroRiskCacheTtlSeconds,
    int? FixedIpPermitLimit,
    int? FixedIpQueueLimit,
    int? VerifiedCrawlerFixedIpPermitLimit,
    int? PublicReadPermitLimit,
    int? PublicReadQueueLimit,
    int? VerifiedCrawlerPublicReadPermitLimit,
    int? SocialPreviewPublicReadPermitLimit,
    int? ReadProofPermitLimit,
    int? CidrUpdateIntervalMinutes,
    int? CidrInitialDelaySeconds,
    int? CidrMinUpdateIntervalMinutes,
    string? GoogleCrawlerRangesUrl,
    string? BingCrawlerRangesUrl,
    string? SnapshotPath,
    IReadOnlyList<string>? SocialPreviewAllowedPathPrefixes,
    IReadOnlyList<string>? BlockedUserAgentKeywords,
    string? Reason);

public sealed record PowPolicyOptions(
    string Mode,
    int DefaultDifficulty,
    bool AdaptiveDifficultyEnabled,
    int ProofTtlSeconds,
    bool ReplayProtectionEnabled,
    bool RiskScoreLinkEnabled,
    string ChallengeEndpoint,
    string VerificationStrategy);

public sealed record PowOptionsUpdateRequest(
    string? Mode,
    int? DefaultDifficulty,
    bool? AdaptiveDifficultyEnabled,
    int? ProofTtlSeconds,
    bool? ReplayProtectionEnabled,
    bool? RiskScoreLinkEnabled,
    string? Reason);

public sealed record AntiCrawlerPolicySnapshot(
    string SnapshotId,
    DateTimeOffset UpdatedAtUtc,
    string UpdatedBy,
    string? Reason,
    AntiCrawlerPolicyOptions Options);

public sealed record PowPolicySnapshot(
    string SnapshotId,
    DateTimeOffset UpdatedAtUtc,
    string UpdatedBy,
    string? Reason,
    PowPolicyOptions Options);

public sealed record SecurityRiskPolicySnapshot(
    string SnapshotId,
    int RequireChallengeScore,
    int BlockScore,
    int MaxRiskScore,
    bool PublicReadChallengeEnabled,
    bool RiskScoringEnabled,
    string AntiCrawlerMode);

public sealed record SecurityOverviewResponse(
    string Status,
    DateTimeOffset CheckedAtUtc,
    AntiCrawlerOverviewSummary AntiCrawler,
    PowOverviewResponse Pow,
    SecurityRiskOverviewResponse Risk);

public sealed record AntiCrawlerOverviewSummary(
    string Mode,
    bool Enabled,
    bool Enforcing,
    int EventsLastHour,
    int EventsLastDay,
    int VerifiedCrawlerEvents,
    int FakeCrawlerEvents,
    int UnknownBotEvents,
    int BlockedUserAgentEvents,
    int SocialPreviewEvents,
    int RiskSnapshotCount,
    string CidrSource,
    int GoogleRanges,
    int BingRanges,
    DateTimeOffset? LastSyncAt,
    DateTimeOffset? NextSyncAt);

public sealed record AntiCrawlerOverviewResponse(
    AntiCrawlerPolicySnapshot Policy,
    AntiCrawlerOverviewSummary Summary,
    CrawlerRangesAdminStatus CrawlerRanges,
    IReadOnlyList<AntiCrawlerRiskEventResponse> RecentEvents,
    IReadOnlyList<AntiCrawlerRuleResponse> Rules,
    IReadOnlyList<AntiCrawlerListEntryResponse> Allowlist,
    IReadOnlyList<AntiCrawlerListEntryResponse> Blocklist);

public sealed record PowOverviewResponse(
    PowPolicySnapshot Policy,
    int ValidationFailuresLastHour,
    int ReplayRejectsLastHour,
    int ChallengeRequiredLastHour,
    string ChallengeEndpointStatus);

public sealed record SecurityRiskOverviewResponse(
    int EventsLastHour,
    int EventsLastDay,
    int SnapshotCount,
    int HighRiskSnapshotCount,
    string TopReason,
    string TopSource);

public sealed record CrawlerRangesAdminStatus(
    bool AutoUpdateEnabled,
    int UpdateIntervalMinutes,
    int MinUpdateIntervalMinutes,
    int InitialDelaySeconds,
    DateTimeOffset? NextSyncAt,
    DateTimeOffset? LastStartedAt,
    DateTimeOffset? LastFinishedAt,
    string LastOutcome,
    bool Running,
    int GoogleRanges,
    int BingRanges,
    DateTimeOffset? LastSyncAt,
    DateTimeOffset? LastSuccessAt,
    string Source,
    string? LastError,
    string GoogleUrl,
    string BingUrl,
    string? SnapshotPath);

public sealed record CrawlerRangeSyncResponse(
    CrawlerRangesAdminStatus Status,
    string Outcome,
    DateTimeOffset CompletedAtUtc);

public sealed record AntiCrawlerRiskEventResponse(
    string Id,
    DateTimeOffset OccurredAtUtc,
    string Source,
    string Reason,
    string Action,
    int ScoreDelta,
    int TotalScore,
    string Ip,
    string Path,
    string Method,
    string? UserAgent,
    string? Detail);

public sealed record SecurityRiskSnapshotResponse(
    string Subject,
    int Score,
    string LastReason,
    string LastSource,
    DateTimeOffset UpdatedAtUtc,
    DateTimeOffset ExpiresAtUtc);

public sealed record AntiCrawlerRuleRequest(
    string Name,
    bool Enabled,
    string MatchType,
    string Pattern,
    string Action,
    int Score,
    string? Notes);

public sealed record AntiCrawlerRuleResponse(
    string Id,
    string Name,
    bool Enabled,
    string MatchType,
    string Pattern,
    string Action,
    int Score,
    string? Notes,
    DateTimeOffset UpdatedAtUtc,
    string UpdatedBy);

public sealed record AntiCrawlerListEntryRequest(
    string Value,
    string Scope,
    string? Reason,
    bool Enabled);

public sealed record AntiCrawlerListEntryResponse(
    string Id,
    string ListType,
    string Value,
    string Scope,
    string? Reason,
    bool Enabled,
    DateTimeOffset UpdatedAtUtc,
    string UpdatedBy);

public sealed record AntiCrawlerSimulationRequest(
    string Method,
    string Path,
    string UserAgent,
    string Ip,
    string? Referer,
    int CurrentRiskScore);

public sealed record AntiCrawlerSimulationResult(
    string Mode,
    string FinalAction,
    bool WouldVerifyCrawler,
    bool WouldApplySocialPreviewGuard,
    bool WouldRequireChallenge,
    bool WouldBlock,
    int ScoreDelta,
    int ResultingRiskScore,
    IReadOnlyList<string> MatchedRules,
    IReadOnlyList<string> MatchedLists,
    string SecurityChallengeReference);

public sealed record SecurityRiskResetRequest(
    string Subject,
    string Reason);

public sealed record SecurityRiskResetResponse(
    string Subject,
    bool Reset,
    DateTimeOffset ResetAtUtc);
