using FsusBlog.Server.Infrastructure.Helpers;

namespace FsusBlog.Server.Models.Security;

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

public sealed record SecurityOverviewResponse(
    string Status,
    DateTimeOffset CheckedAtUtc,
    AntiCrawlerOverviewSummary AntiCrawler,
    PowOverviewResponse Pow,
    SecurityRiskOverviewResponse Risk);

public sealed record RiskControlConsoleResponse(
    SecurityRiskPolicy ActivePolicy,
    SecurityRiskOverviewResponse Risk,
    IReadOnlyList<SecurityRiskEventAggregateResponse> RiskEventAggregate,
    SecurityChallengeMetricsResponse ChallengeMetrics,
    IReadOnlyList<AntiCrawlerRiskEventResponse> RecentEvents,
    IReadOnlyList<SecurityRiskSnapshotResponse> TopRiskSnapshots);

public sealed record PerceptionSealedV2PolicyOptions(
    bool Enabled,
    bool LocalizationEnabled,
    bool MicroInteractionEnabled,
    bool PoSpaceFallbackEnabled,
    int EarlyRejectThreshold,
    int MaxAttempts,
    int MinSolveDurationMs,
    int MaxSolveDurationMs);

public sealed record PerceptionSealedV2PolicyUpdateRequest(
    bool? Enabled,
    bool? LocalizationEnabled,
    bool? MicroInteractionEnabled,
    bool? PoSpaceFallbackEnabled,
    int? EarlyRejectThreshold,
    int? MaxAttempts,
    int? MinSolveDurationMs,
    int? MaxSolveDurationMs,
    string? Reason);

public sealed record PerceptionSealedV2PolicySnapshot(
    string SnapshotId,
    string PolicyVersion,
    DateTimeOffset UpdatedAtUtc,
    string UpdatedBy,
    string? Reason,
    string? LastKnownGoodSnapshotId,
    PerceptionSealedV2PolicyOptions Options);

public sealed record PerceptionSealedV2ConsoleResponse(
    PerceptionSealedV2PolicySnapshot Policy,
    PerceptionSealedV2MetricsResponse Metrics,
    SecurityRiskPolicy ActiveRiskPolicy);

public sealed record PerceptionSealedV2MetricsResponse(
    DateTimeOffset WindowStartedAtUtc,
    int Issued,
    int Verified,
    int Failed,
    int Replayed,
    double SuccessRate,
    double FailureRate,
    double AverageSolveDurationMs,
    double P95SolveDurationMs,
    int AveragePayloadBytes,
    int P95PayloadBytes,
    IReadOnlyList<PerceptionSealedV2TaskKindMetricResponse> TaskKindDistribution,
    IReadOnlyList<SecurityChallengeAttemptSummaryResponse> RecentAttempts);

public sealed record PerceptionSealedV2TaskKindMetricResponse(
    string TaskKind,
    string ChallengeKind,
    int Issued,
    int Verified,
    int Failed,
    int Replayed,
    double SuccessRate,
    double FailureRate,
    double AverageSolveDurationMs,
    int AveragePayloadBytes);

public sealed record RiskControlPolicyUpdateRequest(
    string? GlobalMode,
    bool? PoSpaceV1Enabled,
    bool? PublicReadChallengeEnabled,
    bool? CommentRiskControlEnabled,
    bool? AuthRiskControlEnabled,
    int? StrictRiskMultiplierPercent,
    string? Reason);

public sealed record RiskControlSimulationRequest(
    string? Action,
    string? RouteKey,
    string? Subject,
    int? RiskScore,
    string? ClientIp,
    string? UserAgent,
    string? DeviceFingerprint,
    string? Region,
    string? ActorStatus,
    string? IdentityKind,
    bool? VerifiedCrawler,
    bool? SocialPreviewBot);

public sealed record RiskControlSimulationResponse(
    int RiskScore,
    int EffectiveRiskScore,
    string Decision,
    string DecisionKind,
    IReadOnlyList<string> Reasons,
    IReadOnlyList<string> RequiredChallenges,
    string PolicyVersion,
    string Action,
    string RouteKey,
    string Subject,
    string ClientIp,
    string ActorStatus,
    string IdentityKind,
    int EscalationLevel,
    bool Simulated);

public sealed record SecurityRiskEventAggregateResponse(
    string Source,
    string Reason,
    int Count,
    int ScoreDeltaSum,
    int MaxTotalScore,
    DateTimeOffset LastOccurredAtUtc);

public sealed record SecurityChallengeMetricsResponse(
    string? Kind,
    DateTimeOffset WindowStartedAtUtc,
    int TotalIssued,
    int TotalAttempts,
    int Verified,
    int Failed,
    int Replayed,
    int Expired,
    int Revoked,
    double SuccessRate,
    double FailureRate,
    IReadOnlyList<SecurityChallengeKindBreakdownResponse> KindBreakdown,
    IReadOnlyList<SecurityChallengeAttemptSummaryResponse> RecentAttempts);

public sealed record SecurityChallengeKindBreakdownResponse(
    string Kind,
    int TotalIssued,
    int TotalAttempts,
    int Verified,
    int Failed,
    double SuccessRate,
    double FailureRate);

public sealed record SecurityChallengeAttemptSummaryResponse(
    string AttemptId,
    string ChallengeId,
    string Kind,
    string Outcome,
    string? Reason,
    string Action,
    string RouteKey,
    DateTimeOffset AttemptedAtUtc);

public sealed record SecurityPolicyConsoleResponse(
    SecurityRiskPolicy ActivePolicy,
    AntiCrawlerPolicySnapshot AntiCrawler,
    PowPolicySnapshot Pow,
    IReadOnlyList<SecurityPolicyVersionSummaryResponse> PolicyVersions);

public sealed record SecurityPolicyVersionSummaryResponse(
    string PolicyId,
    long Version,
    string Mode,
    bool Active,
    bool LastKnownGood,
    long? RollbackOfVersion,
    long? CreatedByAdminId,
    DateTimeOffset CreatedAtUtc,
    DateTimeOffset? ActivatedAtUtc,
    DateTimeOffset? RevokedAtUtc,
    string? Reason);

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
