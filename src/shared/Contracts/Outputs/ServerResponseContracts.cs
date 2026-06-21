namespace FsusBlog.Shared.Contracts.Outputs;

public readonly record struct ArticleCategoryView(int Id, string Name);
public readonly record struct FeaturedArticleSummaryDto(int Id, string Title, string CoverImageUrl, int Views, DateTime CreateTime, ArticleCategoryView Category);
public readonly record struct TagDto(int Id, string Name);
public readonly record struct TagWithCountDto(int Id, string Name, int ArticleCount);
public readonly record struct ArticleMutationResponseDto(int Id);
public readonly record struct TrashClearResponseDto(int Count);
public readonly record struct ArticleNoticeDto(int ArticleId, string Action, DateTime EventTime, ArticleListItemResponse? Preview = null);

/// <summary>通行密钥凭证摘要（返回给前端）</summary>
public readonly record struct PasskeyCredentialSummaryDto(
    int Id,
    string? DeviceFriendlyName,
    DateTime CreatedAt,
    DateTime? LastUsedAt,
    string AaGuid,
    bool BackupEligible,
    bool BackupState);

public sealed record class PageResponse<T>
{
    public List<T> Items { get; init; } = [];
    public int Total { get; init; }
}

public sealed record class CursorResponse<T>
{
    public List<T> Data { get; init; } = [];
    public string? NextCursor { get; init; }
    public bool HasMore { get; init; }
}

public record struct ArticleListItemResponse
{
    public int Id { get; set; }
    public string Title { get; set; }
    public string? Summary { get; set; }
    public string? CoverImageUrl { get; set; }
    public int Views { get; set; }
    public DateTime CreateTime { get; set; }
    public ArticleCategoryView Category { get; set; }
    public List<TagDto> Tags { get; set; }
    public bool? IsDeleted { get; set; }
    public int Status { get; set; }
    public DateTime? ScheduledPublishAt { get; set; }
    public DateTime? PublishedAt { get; set; }

    public ArticleListItemResponse()
    {
        Title = string.Empty;
        Tags = [];
        Status = 2;
    }
}

public record struct CategoryListItemResponse
{
    public int Id { get; set; }
    public required string Name { get; set; }
    public int ArticleCount { get; set; }
}

public record struct ArticleDetailResponse
{
    public int Id { get; set; }
    public string Title { get; set; }
    public string Content { get; set; }
    public string? Summary { get; set; }
    public string? CoverImageUrl { get; set; }
    public int Views { get; set; }
    public DateTime CreateTime { get; set; }
    public ArticleCategoryView Category { get; set; }
    public List<TagDto> Tags { get; set; }
    public bool IsDeleted { get; set; }
    public int Status { get; set; }
    public DateTime? ScheduledPublishAt { get; set; }
    public DateTime? PublishedAt { get; set; }

    public ArticleDetailResponse()
    {
        Title = string.Empty;
        Content = string.Empty;
        Tags = [];
        Status = 2;
    }
}

public sealed record RelatedReadingResponse(
    IReadOnlyList<RelatedReadingItem> Related,
    RelatedReadingItem? Previous,
    RelatedReadingItem? Next);

public sealed record RelatedReadingItem(
    int Id,
    string Title,
    string? Summary,
    DateTime CreateTime,
    string Reason);

public sealed record class HumanReadChallengeResponse(
    string Token,
    string Scope,
    string RouteKey,
    int? ArticleId,
    int MinDwellMs,
    DateTimeOffset IssuedAt,
    DateTimeOffset ExpiresAt);

public sealed record class HumanReadChallengeRequest(
    string Scope,
    string RouteKey,
    int? ArticleId);

public sealed record class HumanReadSubmitRequest(
    string Token,
    string Scope,
    string RouteKey,
    int? ArticleId,
    int DwellMs);

public sealed record class HumanReadSubmitResponse(
    bool Counted,
    string Status);

public static class RumTelemetryContractLimits
{
    public const int MaxFrameBytes = 8192;
    public const int MaxMetricsPerBatch = 16;
    public const int MaxMetricNameLength = 64;
    public const int MaxRouteKeyLength = 160;
    public const int MaxMetricValuesPerMetric = 4;
    public const int MaxDimensionsPerMetric = 4;
    public const int MaxDimensionKeyLength = 32;
    public const int MaxDimensionValueLength = 64;
}

