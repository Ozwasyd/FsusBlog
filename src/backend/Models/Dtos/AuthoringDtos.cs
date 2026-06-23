using FsusBlog.Server.Entities;
using FsusBlog.Server.Models.Moderation;

namespace FsusBlog.Server.Models.Dtos;

public sealed record class ServerDraftSaveRequest(
    string DraftKey,
    int? ArticleId,
    string Title,
    string Content,
    string? Summary,
    string? CoverImageUrl,
    int CategoryId,
    IReadOnlyList<int> TagIds,
    string? ClientRevision,
    int? Status,
    DateTime? ScheduledPublishAt,
    string? WarningOverrideReason = null);

public sealed record class ServerDraftResponse(
    string DraftKey,
    int? ArticleId,
    string Title,
    string Content,
    string? Summary,
    string? CoverImageUrl,
    int CategoryId,
    IReadOnlyList<int> TagIds,
    string? ClientRevision,
    int Status,
    DateTime? ScheduledPublishAt,
    DateTime UpdatedAt);

public sealed record class ArticleRevisionSummaryResponse(
    string Id,
    int ArticleId,
    int RevisionNo,
    string Title,
    string DiffSummary,
    string CreatedByAdminPrincipalId,
    DateTime CreatedAt);

public sealed record class ArticleRevisionDetailResponse(
    string Id,
    int ArticleId,
    int RevisionNo,
    string Title,
    string Content,
    string? Summary,
    string? CoverImageUrl,
    int CategoryId,
    IReadOnlyList<int> TagIds,
    string DiffSummary,
    string CreatedByAdminPrincipalId,
    DateTime CreatedAt);

public sealed record class ArticlePreviewResponse(string Html, string PlainText, IReadOnlyList<PrepublishIssue> Issues);

public sealed record class PrepublishIssue(string Severity, string Code, string Message);

public sealed record class PrepublishCheckResponse(bool CanPublish, IReadOnlyList<PrepublishIssue> Issues);

public sealed record class AssetLibraryItemResponse(
    string Id,
    string Url,
    string? AltText,
    int? SourceArticleId,
    int ReferenceCount,
    string? Sha256,
    DateTime UpdatedAt);

public sealed record class AssetCleanupResponse(int Deleted);

public sealed record class AdminCategoryItemResponse(
    int Id,
    string Name,
    int PublicArticleCount,
    int DraftArticleCount,
    int ScheduledArticleCount,
    int ArchivedArticleCount,
    int TotalBlockingArticleCount,
    bool CanDelete);

public sealed record class AdminTagItemResponse(
    int Id,
    string Name,
    int PublicArticleCount,
    int DraftArticleCount,
    int ScheduledArticleCount,
    int ArchivedArticleCount,
    int DeletedArticleCount,
    int TotalBlockingArticleCount,
    bool CanDelete);

public sealed record class AuthorAnalyticsMetricResponse(string Label, int Count);

public sealed record class AuthorRumMetricResponse(string Name, int Count, double P75, double Average);

public sealed record class AuthorAnalyticsResponse(
    int PublishedArticles,
    int DraftArticles,
    int ScheduledArticles,
    int ArchivedArticles,
    int TotalHumanReadEvents,
    int TotalSearchableArticles,
    double AotHitRate,
    int AverageDwellMs,
    double ReadingCompletionRate,
    IReadOnlyList<AuthorAnalyticsMetricResponse> TopSearchKeywords,
    IReadOnlyList<AuthorAnalyticsMetricResponse> TopSourceRoutes,
    IReadOnlyList<AuthorAnalyticsMetricResponse> NotFoundHotspots,
    IReadOnlyList<AuthorRumMetricResponse> RumMetrics,
    IReadOnlyList<AuthorAnalyticsMetricResponse> RumPageTypes,
    IReadOnlyList<AuthorAnalyticsMetricResponse> RumAotSources);

public sealed record class CommentModerationRequest(CommentModerationStatus Status, string? Reason, bool BanUser = false);

