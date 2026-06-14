using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;

namespace FsusBlog.Server.Models.Dtos;

public sealed record AdminMetricResponse(string Key, object? Value);

public sealed record AdminServiceStatusResponse(
    string Key,
    string Label,
    string Status,
    string? Detail,
    DateTimeOffset? UpdatedAt,
    IReadOnlyList<AdminMetricResponse> Metrics);

public sealed record BackupArtifactResponse(
    string Kind,
    string Status,
    string? Path,
    DateTimeOffset? UpdatedAt,
    long? SizeBytes,
    string? Detail);

public sealed record BackupStatusResponse(
    string Status,
    DateTimeOffset CheckedAt,
    string BackupRoot,
    IReadOnlyList<BackupArtifactResponse> Artifacts,
    string RestoreDrillCommand,
    string RestoreCommand);

public sealed record QueueBacklogResponse(
    int ArticleMutationPending,
    int ArticleMutationFailed,
    long AuditQueued,
    long AuditDropped);

public sealed record RecentOpsErrorResponse(
    DateTimeOffset OccurredAt,
    string Severity,
    string Action,
    string Message,
    string? Detail,
    int Count);

public sealed record OpsHealthResponse(
    string Status,
    DateTimeOffset CheckedAt,
    string Environment,
    string Version,
    string Commit,
    IReadOnlyList<AdminServiceStatusResponse> Services,
    IReadOnlyList<AdminServiceStatusResponse> Workers,
    QueueBacklogResponse QueueBacklog,
    BackupStatusResponse Backup,
    IReadOnlyList<RecentOpsErrorResponse> RecentErrors);

public sealed record AotDiagnosticsResponse(
    string Status,
    long Version,
    DateTimeOffset? LastBuildAt,
    string? LastBuildStatus,
    string? LastBuildReason,
    string? LastError,
    int StalePageCount,
    long InvalidationVersion,
    int TrackedInvalidationKeys);

public sealed record SearchIndexDiagnosticsResponse(
    string Status,
    string? Version,
    DateTimeOffset? LastUpdatedAt,
    int SchemaVersion,
    int ShardCount,
    bool ManifestExists,
    string ManifestPath,
    string? LastError);

public sealed record DistributionDiagnosticsResponse(
    string Status,
    DateTimeOffset CheckedAt,
    int SitemapUrlCount,
    int FeedItemCount,
    DateTimeOffset? SitemapUpdatedAt,
    DateTimeOffset? FeedUpdatedAt,
    string? LastError);

public sealed record OutputCacheDiagnosticsResponse(
    string Status,
    bool Enabled,
    IReadOnlyList<string> Tags,
    string Detail);

public sealed record ArticleCacheDiagnosisResponse(
    int ArticleId,
    bool PubliclyVisible,
    bool ArticleFrameReady,
    bool HtmlFrameReady,
    bool SearchEligible,
    bool SitemapEligible,
    string Detail);

public sealed record CacheDiagnosticsResponse(
    string Status,
    DateTimeOffset CheckedAt,
    AotDiagnosticsResponse Aot,
    SearchIndexDiagnosticsResponse Search,
    DistributionDiagnosticsResponse Distribution,
    CacheInvalidationRuntimeSnapshot CommentCache,
    HotStatsInvalidationSnapshot HotStatsInvalidation,
    OutputCacheDiagnosticsResponse OutputCache,
    PublicHotReadCounterSnapshot PublicHotReadCounters,
    ArticleCacheDiagnosisResponse? Article);

public sealed record AdminCacheActionRequest(string Action, int? ArticleId = null);

public sealed record AdminCacheActionResponse(
    string Action,
    string Status,
    string Detail,
    DateTimeOffset CompletedAt);

public sealed record AdminDiffResponse(string Field, string Before, string After);

public sealed record IntegrityCheckResponse(
    string Code,
    string Title,
    string Status,
    string Severity,
    int Count,
    bool AutoFixAvailable,
    string Detail,
    IReadOnlyList<string> SampleKeys,
    IReadOnlyList<AdminDiffResponse> PreviewDiffs);

public sealed record IntegrityReportResponse(
    string Status,
    DateTimeOffset CheckedAt,
    int CheckCount,
    int IssueCount,
    IReadOnlyList<IntegrityCheckResponse> Checks);

public sealed record IntegrityFixPreviewResponse(
    string Status,
    DateTimeOffset CheckedAt,
    IReadOnlyList<AdminDiffResponse> Diffs,
    string ConfirmationLevel,
    string AuditAction);

public sealed record IntegrityFixRequest(
    IReadOnlyList<string>? Codes,
    string ConfirmPhrase);

public sealed record IntegrityFixResponse(
    string Status,
    DateTimeOffset AppliedAt,
    int AppliedCount,
    IReadOnlyList<AdminDiffResponse> Diffs);

public sealed record DangerousOperationPolicyResponse(
    IReadOnlyList<DangerousOperationRuleResponse> Rules,
    IReadOnlyList<string> DiffRequiredOperations,
    IReadOnlyList<string> MfaRequiredOperations,
    string StrategyVersion);

public sealed record DangerousOperationRuleResponse(
    string Level,
    string Interaction,
    IReadOnlyList<string> Examples);