public sealed record class RumMetricBatchRequest(
    string PageType,
    string RouteKey,
    string AotSource,
    IReadOnlyList<RumMetricBatchItem> Metrics);

public sealed record class RumMetricBatchItem(
    string Name,
    double? Value,
    DateTime? Timestamp,
    IReadOnlyDictionary<string, double>? Metrics,
    IReadOnlyDictionary<string, string>? Dimensions);

public sealed record class RumMetricIngestResponse(
    bool Accepted,
    int AcceptedCount = 0,
    int RejectedCount = 0);

public sealed record class SiteSubscriptionBinaryRequest(
    string Email,
    string? Channel);

public sealed record class SiteSubscriptionBinaryResponse(
    bool Subscribed,
    bool Unsubscribed,
    string Channel);

public record struct UserCommentResponse
{
    public long Id { get; init; }
    public string Content { get; init; }
    public DateTime CreateTime { get; init; }
    public int ArticleId { get; init; }
    public string ArticleTitle { get; init; }
    public long? RootId { get; init; }
    public CommentAuthorViewDto Author { get; init; }
    public CommentAuthorViewDto? ReplyToAuthor { get; init; }
    public int ModerationStatus { get; init; }
    public string ModerationStatusLabel { get; init; }
    public string VisibilityState { get; init; }
    public string VisibilityReasonCode { get; init; }
    public bool IsPubliclyVisible { get; init; }

    public UserCommentResponse()
    {
        Content = string.Empty;
        ArticleTitle = string.Empty;
        ModerationStatusLabel = string.Empty;
        VisibilityState = string.Empty;
        VisibilityReasonCode = string.Empty;
    }
}

public sealed record class AnonymousCredentialIssueRequest(
    long CredentialEpoch,
    uint CircuitNumericId,
    ushort PublicInputLayoutVersion,
    string CircuitId,
    string CredentialLevel,
    byte[] CredentialRequest,
    byte[] ClientNonce);

public sealed record class AnonymousCredentialIssueResponse(
    long CredentialEpoch,
    long ExpiresAtUnixMs,
    uint CircuitNumericId,
    ushort PublicInputLayoutVersion,
    string CircuitId,
    string CredentialLevel,
    string IssuerPublicKeyId,
    byte[] IssuerSignature);

public sealed record class AnonymousCredentialRootSnapshot(
    long CredentialEpoch,
    long RootExpiresAtUnixMs,
    long RootGraceExpiresAtUnixMs,
    uint CircuitNumericId,
    ushort PublicInputLayoutVersion,
    bool ZkAnonymousEnabled,
    bool VerifierConfigured,
    string CircuitId,
    string VerifyingKeyHash,
    string IssuerPublicKeyHash,
    byte[] CredentialRoot,
    byte[] RevocationRoot,
    byte[] CircuitMetadata);

public sealed record class AnonymousCommentTicketRequest(
    int ArticleId,
    string? ParentId,
    string? RootId,
    string? ReplyToCommentId,
    long CredentialEpoch,
    uint CircuitNumericId,
    ushort PublicInputLayoutVersion,
    string ActionContext,
    string Scope,
    string CircuitId,
    string VerifyingKeyHash,
    byte[] NullifierHash,
    byte[] CredentialCommitment,
    byte[] CredentialRoot,
    byte[] RevocationRoot,
    string CredentialLevel,
    string ReputationBucket,
    byte[] Groth16Proof,
    byte[] PublicInputs);

public sealed record class AnonymousCommentTicketResponse(
    long CredentialEpoch,
    long TicketExpiresAtUnixMs,
    string CredentialLevel,
    byte[] Ticket,
    byte[] ModerationSubjectHash);

public sealed record class AnonymousCommentCreateRequest(
    int ArticleId,
    string Content,
    string? ParentId,
    string? RootId,
    string? ReplyToCommentId,
    long CredentialEpoch,
    string AnonymousScope,
    string DisplayLanguage,
    byte[] Ticket);

