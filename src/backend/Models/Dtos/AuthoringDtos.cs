using FsusBlog.Server.Entities;

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
    long Id,
    int ArticleId,
    int RevisionNo,
    string Title,
    string DiffSummary,
    int CreatedByUserId,
    DateTime CreatedAt);

public sealed record class ArticleRevisionDetailResponse(
    long Id,
    int ArticleId,
    int RevisionNo,
    string Title,
    string Content,
    string? Summary,
    string? CoverImageUrl,
    int CategoryId,
    IReadOnlyList<int> TagIds,
    string DiffSummary,
    int CreatedByUserId,
    DateTime CreatedAt);

public sealed record class ArticlePreviewResponse(string Html, string PlainText, IReadOnlyList<PrepublishIssue> Issues);

public sealed record class PrepublishIssue(string Severity, string Code, string Message);

public sealed record class PrepublishCheckResponse(bool CanPublish, IReadOnlyList<PrepublishIssue> Issues);

public sealed record class AssetLibraryItemResponse(
    long Id,
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

public sealed record class CommentModerationItemResponse(
    string Id,
    int ArticleId,
    string ArticleTitle,
    int UserId,
    string UserName,
    string Content,
    DateTime CreateTime,
    CommentModerationStatus Status,
    string? Reason,
    int? ModeratedByUserId,
    DateTime? ModeratedAt,
    IReadOnlyList<string> HitReasons,
    string? SubmitRegion,
    double? SubmitRegionConfidence,
    IReadOnlyList<string> BlockedRegions,
    string? RegionPolicyVersion,
    string? RegionDecisionReason,
    bool RegionCanPublish,
    bool RegionRequiresManualReview,
    bool RegionHideUntilReviewed);

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

public sealed record class ContentRevisionExportResponse(
    int RevisionNo,
    string Title,
    string Content,
    string? Summary,
    string? CoverImageUrl,
    int CategoryId,
    IReadOnlyList<int> TagIds,
    string DiffSummary,
    int CreatedByUserId,
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