public sealed record class CommentModerationModelSignalResponse(
    string Provider,
    string Model,
    string ContractVersion,
    string Label,
    double Confidence,
    string Severity,
    string? PrimaryReason,
    bool NeedsSecondRound,
    IReadOnlyList<string> RiskCategories,
    string? EvidenceJson,
    string? RawReason,
    int LatencyMs,
    string Status,
    string? ErrorCode,
    string? ThresholdProfile,
    DateTime CreatedAtUtc);

public sealed record class CommentModerationItemResponse(
    string Id,
    int ArticleId,
    string ArticleTitle,
    string AuthorDisplayName,
    string Content,
    DateTime CreateTime,
    CommentModerationStatus Status,
    string? Reason,
    long? ModeratedByAdminPrincipalId,
    DateTime? ModeratedAt,
    bool AutoModerated,
    string ModerationActor,
    IReadOnlyList<string> HitReasons,
    string? SubmitRegion,
    double? SubmitRegionConfidence,
    IReadOnlyList<string> BlockedRegions,
    string? RegionPolicyVersion,
    string? RegionDecisionReason,
    bool RegionCanPublish,
    bool RegionRequiresManualReview,
    bool RegionHideUntilReviewed,
    IReadOnlyList<CommentModerationModelSignalResponse> ModelSignals,
    string? ModelLabel,
    double? ModelConfidence,
    string? ModelPrimaryReason,
    string? ModelProvider,
    bool ModelUnavailable,
    string? AuthorMode,
    string? AnonymousDisplayLanguage,
    string? ModerationSubjectHash,
    string? NullifierHash,
    string? NullifierStatusLabel,
    string? AnonymousScope,
    string? CredentialLevel,
    string? ReputationBucket,
    string? AccountAgeBucket,
    string? AnonymousCredentialId,
    bool CanBlockAnonymousNullifier,
    bool CanRevokeAnonymousCredential);

public sealed record class CommentModerationQueueResponse(
    IReadOnlyList<CommentModerationItemResponse> Items,
    int PendingCount,
    int RejectedCount,
    int HiddenCount);

public sealed record class CommentModerationBulkRequest(
    IReadOnlyList<string> CommentIds,
    CommentModerationStatus Status,
    string? Reason,
    bool BanUsers = false);

public sealed record class CommentModerationBulkResponse(int Updated, int BannedUsers);

public sealed record class AnonymousNullifierBlockRequest(
    string NullifierHash,
    string Scope,
    string? Reason);

public sealed record class AnonymousCredentialRevokeRequest(string? Reason);

public sealed record class AnonymousGovernanceActionResponse(bool Applied);

public sealed record class ModerationOverviewResponse(
    int PendingCount,
    int RejectedCount,
    int HiddenCount,
    int DictionaryCount,
    int RegionPolicyCount,
    string MainlandStrictStatus,
    string? DictionaryLastError,
    bool ModelEnabled,
    string ModelProvider,
    string ModelMode,
    string ModelContractVersion,
    int ModelTimeoutMs);

public sealed record class RegionPolicyCheckResponse(
    string Code,
    string Label,
    string Status,
    string Detail);

public sealed record class RegionPolicySummaryResponse(
    string Region,
    string Version,
    IReadOnlyList<string> Inherits,
    IReadOnlyList<string> DictionaryIds,
    string Checksum,
    int RuleCount,
    IReadOnlyList<RegionPolicyCheckResponse> CriticalChecks);

public sealed record class ModerationModelStatusResponse(
    bool Enabled,
    string Provider,
    string Mode,
    string ContractVersion,
    int TimeoutMs,
    bool FailOpen,
    bool ExternalProviderAllowed,
    bool ExternalProviderReviewed,
    DateTime? LastSuccessAtUtc,
    string? LastErrorCode,
    DateTime? LastErrorAtUtc,
    double AverageLatencyMs,
    int P95LatencyMs);

public sealed record class ModerationDictionaryReloadResponse(
    bool Reloaded,
    string SnapshotId,
    string Checksum,
    string? Error,
    DateTime ReloadedAtUtc);