public sealed record class AnonymousPrivacyStateSnapshot(
    long CredentialEpoch,
    long RootExpiresAtUnixMs,
    long TicketExpiresAtUnixMs,
    uint CircuitNumericId,
    ushort PublicInputLayoutVersion,
    bool HasActiveCredential,
    bool CanIssueCredential,
    bool CanSubmitAnonymousComment,
    string CircuitId,
    string VerifyingKeyHash,
    string CredentialStatus,
    string CredentialLevel);

public sealed record class SeoConfigPublicDto
{
    public string Title { get; init; } = PublicSiteIdentityDefaults.SiteTitle;
    public string Description { get; init; } = PublicSiteIdentityDefaults.SiteDescription;
    public string Keywords { get; init; } = PublicSiteIdentityDefaults.SiteKeywords;
    public string Author { get; init; } = PublicSiteIdentityDefaults.SiteAuthor;
    public string OgImage { get; init; } = string.Empty;
    public string BaseUrl { get; init; } = PublicSiteIdentityDefaults.SiteBaseUrl;
    public string FaviconSvgUrl { get; init; } = "/favicon.svg";
    public string FaviconIcoUrl { get; init; } = "/favicon.ico";
    public string FaviconPngUrl { get; init; } = string.Empty;
    public string AppleTouchIconUrl { get; init; } = "/apple-touch-icon.png";
    public string ManifestName { get; init; } = PublicSiteIdentityDefaults.ManifestName;
    public string ManifestShortName { get; init; } = PublicSiteIdentityDefaults.ManifestShortName;
    public string PwaIcon192Url { get; init; } = "/icons/icon-192.png";
    public string PwaIcon512Url { get; init; } = "/icons/icon-512.png";
    public string PwaMaskableIconUrl { get; init; } = "/icons/maskable-512.png";
    public string ThemeColor { get; init; } = "#0f0f11";
    public string BackgroundColor { get; init; } = "#fcfcfc";
    public string SiteLogoUrl { get; init; } = string.Empty;
    public string SiteLogoDarkUrl { get; init; } = string.Empty;
    public string SiteWordmarkUrl { get; init; } = string.Empty;
    public string AdminLogoUrl { get; init; } = string.Empty;
    public string AdminCollapsedIconUrl { get; init; } = string.Empty;
    public string LoginLogoUrl { get; init; } = string.Empty;
    public string LoginIconUrl { get; init; } = string.Empty;
}

public sealed record class SeoConfigAdminDto
{
    public string Title { get; init; } = PublicSiteIdentityDefaults.SiteTitle;
    public string Description { get; init; } = PublicSiteIdentityDefaults.SiteDescription;
    public string Keywords { get; init; } = PublicSiteIdentityDefaults.SiteKeywords;
    public string Author { get; init; } = PublicSiteIdentityDefaults.SiteAuthor;
    public string OgImage { get; init; } = string.Empty;
    public string BaseUrl { get; init; } = PublicSiteIdentityDefaults.SiteBaseUrl;
    public string FaviconSvgUrl { get; init; } = "/favicon.svg";
    public string FaviconIcoUrl { get; init; } = "/favicon.ico";
    public string FaviconPngUrl { get; init; } = string.Empty;
    public string AppleTouchIconUrl { get; init; } = "/apple-touch-icon.png";
    public string ManifestName { get; init; } = PublicSiteIdentityDefaults.ManifestName;
    public string ManifestShortName { get; init; } = PublicSiteIdentityDefaults.ManifestShortName;
    public string PwaIcon192Url { get; init; } = "/icons/icon-192.png";
    public string PwaIcon512Url { get; init; } = "/icons/icon-512.png";
    public string PwaMaskableIconUrl { get; init; } = "/icons/maskable-512.png";
    public string ThemeColor { get; init; } = "#0f0f11";
    public string BackgroundColor { get; init; } = "#fcfcfc";
    public string SiteLogoUrl { get; init; } = string.Empty;
    public string SiteLogoDarkUrl { get; init; } = string.Empty;
    public string SiteWordmarkUrl { get; init; } = string.Empty;
    public string AdminLogoUrl { get; init; } = string.Empty;
    public string AdminCollapsedIconUrl { get; init; } = string.Empty;
    public string LoginLogoUrl { get; init; } = string.Empty;
    public string LoginIconUrl { get; init; } = string.Empty;
}

public record class SiteComplianceConfigPublicDto
{
    public bool Enabled { get; init; }
    public string RegionMode { get; init; } = "global";
    public string CopyrightOwner { get; init; } = string.Empty;
    public int? CopyrightStartYear { get; init; }
    public string CopyrightText { get; init; } = string.Empty;
    public string ContentLicenseName { get; init; } = string.Empty;
    public string ContentLicenseUrl { get; init; } = string.Empty;
    public string IcpRecordNumber { get; init; } = string.Empty;
    public string IcpRecordUrl { get; init; } = "https://beian.miit.gov.cn/";
    public string PoliceRecordNumber { get; init; } = string.Empty;
    public string PoliceRecordUrl { get; init; } = "https://beian.mps.gov.cn/";
    public string PoliceBadgeIconUrl { get; init; } = string.Empty;
    public string OperatorName { get; init; } = string.Empty;
    public string ContactEmail { get; init; } = string.Empty;
}

public sealed record class SiteComplianceConfigAdminDto : SiteComplianceConfigPublicDto;

public sealed record class PageContentPublicDto
{
    public string? Slug { get; init; }
    public string? Content { get; init; }
}

public sealed record class PageContentAdminDto
{
    public string? Slug { get; init; }
    public string? Content { get; init; }
}

public readonly record struct CommentItemDto(string Id, string Content, DateTime CreateTime, CommentAuthorViewDto Author);
public readonly record struct CommentListResponseDto(List<CommentItemDto> Data, string? NextCursor, bool HasMore);

public readonly record struct CommentAuthorViewDto(
    string Mode,
    string DisplayName,
    string DisplayLanguage,
    string? Badge,
    string? ScopeLabel,
    string? CredentialLevel);

public readonly record struct CommentReplyItemDto(
    string Id,
    string Content,
    DateTime CreateTime,
    CommentAuthorViewDto Author,
    CommentAuthorViewDto? ReplyToAuthor,
    string? ParentId,
    string RootId,
    string? ReplyToCommentId,
    int Depth,
    bool IsDeleted);

public readonly record struct CommentReplyPreviewItemDto(
    string Id,
    string Content,
    DateTime CreateTime,
    CommentAuthorViewDto Author,
    CommentAuthorViewDto? ReplyToAuthor,
    bool IsDeleted);

public readonly record struct CommentThreadItemDto(
    string Id,
    string Content,
    DateTime CreateTime,
    CommentAuthorViewDto Author,
    string RootId,
    bool IsDeleted,
    int ReplyCount,
    bool HasMoreReplies,
    List<CommentReplyPreviewItemDto> RepliesPreview);

public readonly record struct CommentQueryResultDto(long Id, string Content, DateTime CreateTime, CommentAuthorViewDto Author);
public readonly record struct CommentUserQueryResult(string DisplayName);
public readonly record struct CommentDeleteQueryResult(int UserId, int ArticleId, string Content, string ArticleTitle);

public sealed record class StatsSummaryDto
{
    public int TotalArticles { get; init; }
    public int TotalComments { get; init; }
    public int TrashCount { get; init; }
    public int TotalReads { get; init; }
    public int HumanVerifiedReads { get; init; }
    public int UniqueViewerKeyEstimate { get; init; }
    public int ArticleReads { get; init; }
    public int SiteReads { get; init; }
}

public sealed record class AdminStatsOverviewDto
{
    public StatsSummaryDto Summary { get; init; } = new();
    public List<PopularArticleStatItemDto> PopularArticles { get; init; } = [];
}

public sealed record class AdminStatsQueryDto
{
    public AdminStatsOverviewDto Overview { get; init; } = new();
    public List<RecentCommentStatItemDto> RecentComments { get; init; } = [];
    public List<RegionStatItemDto> Regions { get; init; } = [];
}

public readonly record struct PopularArticleSummaryDto(int Id, string Title, int Views);
public readonly record struct PopularArticleStatItemDto(int Id, string Title, int Views);
public readonly record struct RecentCommentStatItemDto(
    string AuthorDisplayName,
    string AuthorMode,
    string? AuthorBadge,
    string? AuthorScopeLabel,
    string? CredentialLevel,
    string Content,
    DateTime CreateTime);