public sealed record class ModerationModelRuntimeResponse(
    string SnapshotId,
    bool Enabled,
    string Provider,
    string ModelProfile,
    string ThresholdProfile,
    string ContractVersion,
    string ConfigChecksum,
    DateTime LoadedAtUtc,
    string LoadedBy,
    string Status,
    int TimeoutMs,
    bool FailOpen,
    bool ExternalProviderAllowed,
    bool ExternalProviderReviewed,
    string? LastError);

public sealed record class ModerationRuntimeStatusResponse(
    string SnapshotId,
    string GlobalState,
    IReadOnlyDictionary<string, string> RegionStates,
    IReadOnlyList<string> DisabledDictionaryIds,
    ModerationModelRuntimeResponse Model,
    DateTime ChangedAtUtc,
    string ChangedBy,
    string? Reason,
    DateTime? ExpiresAtUtc,
    string? LastError);

public sealed record class ModerationRuntimeGlobalStateRequest(
    string State,
    string? Reason = null,
    DateTime? ExpiresAtUtc = null);

public sealed record class ModerationRuntimeRegionStateRequest(
    string Region,
    string State,
    string? Reason = null,
    DateTime? ExpiresAtUtc = null,
    string? ConfirmPhrase = null);

public sealed record class ModerationDictionaryStateRequest(
    string? Reason = null,
    string? ConfirmPhrase = null);

public sealed record class ModerationModelRuntimeRequest(
    bool? Enabled = null,
    string? Provider = null,
    string? ModelProfile = null,
    string? ThresholdProfile = null,
    string? Reason = null);

public sealed record class ModerationEffectivePolicyPreviewRequest(
    string RegionCode,
    IReadOnlyList<ModerationPolicyTemplateRule>? OperatorOverrides = null);

public sealed record class ModerationReplayPreviewRequest(
    string? Region,
    string? PolicyVersion,
    string? DictionaryId,
    int? Limit);

public sealed record class ModerationReplayPreviewItemResponse(
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

public sealed record class ModerationReplayPreviewResponse(
    string? Region,
    string? PolicyVersion,
    string? DictionaryId,
    int ScannedCount,
    int AffectedCommentCount,
    int AddedBlockedRegionCount,
    int RemovedBlockedRegionCount,
    int AddedRiskLabelCount,
    int RemovedRiskLabelCount,
    int PublishabilityChangedCount,
    int ManualReviewChangedCount,
    int PublicVisibilityChangedCount,
    int HighRiskChangeCount,
    IReadOnlyList<ModerationReplayPreviewItemResponse> Items);

public sealed record class ContentRevisionExportResponse(
    int RevisionNo,
    string Title,
    string Content,
    string? Summary,
    string? CoverImageUrl,
    int CategoryId,
    IReadOnlyList<int> TagIds,
    string DiffSummary,
    DateTime CreatedAt);

public sealed record class ContentExportMetadataResponse(
    int? SourceArticleId,
    int CategoryId,
    IReadOnlyList<int> TagIds,
    ArticleStatus Status,
    DateTime? ScheduledPublishAt,
    string? CoverImageUrl,
    int RevisionCount,
    IReadOnlyList<ContentRevisionExportResponse> Revisions);

public sealed record class ContentImportRequest(string MarkdownWithFrontmatter, bool Publish, bool PreserveRevisions = true);

public sealed record class ContentImportResponse(int ArticleId, int RestoredRevisionCount);

public sealed record class ContentExportResponse(string FileName, string MarkdownWithFrontmatter, ContentExportMetadataResponse Metadata);

public sealed record class ContentBackupExportResponse(string FileName, DateTime ExportedAt, IReadOnlyList<ContentExportResponse> Articles);

public sealed record class AiAssistRequest(string Title, string Content, string? Locale, string? Operation = null);

public sealed record class AiAssistResponse(
    bool ProviderEnabled,
    string ProviderMode,
    bool ExternalProviderAllowed,
    string AuditEvent,
    string SuggestedSummary,
    IReadOnlyList<string> SuggestedTags,
    IReadOnlyList<string> TitleCandidates,
    string TranslationDraft,
    IReadOnlyList<PrepublishIssue> StructureIssues);