public readonly record struct RegionStatItemDto(string Region, int Count);

public readonly record struct TokenResponseDto(string AccessToken, string RefreshToken);
public readonly record struct AuthIdentitySnapshotDto(int AccountId, string IdentityKind);
public readonly record struct AuthLoginFlowDto(
    int AccountId,
    string IdentityKind,
    string AuthPhase,
    string? MfaMode,
    string? ChallengeToken);
public readonly record struct CurrentUserSnapshotDto(int AccountId, string IdentityKind, int Status, string? BanReason, DateTime? DeletedAt);
public readonly record struct AdminAccountListItemDto(
    int AccountId,
    string IdentityKind,
    string? PublicHandle,
    bool PasskeyInitialized,
    bool RecoveryInitialized,
    DateTime? PrivacyInitializedAt,
    string AnonymousCredentialStatus,
    string AnonymousCredentialLevel,
    int RiskFlags,
    int Status,
    DateTime CreateTime,
    DateTime? DeletedAt);

public enum ConversationStatusValue
{
    Open = 0,
    Pending = 1,
    Closed = 2
}

public enum ConversationSenderValue
{
    Account = 0,
    Admin = 1,
    System = 2
}

public sealed record class ConversationListItemResponse
{
    public string ConversationId { get; init; } = string.Empty;
    public string Subject { get; init; } = string.Empty;
    public ConversationStatusValue Status { get; init; } = ConversationStatusValue.Open;
    public bool IsSystemSource { get; init; }
    public bool CanReply { get; init; }
    public int UnreadCount { get; init; }
    public DateTime LastMessageAt { get; init; }
    public DateTime UpdatedAt { get; init; }
    public ConversationMessagePreviewResponse? LastMessage { get; init; }
}

public sealed record class ConversationMessagePreviewResponse
{
    public ConversationSenderValue SenderType { get; init; } = ConversationSenderValue.System;
    public string? SenderName { get; init; }
    public string BodyPreview { get; init; } = string.Empty;
    public DateTime CreatedAt { get; init; }
}

public sealed record class ConversationMessageResponse
{
    public string MessageId { get; init; } = string.Empty;
    public string ConversationId { get; init; } = string.Empty;
    public ConversationSenderValue SenderType { get; init; } = ConversationSenderValue.System;
    public string? SenderName { get; init; }
    public string Body { get; init; } = string.Empty;
    public DateTime CreatedAt { get; init; }
}

public sealed record class ConversationDetailResponse
{
    public string ConversationId { get; init; } = string.Empty;
    public string Subject { get; init; } = string.Empty;
    public ConversationStatusValue Status { get; init; } = ConversationStatusValue.Open;
    public bool IsSystemSource { get; init; }
    public bool CanReply { get; init; }
    public int UnreadCount { get; init; }
    public DateTime LastMessageAt { get; init; }
    public List<ConversationMessageResponse> Messages { get; init; } = [];
}

public readonly record struct CommentPushDto
{
    public string Id { get; init; }

    public string Content { get; init; }

    public DateTime CreateTime { get; init; }

    public CommentAuthorViewDto Author { get; init; }

    public string? ParentId { get; init; }

    public string? RootId { get; init; }

    public CommentAuthorViewDto? ReplyToAuthor { get; init; }

    public string? ReplyToCommentId { get; init; }

    public int Depth { get; init; }

    public bool IsDeleted { get; init; }
}

public readonly record struct CommentAddedNotifyDto
{
    public int ArticleId { get; init; }

    public CommentPushDto Comment { get; init; }

    public DateTime Time { get; init; }
}

public readonly record struct GlobalNoticePayload(string id, string title, DateTime time);
public readonly record struct MessageRevokedPayload(string messageId, int? unreadCount = null, DateTime? time = null);
public readonly record struct AccountStatusPayload(int status, string? reason, DateTime time);
public readonly record struct NoticePayload(string title, int unreadCount, DateTime time);
public readonly record struct InboxConversationUpsertPayload(ConversationListItemResponse Conversation, int? TotalUnread = null, DateTime? Time = null);
public readonly record struct InboxMessageAppendPayload(string ConversationId, ConversationMessageResponse Message, int? ConversationUnreadCount = null, int? TotalUnread = null, DateTime? Time = null);
public readonly record struct InboxReadUpdatedPayload(string ConversationId, string? LastReadMessageId, int ConversationUnreadCount, int? TotalUnread = null, DateTime? Time = null);
public readonly record struct InboxConversationClosedPayload(string ConversationId, ConversationStatusValue Status, DateTime Time);
public readonly record struct CommentRemovedPayload(
    int articleId,
    string commentId,
    string? rootId,
    string? parentId,
    DateTime time);

public record struct FileUploadResult
{
    public bool Success { get; set; }
    public string Message { get; set; } = string.Empty;
    public string? RelativeUrl { get; set; }
    public string? Url { get; set; }
    public string? PhysicalPath { get; set; }
    public FileUploadResult() { }
}

public readonly record struct FileUploadOutputDto(string Url, string RelativeUrl, string Message);
public sealed record class UploadInitDto
{
    public string UploadId { get; init; } = string.Empty;
    public string FileName { get; init; } = string.Empty;
    public string MimeType { get; init; } = string.Empty;
    public string TargetFormat { get; init; } = string.Empty;
    public long TotalBytes { get; init; }
    public int ChunkSize { get; init; }
    public int TotalParts { get; init; }
    public DateTime ExpiresAt { get; init; }
}

public sealed record class UploadStatusDto
{
    public string UploadId { get; init; } = string.Empty;
    public string Status { get; init; } = string.Empty;
    public long TotalBytes { get; init; }
    public long UploadedBytes { get; init; }
    public int ChunkSize { get; init; }
    public int TotalParts { get; init; }
    public int UploadedPartCount { get; init; }
    public int NextPartHint { get; init; }
    public DateTime ExpiresAt { get; init; }
}

public readonly record struct UploadPartRangeDto(int Start, int End);

public sealed record class UploadPartMapDto
{
    public string UploadId { get; init; } = string.Empty;
    public List<UploadPartRangeDto> UploadedRanges { get; init; } = [];
}

public sealed record class UploadPartAckDto
{
    public string UploadId { get; init; } = string.Empty;
    public int PartNumber { get; init; }
    public long Offset { get; init; }
    public int Size { get; init; }
    public long UploadedBytes { get; init; }
    public int UploadedPartCount { get; init; }
}

public sealed record class UploadCompleteDto
{
    public string UploadId { get; init; } = string.Empty;
    public string Url { get; init; } = string.Empty;
    public string RelativeUrl { get; init; } = string.Empty;
    public string MimeType { get; init; } = string.Empty;
    public long TotalBytes { get; init; }
}

public readonly record struct PowChallenge(
    string Salt,
    int Difficulty,
    long Timestamp,
    string Signature
);

public readonly record struct MfaSetupStartDto(
    bool Enabled,
    string Secret,
    string OtpAuthUrl,
    string Issuer,
    string Account);

public sealed record class MfaSetupVerifyDto
{
    public bool Enabled { get; init; }
    public List<string> RecoveryCodes { get; init; } = [];
}

public readonly record struct MfaProfileDto(
    bool Enabled,
    DateTime? VerifiedAt);

public readonly record struct MfaChallengeResultDto(
    bool Verified,
    string Action,
    string? ProofToken,
    AuthIdentitySnapshotDto? User);

public readonly record struct UserSessionSummaryDto(
    string SessionId,
    string DeviceFingerprint,
    string DeviceLabel,
    DateTime? LastSeenAt,
    bool IsCurrent,
    bool MfaVerified);

public readonly record struct AdminSessionSummaryDto(
    string SessionId,
    string? DeviceFingerprint,
    string? LastIp,
    string? UserAgent,
    DateTime CreatedAtUtc,
    DateTime? LastSeenAtUtc,
    DateTime IdleExpiresAtUtc,
    DateTime AbsoluteExpiresAtUtc,
    bool IsCurrent,
    bool IsRevoked);

public readonly record struct AdminPrincipalSnapshotDto(
    string Id,
    string DisplayName,
    string Source,
    IReadOnlyList<string> Permissions,
    string AdminSessionStatus,
    bool TotpStepUpRequired);
