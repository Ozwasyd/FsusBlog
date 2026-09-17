namespace FsusBlog.Shared.Contracts.Outputs;

/// <summary>
/// Defines the API output contract represented by <c>ArticleCategoryView</c>.
/// </summary>
public readonly record struct ArticleCategoryView(int Id, string Name);
/// <summary>
/// Defines the API output contract represented by <c>FeaturedArticleSummaryDto</c>.
/// </summary>
public readonly record struct FeaturedArticleSummaryDto(int Id, string Title, string CoverImageUrl, int Views, DateTime CreateTime, ArticleCategoryView Category);
/// <summary>
/// Defines the API output contract represented by <c>TagDto</c>.
/// </summary>
public readonly record struct TagDto(int Id, string Name);
/// <summary>
/// Defines the API output contract represented by <c>TagWithCountDto</c>.
/// </summary>
public readonly record struct TagWithCountDto(int Id, string Name, int ArticleCount);
/// <summary>
/// Distinguishes whether an article mutation applied a change or was a no-op.
/// </summary>
public enum ArticleMutationOutcome : byte
{
    Applied = 0,
    NoChange = 1
}

/// <summary>
/// Defines the successful result shared by article create, update, and rollback commands.
/// </summary>
public readonly record struct ArticleMutationResult(
    int ArticleId,
    long RevisionId,
    int RevisionNo,
    long ReleaseId,
    int ReleaseNo,
    int Status,
    long RightsSnapshotId,
    int RightsRevisionNo,
    bool IdempotencyReplay,
    byte ErrorCode,
    ArticleMutationOutcome Outcome = ArticleMutationOutcome.Applied);
/// <summary>
/// Defines the API output contract represented by <c>TrashClearResponseDto</c>.
/// </summary>
public readonly record struct TrashClearResponseDto(int Count);
/// <summary>
/// Defines the API output contract represented by <c>ArticleNoticeDto</c>.
/// </summary>
public readonly record struct ArticleNoticeDto(
    int ArticleId,
    string Action,
    DateTime EventTime,
    ArticleListItemResponse? Preview = null,
    string? RevisionId = null,
    string? ReleaseId = null);

/// <summary>通行密钥凭证摘要（返回给前端）</summary>
public readonly record struct PasskeyCredentialSummaryDto(
    int Id,
    string? DeviceFriendlyName,
    DateTime CreatedAt,
    DateTime? LastUsedAt,
    string AaGuid,
    bool BackupEligible,
    bool BackupState);

/// <summary>
/// Defines the authenticated, authoritative state used by WebAuthn Level 3 Signal API calls.
/// </summary>
public readonly record struct PasskeySignalStateDto(
    long Revision,
    string RpId,
    string UserId,
    string Name,
    string DisplayName,
    IReadOnlyList<string> AllAcceptedCredentialIds);

/// <summary>
/// Defines the authoritative user locale preference returned by the server.
/// </summary>
public readonly record struct UserLocalePreferenceDto(
    string Mode,
    string? FixedLocale,
    long Revision,
    DateTime UpdatedAt);

/// <summary>
/// Defines a revision-checked user locale preference update.
/// </summary>
public readonly record struct UserLocalePreferenceUpdateDto(
    string Mode,
    string? FixedLocale,
    long ExpectedRevision);

/// <summary>
/// Defines the API output contract represented by <c>PageResponse</c>.
/// </summary>
public sealed record class PageResponse<T>
{
    public List<T> Items { get; init; } = [];
    public int Total
    {
        get; init;
    }
    public string? NextCursor
    {
        get; init;
    }
    public bool HasMore
    {
        get; init;
    }
}

/// <summary>
/// Defines the API output contract represented by <c>CursorResponse</c>.
/// </summary>
public sealed record class CursorResponse<T>
{
    public List<T> Data { get; init; } = [];
    public string? NextCursor
    {
        get; init;
    }
    public bool HasMore
    {
        get; init;
    }
}

/// <summary>
/// Defines the API output contract represented by <c>ArticleListItemResponse</c>.
/// </summary>
public record struct ArticleListItemResponse
{
    public int Id
    {
        get; set;
    }
    public string Title
    {
        get; set;
    }
    public string? Summary
    {
        get; set;
    }
    public string? CoverImageUrl
    {
        get; set;
    }
    public int Views
    {
        get; set;
    }
    public DateTime CreateTime
    {
        get; set;
    }
    public ArticleCategoryView Category
    {
        get; set;
    }
    public List<TagDto> Tags
    {
        get; set;
    }
    public bool? IsDeleted
    {
        get; set;
    }
    public int Status
    {
        get; set;
    }
    public DateTime? ScheduledPublishAt
    {
        get; set;
    }
    public DateTime? PublishedAt
    {
        get; set;
    }
    public long CurrentRevisionId
    {
        get; set;
    }
    public int RevisionNo
    {
        get; set;
    }
    public long? CurrentPublicationId
    {
        get; set;
    }
    public int? PublicationNo
    {
        get; set;
    }

    public ArticleListItemResponse()
    {
        Title = string.Empty;
        Tags = [];
        Status = 2;
    }
}

/// <summary>
/// Defines the API output contract represented by <c>CategoryListItemResponse</c>.
/// </summary>
public record struct CategoryListItemResponse
{
    public int Id
    {
        get; set;
    }
    public required string Name
    {
        get; set;
    }
    public int ArticleCount
    {
        get; set;
    }
}

/// <summary>
/// Defines the API output contract represented by <c>ArticleDetailResponse</c>.
/// </summary>
public record struct ArticleDetailResponse
{
    public int Id
    {
        get; set;
    }
    public string Title
    {
        get; set;
    }
    public string Content
    {
        get; set;
    }
    public string? Summary
    {
        get; set;
    }
    public string? CoverImageUrl
    {
        get; set;
    }
    public int Views
    {
        get; set;
    }
    public DateTime CreateTime
    {
        get; set;
    }
    public ArticleCategoryView Category
    {
        get; set;
    }
    public List<TagDto> Tags
    {
        get; set;
    }
    public bool IsDeleted
    {
        get; set;
    }
    public int Status
    {
        get; set;
    }
    public DateTime? ScheduledPublishAt
    {
        get; set;
    }
    public DateTime? PublishedAt
    {
        get; set;
    }
    public DateTime? UpdatedAt
    {
        get; set;
    }
    public long CurrentRevisionId
    {
        get; set;
    }
    public int RevisionNo
    {
        get; set;
    }
    public long? CurrentPublicationId
    {
        get; set;
    }
    public int? PublicationNo
    {
        get; set;
    }
    public ArticleRightsResponse Rights
    {
        get; set;
    }

    public ArticleDetailResponse()
    {
        Title = string.Empty;
        Content = string.Empty;
        Tags = [];
        Status = 2;
        Rights = new ArticleRightsResponse();
    }
}

/// <summary>
/// Defines the API output contract represented by <c>ArticleRightsResponse</c>.
/// </summary>
public record struct ArticleRightsResponse
{
    public long SnapshotId
    {
        get; set;
    }
    public long ArticleRevisionId
    {
        get; set;
    }
    public int RevisionNo
    {
        get; set;
    }
    public bool Enabled
    {
        get; set;
    }
    public string LicenseType
    {
        get; set;
    }
    public string? CopyrightHolder
    {
        get; set;
    }
    public int? CopyrightYear
    {
        get; set;
    }
    public string? RightsStatement
    {
        get; set;
    }
    public string? AttributionTemplate
    {
        get; set;
    }
    public string CopyPolicy
    {
        get; set;
    }
    public int MaxExcerptChars
    {
        get; set;
    }
    public bool AllowCodeCopy
    {
        get; set;
    }
    public bool ShowPublicBadge
    {
        get; set;
    }
    public bool ProofBindingEnabled
    {
        get; set;
    }
    public string? CanonicalUrl
    {
        get; set;
    }
    public string PolicyHash
    {
        get; set;
    }
    public string ContentCanonicalHash
    {
        get; set;
    }
    public string? ProofUrl
    {
        get; set;
    }
    public string? ProofStatus
    {
        get; set;
    }

    public ArticleRightsResponse()
    {
        Enabled = true;
        LicenseType = "all-rights-reserved";
        CopyPolicy = "append-attribution";
        MaxExcerptChars = 300;
        AllowCodeCopy = true;
        ShowPublicBadge = true;
        ProofBindingEnabled = true;
        PolicyHash = string.Empty;
        ContentCanonicalHash = string.Empty;
    }
}

/// <summary>
/// Defines the API output contract represented by <c>RelatedReadingResponse</c>.
/// </summary>
public sealed record RelatedReadingResponse(
    IReadOnlyList<RelatedReadingItem> Related,
    RelatedReadingItem? Previous,
    RelatedReadingItem? Next);

/// <summary>
/// Defines the API output contract represented by <c>RelatedReadingItem</c>.
/// </summary>
public sealed record RelatedReadingItem(
    int Id,
    string Title,
    string? Summary,
    DateTime CreateTime,
    string Reason);

/// <summary>
/// Defines the API output contract represented by <c>HumanReadChallengeResponse</c>.
/// </summary>
public sealed record class HumanReadChallengeResponse(
    string Token,
    string Scope,
    string RouteKey,
    int? ArticleId,
    int MinDwellMs,
    DateTimeOffset IssuedAt,
    DateTimeOffset ExpiresAt);

/// <summary>
/// Defines the API output contract represented by <c>HumanReadChallengeRequest</c>.
/// </summary>
public sealed record class HumanReadChallengeRequest(
    string Scope,
    string RouteKey,
    int? ArticleId);

/// <summary>
/// Defines the API output contract represented by <c>HumanReadSubmitRequest</c>.
/// </summary>
public sealed record class HumanReadSubmitRequest(
    string Token,
    string Scope,
    string RouteKey,
    int? ArticleId,
    int DwellMs);

/// <summary>
/// Defines the API output contract represented by <c>HumanReadSubmitResponse</c>.
/// </summary>
public sealed record class HumanReadSubmitResponse(
    bool Counted,
    string Status);

/// <summary>
/// Provides canonical output rules for the <c>RumTelemetryContractLimits</c> public contract family.
/// </summary>
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

/// <summary>
/// Defines the API output contract represented by <c>RumMetricBatchRequest</c>.
/// </summary>
public sealed record class RumMetricBatchRequest(
    string PageType,
    string RouteKey,
    string AotSource,
    IReadOnlyList<RumMetricBatchItem> Metrics);

/// <summary>
/// Defines the API output contract represented by <c>RumMetricBatchItem</c>.
/// </summary>
public sealed record class RumMetricBatchItem(
    string Name,
    double? Value,
    DateTime? Timestamp,
    IReadOnlyDictionary<string, double>? Metrics,
    IReadOnlyDictionary<string, string>? Dimensions);

/// <summary>
/// Defines the API output contract represented by <c>RumMetricIngestResponse</c>.
/// </summary>
public sealed record class RumMetricIngestResponse(
    bool Accepted,
    int AcceptedCount = 0,
    int RejectedCount = 0);

/// <summary>
/// Defines the API output contract represented by <c>SiteSubscriptionBinaryRequest</c>.
/// </summary>
public sealed record class SiteSubscriptionBinaryRequest(
    string Email,
    string? Channel);

/// <summary>
/// Defines the API output contract represented by <c>SiteSubscriptionBinaryResponse</c>.
/// </summary>
public sealed record class SiteSubscriptionBinaryResponse(
    bool Subscribed,
    bool Unsubscribed,
    string Channel);

/// <summary>
/// Defines the API output contract represented by <c>UserCommentResponse</c>.
/// </summary>
public record struct UserCommentResponse
{
    public long Id
    {
        get; init;
    }
    public string Content
    {
        get; init;
    }
    public DateTime CreateTime
    {
        get; init;
    }
    public int ArticleId
    {
        get; init;
    }
    public string ArticleTitle
    {
        get; init;
    }
    public long? RootId
    {
        get; init;
    }
    public CommentAuthorViewDto Author
    {
        get; init;
    }
    public CommentAuthorViewDto? ReplyToAuthor
    {
        get; init;
    }
    public int ModerationStatus
    {
        get; init;
    }
    public string ModerationStatusLabel
    {
        get; init;
    }
    public string VisibilityState
    {
        get; init;
    }
    public string VisibilityReasonCode
    {
        get; init;
    }
    public bool IsPubliclyVisible
    {
        get; init;
    }

    public UserCommentResponse()
    {
        Content = string.Empty;
        ArticleTitle = string.Empty;
        ModerationStatusLabel = string.Empty;
        VisibilityState = string.Empty;
        VisibilityReasonCode = string.Empty;
    }
}

/// <summary>
/// Defines the API output contract represented by <c>BlindCredentialIssuerMetadata</c>.
/// </summary>
public sealed record class BlindCredentialIssuerMetadata(
    long CredentialEpoch,
    long ExpiresAtUnixMs,
    uint CircuitNumericId,
    ushort PublicInputLayoutVersion,
    string CircuitId,
    string CredentialLevel,
    string SchemeId,
    string IssuerPublicKeyId,
    string IssuerPublicKeyHash,
    ushort ModulusBytes,
    byte[] SubjectPublicKeyInfo);

/// <summary>
/// Defines the API output contract represented by <c>BlindCredentialIssueRequest</c>.
/// </summary>
public sealed record class BlindCredentialIssueRequest(
    long CredentialEpoch,
    uint CircuitNumericId,
    ushort PublicInputLayoutVersion,
    string CircuitId,
    string CredentialLevel,
    string SchemeId,
    string IssuerPublicKeyId,
    byte[] BlindedMessage);

/// <summary>
/// Defines the API output contract represented by <c>BlindCredentialIssueResponse</c>.
/// </summary>
public sealed record class BlindCredentialIssueResponse(
    long CredentialEpoch,
    long ExpiresAtUnixMs,
    uint CircuitNumericId,
    ushort PublicInputLayoutVersion,
    string CircuitId,
    string CredentialLevel,
    string SchemeId,
    string IssuerPublicKeyId,
    byte[] BlindSignature);

/// <summary>
/// Defines the API output contract represented by <c>AnonymousCredentialRootSnapshot</c>.
/// </summary>
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

/// <summary>
/// Defines the API output contract represented by <c>AnonymousCommentTicketRequest</c>.
/// </summary>
public sealed record class AnonymousCommentTicketRequest(
    int ArticleId,
    string? ParentId,
    string? RootId,
    string? ReplyToCommentId,
    uint CircuitNumericId,
    ushort PublicInputLayoutVersion,
    string ActionContext,
    string Scope,
    string CircuitId,
    string VerifyingKeyHash,
    byte[] NullifierHash,
    byte[] CredentialRoot,
    byte[] RevocationRoot,
    bool IsEligible,
    bool MayComment,
    string RateClass,
    bool RequiresModeration,
    byte[] Groth16Proof,
    byte[] PublicInputs);

/// <summary>
/// Defines the API output contract represented by <c>AnonymousCommentTicketResponse</c>.
/// </summary>
public sealed record class AnonymousCommentTicketResponse(
    long TicketExpiresAtUnixMs,
    string RateClass,
    bool RequiresModeration,
    byte[] Ticket,
    byte[] ModerationSubjectHash);

/// <summary>
/// Defines the API output contract represented by <c>AnonymousCommentCreateRequest</c>.
/// </summary>
public sealed record class AnonymousCommentCreateRequest(
    int ArticleId,
    string Content,
    string? ParentId,
    string? RootId,
    string? ReplyToCommentId,
    string AnonymousScope,
    string DisplayLanguage,
    byte[] Ticket);

/// <summary>
/// Defines the API output contract represented by <c>AnonymousPrivacyStateSnapshot</c>.
/// </summary>
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

/// <summary>
/// Defines the API output contract represented by <c>SeoConfigPublicDto</c>.
/// </summary>
public sealed record class SeoConfigPublicDto
{
    public string Title { get; init; } = PublicSiteIdentityDefaults.SiteTitle;
    public string Description { get; init; } = PublicSiteIdentityDefaults.SiteDescription;
    public string Keywords { get; init; } = PublicSiteIdentityDefaults.SiteKeywords;
    public string Author { get; init; } = PublicSiteIdentityDefaults.SiteAuthor;
    public string OgImage { get; init; } = "/social/og-image.png";
    public string BaseUrl { get; init; } = PublicSiteIdentityDefaults.SiteBaseUrl;
    public string FaviconSvgUrl { get; init; } = "/favicon/favicon.svg";
    public string FaviconIcoUrl { get; init; } = "/favicon/favicon.ico";
    public string FaviconPngUrl { get; init; } = "/favicon/favicon-32x32.png";
    public string AppleTouchIconUrl { get; init; } = "/favicon/apple-touch-icon.png";
    public string ManifestName { get; init; } = PublicSiteIdentityDefaults.ManifestName;
    public string ManifestShortName { get; init; } = PublicSiteIdentityDefaults.ManifestShortName;
    public string PwaIcon192Url { get; init; } = "/favicon/pwa-192x192.png";
    public string PwaIcon512Url { get; init; } = "/favicon/pwa-512x512.png";
    public string PwaMaskableIconUrl { get; init; } = "/favicon/maskable-icon-512x512.png";
    public string ThemeColor { get; init; } = "#0B4F7A";
    public string BackgroundColor { get; init; } = "#FFFFFF";
    public string SiteLogoUrl { get; init; } = string.Empty;
    public string SiteLogoDarkUrl { get; init; } = string.Empty;
    public string SiteWordmarkUrl { get; init; } = string.Empty;
    public string AdminLogoUrl { get; init; } = string.Empty;
    public string AdminCollapsedIconUrl { get; init; } = string.Empty;
    public string LoginLogoUrl { get; init; } = string.Empty;
    public string LoginIconUrl { get; init; } = string.Empty;
}

/// <summary>
/// Defines the API output contract represented by <c>SeoConfigAdminDto</c>.
/// </summary>
public sealed record class SeoConfigAdminDto
{
    public string Title { get; init; } = PublicSiteIdentityDefaults.SiteTitle;
    public string Description { get; init; } = PublicSiteIdentityDefaults.SiteDescription;
    public string Keywords { get; init; } = PublicSiteIdentityDefaults.SiteKeywords;
    public string Author { get; init; } = PublicSiteIdentityDefaults.SiteAuthor;
    public string OgImage { get; init; } = "/social/og-image.png";
    public string BaseUrl { get; init; } = PublicSiteIdentityDefaults.SiteBaseUrl;
    public string FaviconSvgUrl { get; init; } = "/favicon/favicon.svg";
    public string FaviconIcoUrl { get; init; } = "/favicon/favicon.ico";
    public string FaviconPngUrl { get; init; } = "/favicon/favicon-32x32.png";
    public string AppleTouchIconUrl { get; init; } = "/favicon/apple-touch-icon.png";
    public string ManifestName { get; init; } = PublicSiteIdentityDefaults.ManifestName;
    public string ManifestShortName { get; init; } = PublicSiteIdentityDefaults.ManifestShortName;
    public string PwaIcon192Url { get; init; } = "/favicon/pwa-192x192.png";
    public string PwaIcon512Url { get; init; } = "/favicon/pwa-512x512.png";
    public string PwaMaskableIconUrl { get; init; } = "/favicon/maskable-icon-512x512.png";
    public string ThemeColor { get; init; } = "#0B4F7A";
    public string BackgroundColor { get; init; } = "#FFFFFF";
    public string SiteLogoUrl { get; init; } = string.Empty;
    public string SiteLogoDarkUrl { get; init; } = string.Empty;
    public string SiteWordmarkUrl { get; init; } = string.Empty;
    public string AdminLogoUrl { get; init; } = string.Empty;
    public string AdminCollapsedIconUrl { get; init; } = string.Empty;
    public string LoginLogoUrl { get; init; } = string.Empty;
    public string LoginIconUrl { get; init; } = string.Empty;
}

/// <summary>
/// Defines the API output contract represented by <c>SiteComplianceConfigPublicDto</c>.
/// </summary>
public record class SiteComplianceConfigPublicDto
{
    public bool Enabled
    {
        get; init;
    }
    public string RegionMode { get; init; } = "global";
    public string CopyrightOwner { get; init; } = string.Empty;
    public int? CopyrightStartYear
    {
        get; init;
    }
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

/// <summary>
/// Defines the API output contract represented by <c>SiteComplianceConfigAdminDto</c>.
/// </summary>
public sealed record class SiteComplianceConfigAdminDto : SiteComplianceConfigPublicDto;

/// <summary>
/// Defines the API output contract represented by <c>PageContentPublicDto</c>.
/// </summary>
public sealed record class PageContentPublicDto
{
    public string? Slug
    {
        get; init;
    }
    public string? Content
    {
        get; init;
    }
}

/// <summary>
/// Defines the API output contract represented by <c>PageContentAdminDto</c>.
/// </summary>
public sealed record class PageContentAdminDto
{
    public string? Slug
    {
        get; init;
    }
    public string? Content
    {
        get; init;
    }
}

/// <summary>
/// Defines the API output contract represented by <c>CommentItemDto</c>.
/// </summary>
public readonly record struct CommentItemDto(string Id, string Content, DateTime CreateTime, CommentAuthorViewDto Author);
/// <summary>
/// Defines the API output contract represented by <c>CommentListResponseDto</c>.
/// </summary>
public readonly record struct CommentListResponseDto(List<CommentItemDto> Data, string? NextCursor, bool HasMore);

/// <summary>
/// Defines the API output contract represented by <c>CommentAuthorViewDto</c>.
/// </summary>
public readonly record struct CommentAuthorViewDto(
    string Mode,
    string DisplayName,
    string DisplayLanguage,
    string? Badge,
    string? ScopeLabel);

/// <summary>
/// Defines the complete API output contract represented by the <c>CommentCreateResult</c> AEDS frame.
/// </summary>
public readonly record struct CommentCreateResultResponse(
    string CommentId,
    string RootId,
    string? ParentId,
    DateTime CreatedAtUtc,
    int ModerationStatus,
    string VisibilityState,
    bool IsPubliclyVisible,
    bool IdempotencyReplay);

/// <summary>
/// Defines the API output contract represented by <c>CommentReplyItemDto</c>.
/// </summary>
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
    bool IsDeleted,
    bool IsEdited = false);

/// <summary>
/// Defines the API output contract represented by <c>CommentReplyPreviewItemDto</c>.
/// </summary>
public readonly record struct CommentReplyPreviewItemDto(
    string Id,
    string Content,
    DateTime CreateTime,
    CommentAuthorViewDto Author,
    CommentAuthorViewDto? ReplyToAuthor,
    bool IsDeleted,
    bool IsEdited = false);

/// <summary>
/// Defines the API output contract represented by <c>CommentThreadItemDto</c>.
/// </summary>
public readonly record struct CommentThreadItemDto(
    string Id,
    string Content,
    DateTime CreateTime,
    CommentAuthorViewDto Author,
    string RootId,
    bool IsDeleted,
    int ReplyCount,
    bool HasMoreReplies,
    List<CommentReplyPreviewItemDto> RepliesPreview,
    bool IsEdited = false);

/// <summary>
/// Defines one server-authoritative node in an arbitrarily deep comment tree.
/// </summary>
public readonly record struct CommentTreeNodeDto(
    string Id,
    string Content,
    DateTime CreateTime,
    CommentAuthorViewDto Author,
    CommentAuthorViewDto? ReplyToAuthor,
    string? ParentId,
    string RootId,
    string? ReplyToCommentId,
    int Depth,
    bool IsDeleted,
    int ChildCount,
    bool HasMoreChildren,
    bool IsEdited = false);

/// <summary>
/// Defines a root comment and its first independently pageable child window.
/// </summary>
public readonly record struct CommentTreeRootDto(
    CommentTreeNodeDto Node,
    List<CommentTreeNodeDto> ChildrenPreview);

/// <summary>
/// Defines one independently pageable direct-child window with authoritative parent/root coordinates.
/// </summary>
public readonly record struct CommentChildCursorDto(
    string ParentId,
    string RootId,
    CursorResponse<CommentTreeNodeDto> Cursor);

/// <summary>
/// Defines the privacy-preserving result of resolving a comment permalink.
/// </summary>
public readonly record struct CommentPermalinkContextDto(
    string Status,
    string? TargetId,
    string? RootId,
    List<CommentTreeNodeDto> Ancestors,
    CommentTreeNodeDto? Target,
    List<CommentTreeNodeDto> Siblings,
    bool HasPreviousSiblings,
    bool HasNextSiblings);

/// <summary>
/// Defines the API output contract represented by <c>CommentQueryResultDto</c>.
/// </summary>
public readonly record struct CommentQueryResultDto(long Id, string Content, DateTime CreateTime, CommentAuthorViewDto Author);
/// <summary>
/// Defines the API output contract represented by <c>CommentUserQueryResult</c>.
/// </summary>
public readonly record struct CommentUserQueryResult(string DisplayName);
/// <summary>
/// Defines the API output contract represented by <c>CommentDeleteQueryResult</c>.
/// </summary>
public readonly record struct CommentDeleteQueryResult(int UserId, int ArticleId, string Content, string ArticleTitle);

/// <summary>
/// Defines the API output contract represented by <c>StatsSummaryDto</c>.
/// </summary>
public sealed record class StatsSummaryDto
{
    public int TotalArticles
    {
        get; init;
    }
    public int TotalComments
    {
        get; init;
    }
    public int TrashCount
    {
        get; init;
    }
    public int TotalReads
    {
        get; init;
    }
    public int HumanVerifiedReads
    {
        get; init;
    }
    public int UniqueViewerKeyEstimate
    {
        get; init;
    }
    public int ArticleReads
    {
        get; init;
    }
    public int SiteReads
    {
        get; init;
    }
}

/// <summary>
/// Defines the API output contract represented by <c>AdminStatsOverviewDto</c>.
/// </summary>
public sealed record class AdminStatsOverviewDto
{
    public StatsSummaryDto Summary { get; init; } = new();
    public List<PopularArticleStatItemDto> PopularArticles { get; init; } = [];
}

/// <summary>
/// Defines the API output contract represented by <c>AdminStatsQueryDto</c>.
/// </summary>
public sealed record class AdminStatsQueryDto
{
    public AdminStatsOverviewDto Overview { get; init; } = new();
    public List<RecentCommentStatItemDto> RecentComments { get; init; } = [];
    public List<RegionStatItemDto> Regions { get; init; } = [];
}

/// <summary>
/// Defines the API output contract represented by <c>PopularArticleSummaryDto</c>.
/// </summary>
public readonly record struct PopularArticleSummaryDto(int Id, string Title, int Views);
/// <summary>
/// Defines the API output contract represented by <c>PopularArticleStatItemDto</c>.
/// </summary>
public readonly record struct PopularArticleStatItemDto(int Id, string Title, int Views);
/// <summary>
/// Defines the API output contract represented by <c>RecentCommentStatItemDto</c>.
/// </summary>
public readonly record struct RecentCommentStatItemDto(
    string AuthorDisplayName,
    string AuthorMode,
    string? AuthorBadge,
    string? AuthorScopeLabel,
    string Content,
    DateTime CreateTime);
/// <summary>
/// Defines the API output contract represented by <c>RegionStatItemDto</c>.
/// </summary>
public readonly record struct RegionStatItemDto(string Region, int Count);

/// <summary>
/// Defines the API output contract represented by <c>TokenResponseDto</c>.
/// </summary>
public readonly record struct TokenResponseDto(
    string AccessToken,
    string RefreshToken,
    DateTime? RefreshTokenExpiresAt = null,
    string? SessionId = null,
    DateTimeOffset? AccessTokenExpiresAtUtc = null);
/// <summary>
/// Defines the API output contract represented by <c>AuthIdentitySnapshotDto</c>.
/// </summary>
public readonly record struct AuthIdentitySnapshotDto(int AccountId, string IdentityKind);
/// <summary>
/// Defines the API output contract represented by <c>AuthLoginFlowDto</c>.
/// </summary>
public readonly record struct AuthLoginFlowDto(
    int AccountId,
    string IdentityKind,
    string AuthPhase,
    string? MfaMode,
    string? ChallengeToken);
/// <summary>
/// Defines the API output contract represented by <c>CurrentUserSnapshotDto</c>.
/// </summary>
public readonly record struct CurrentUserSnapshotDto(int AccountId, string IdentityKind, int Status, string? BanReason, DateTime? DeletedAt);
/// <summary>
/// Defines the API output contract represented by <c>AdminAccountListItemDto</c>.
/// </summary>
public readonly record struct AdminAccountListItemDto(
    int AccountId,
    string IdentityKind,
    string? PublicHandle,
    bool PasskeyInitialized,
    bool RecoveryInitialized,
    DateTime? PrivacyInitializedAt,
    string AnonymousCredentialStatus,
    int RiskFlags,
    int Status,
    DateTime CreateTime,
    DateTime? DeletedAt);

/// <summary>
/// Enumerates stable wire values represented by the <c>ConversationStatusValue</c> contract.
/// </summary>
public enum ConversationStatusValue
{
    Open = 0,
    Pending = 1,
    Closed = 2
}

/// <summary>
/// Enumerates the stable result of an admin conversation-status mutation.
/// </summary>
public enum ConversationStatusMutationOutcomeValue : byte
{
    Changed = 0,
    NoChange = 1
}

/// <summary>
/// Returns the authoritative status projection after a status mutation.
/// </summary>
public readonly record struct ConversationStatusMutationResultResponse(
    ConversationStatusValue PreviousStatus,
    ConversationStatusValue CurrentStatus,
    ConversationStatusMutationOutcomeValue Outcome);

/// <summary>
/// Enumerates stable wire values represented by the <c>ConversationSenderValue</c> contract.
/// </summary>
public enum ConversationSenderValue
{
    Account = 0,
    Admin = 1,
    System = 2
}

/// <summary>
/// Defines the API output contract represented by <c>ConversationListItemResponse</c>.
/// </summary>
public record class ConversationListItemResponse
{
    public string ConversationId { get; init; } = string.Empty;
    public string Subject { get; init; } = string.Empty;
    public ConversationStatusValue Status { get; init; } = ConversationStatusValue.Open;
    public bool IsSystemSource
    {
        get; init;
    }
    public bool CanReply
    {
        get; init;
    }
    public int UnreadCount
    {
        get; init;
    }
    public DateTime LastMessageAt
    {
        get; init;
    }
    public DateTime UpdatedAt
    {
        get; init;
    }
    public ConversationMessagePreviewResponse? LastMessage
    {
        get; init;
    }
}

/// <summary>
/// Defines the minimum account context exposed only by admin message endpoints.
/// </summary>
public sealed record class AdminConversationListItemResponse : ConversationListItemResponse
{
    public string CounterpartyAccountId { get; init; } = string.Empty;
    public CounterpartyAccountStatusValue CounterpartyAccountStatus { get; init; } = CounterpartyAccountStatusValue.Missing;
}

/// <summary>
/// Defines the coarse account state visible in admin-only message projections.
/// </summary>
public enum CounterpartyAccountStatusValue
{
    Active = 0,
    Restricted = 1,
    Deleted = 2,
    Missing = 3
}

/// <summary>
/// Defines the API output contract represented by <c>ConversationMessagePreviewResponse</c>.
/// </summary>
public sealed record class ConversationMessagePreviewResponse
{
    public ConversationSenderValue SenderType { get; init; } = ConversationSenderValue.System;
    public string? SenderName
    {
        get; init;
    }
    public string BodyPreview { get; init; } = string.Empty;
    public DateTime CreatedAt
    {
        get; init;
    }
}

/// <summary>
/// Defines the API output contract represented by <c>ConversationMessageResponse</c>.
/// </summary>
public sealed record class ConversationMessageResponse
{
    public string MessageId { get; init; } = string.Empty;
    public string ConversationId { get; init; } = string.Empty;
    public bool IdempotencyReplay
    {
        get; init;
    }
    public ConversationSenderValue SenderType { get; init; } = ConversationSenderValue.System;
    public string? SenderName
    {
        get; init;
    }
    public string Body { get; init; } = string.Empty;
    public DateTime CreatedAt
    {
        get; init;
    }
}

/// <summary>
/// Defines the API output contract represented by <c>ConversationDetailResponse</c>.
/// </summary>
public record class ConversationDetailResponse
{
    public string ConversationId { get; init; } = string.Empty;
    public bool IdempotencyReplay
    {
        get; init;
    }
    public string ReadSnapshotMessageId { get; init; } = string.Empty;
    public string? PreviousCursor
    {
        get; init;
    }
    public bool HasOlder
    {
        get; init;
    }
    public string Subject { get; init; } = string.Empty;
    public ConversationStatusValue Status { get; init; } = ConversationStatusValue.Open;
    public bool IsSystemSource
    {
        get; init;
    }
    public bool CanReply
    {
        get; init;
    }
    public int UnreadCount
    {
        get; init;
    }
    public DateTime LastMessageAt
    {
        get; init;
    }
    public List<ConversationMessageResponse> Messages { get; init; } = [];
}

/// <summary>
/// Defines an admin-only conversation detail projection without session or profile metadata.
/// </summary>
public sealed record class AdminConversationDetailResponse : ConversationDetailResponse
{
    public string CounterpartyAccountId { get; init; } = string.Empty;
    public CounterpartyAccountStatusValue CounterpartyAccountStatus { get; init; } = CounterpartyAccountStatusValue.Missing;
}

/// <summary>
/// Defines the API output contract represented by <c>CommentPushDto</c>.
/// </summary>
public readonly record struct CommentPushDto
{
    public string Id
    {
        get; init;
    }

    public string Content
    {
        get; init;
    }

    public DateTime CreateTime
    {
        get; init;
    }

    public CommentAuthorViewDto Author
    {
        get; init;
    }

    public string? ParentId
    {
        get; init;
    }

    public string? RootId
    {
        get; init;
    }

    public CommentAuthorViewDto? ReplyToAuthor
    {
        get; init;
    }

    public string? ReplyToCommentId
    {
        get; init;
    }

    public int Depth
    {
        get; init;
    }

    public bool IsDeleted
    {
        get; init;
    }
}

/// <summary>
/// Defines the API output contract represented by <c>CommentAddedNotifyDto</c>.
/// </summary>
public readonly record struct CommentAddedNotifyDto
{
    public int ArticleId
    {
        get; init;
    }

    public CommentPushDto Comment
    {
        get; init;
    }

    public DateTime Time
    {
        get; init;
    }
}

// These positional names are part of the legacy notification JSON contract.
// Preserve their wire casing while keeping the exception local to this contract block.
#pragma warning disable IDE1006
/// <summary>
/// Defines the API output contract represented by <c>GlobalNoticePayload</c>.
/// </summary>
public readonly record struct GlobalNoticePayload(string id, string title, DateTime time);
/// <summary>
/// Defines the API output contract represented by <c>MessageRevokedPayload</c>.
/// </summary>
public readonly record struct MessageRevokedPayload(string messageId, int? unreadCount = null, DateTime? time = null);
/// <summary>
/// Defines the API output contract represented by <c>AccountStatusPayload</c>.
/// </summary>
public readonly record struct AccountStatusPayload(int status, string? reason, DateTime time);
/// <summary>
/// Defines the API output contract represented by <c>SessionRevokedPayload</c>.
/// </summary>
public readonly record struct SessionRevokedPayload(string reason, int revokedSessionCount, DateTime time);
/// <summary>
/// Defines the API output contract represented by <c>NoticePayload</c>.
/// </summary>
public readonly record struct NoticePayload(string title, int unreadCount, DateTime time);
/// <summary>
/// Defines the API output contract represented by <c>InboxConversationUpsertPayload</c>.
/// </summary>
public readonly record struct InboxConversationUpsertPayload(ConversationListItemResponse Conversation, int? TotalUnread = null, DateTime? Time = null);
/// <summary>
/// Defines the API output contract represented by <c>InboxMessageAppendPayload</c>.
/// </summary>
public readonly record struct InboxMessageAppendPayload(string ConversationId, ConversationMessageResponse Message, int? ConversationUnreadCount = null, int? TotalUnread = null, DateTime? Time = null);
/// <summary>
/// Defines the API output contract represented by <c>InboxReadUpdatedPayload</c>.
/// </summary>
public readonly record struct InboxReadUpdatedPayload(string ConversationId, string? LastReadMessageId, int ConversationUnreadCount, int? TotalUnread = null, DateTime? Time = null);
/// <summary>
/// Defines the API output contract represented by <c>InboxConversationStatusChangedPayload</c>.
/// </summary>
public readonly record struct InboxConversationStatusChangedPayload(string ConversationId, ConversationStatusValue Status, DateTime Time);
/// <summary>
/// Defines the API output contract represented by <c>CommentRemovedPayload</c>.
/// </summary>
public readonly record struct CommentRemovedPayload(
    int articleId,
    string commentId,
    string? rootId,
    string? parentId,
    DateTime time);
#pragma warning restore IDE1006

/// <summary>
/// Defines the API output contract represented by <c>FileUploadOutputDto</c>.
/// </summary>
public readonly record struct FileUploadOutputDto(string Url, string RelativeUrl, string Message);
/// <summary>
/// Defines the API output contract represented by <c>UploadInitDto</c>.
/// </summary>
public sealed record class UploadInitDto
{
    public string UploadId { get; init; } = string.Empty;
    public string FileName { get; init; } = string.Empty;
    public string MimeType { get; init; } = string.Empty;
    public string TargetFormat { get; init; } = string.Empty;
    public long TotalBytes
    {
        get; init;
    }
    public int ChunkSize
    {
        get; init;
    }
    public int TotalParts
    {
        get; init;
    }
    public DateTime ExpiresAt
    {
        get; init;
    }
    public string UploadToken { get; init; } = string.Empty;
}

/// <summary>
/// Defines the API output contract represented by <c>UploadStatusDto</c>.
/// </summary>
public sealed record class UploadStatusDto
{
    public string UploadId { get; init; } = string.Empty;
    public string Status { get; init; } = string.Empty;
    public long TotalBytes
    {
        get; init;
    }
    public long UploadedBytes
    {
        get; init;
    }
    public int ChunkSize
    {
        get; init;
    }
    public int TotalParts
    {
        get; init;
    }
    public int UploadedPartCount
    {
        get; init;
    }
    public int NextPartHint
    {
        get; init;
    }
    public DateTime ExpiresAt
    {
        get; init;
    }
}

/// <summary>
/// Defines the API output contract represented by <c>UploadPartRangeDto</c>.
/// </summary>
public readonly record struct UploadPartRangeDto(int Start, int End);

/// <summary>
/// Defines the API output contract represented by <c>UploadPartMapDto</c>.
/// </summary>
public sealed record class UploadPartMapDto
{
    public string UploadId { get; init; } = string.Empty;
    public List<UploadPartRangeDto> UploadedRanges { get; init; } = [];
}

/// <summary>
/// Defines the API output contract represented by <c>UploadPartAckDto</c>.
/// </summary>
public sealed record class UploadPartAckDto
{
    public string UploadId { get; init; } = string.Empty;
    public int PartNumber
    {
        get; init;
    }
    public long Offset
    {
        get; init;
    }
    public int Size
    {
        get; init;
    }
    public long UploadedBytes
    {
        get; init;
    }
    public int UploadedPartCount
    {
        get; init;
    }
}

/// <summary>
/// Defines the API output contract represented by <c>UploadCompleteDto</c>.
/// </summary>
public sealed record class UploadCompleteDto
{
    public string UploadId { get; init; } = string.Empty;
    public string Url { get; init; } = string.Empty;
    public string RelativeUrl { get; init; } = string.Empty;
    public string MimeType { get; init; } = string.Empty;
    public long TotalBytes
    {
        get; init;
    }
}

/// <summary>
/// Defines the API output contract represented by <c>PowChallenge</c>.
/// </summary>
public readonly record struct PowChallenge(
    string Salt,
    int Difficulty,
    long Timestamp,
    string Signature
);

/// <summary>
/// Defines the API output contract represented by <c>MfaSetupStartDto</c>.
/// </summary>
public readonly record struct MfaSetupStartDto(
    bool Enabled,
    string Secret,
    string OtpAuthUrl,
    string Issuer,
    string Account);

/// <summary>
/// Defines the API output contract represented by <c>MfaSetupVerifyDto</c>.
/// </summary>
public sealed record class MfaSetupVerifyDto
{
    public bool Enabled
    {
        get; init;
    }
    public List<string> RecoveryCodes { get; init; } = [];
}

/// <summary>
/// Defines the API output contract represented by <c>MfaProfileDto</c>.
/// </summary>
public readonly record struct MfaProfileDto(
    bool Enabled,
    DateTime? VerifiedAt);

/// <summary>
/// Defines the API output contract represented by <c>MfaChallengeResultDto</c>.
/// </summary>
public readonly record struct MfaChallengeResultDto(
    bool Verified,
    string Action,
    string? ProofToken,
    AuthIdentitySnapshotDto? User);

/// <summary>
/// Defines the API output contract represented by <c>UserSessionSummaryDto</c>.
/// </summary>
public readonly record struct UserSessionSummaryDto(
    string SessionId,
    string DeviceLabel,
    DateTime CreatedAt,
    DateTime? LastSeenAt,
    string AuthenticationMethod,
    string AuthenticationStrength,
    string? PasskeyFriendlyName,
    string DurationPolicy,
    bool IsCurrent);

/// <summary>
/// Defines the API output contract represented by <c>AdminSessionSummaryDto</c>.
/// </summary>
public readonly record struct AdminSessionSummaryDto(
    string SessionId,
    string? DeviceFingerprint,
    string? UserAgent,
    DateTime CreatedAtUtc,
    DateTime? LastSeenAtUtc,
    DateTime IdleExpiresAtUtc,
    DateTime AbsoluteExpiresAtUtc,
    bool IsCurrent,
    bool IsRevoked);

/// <summary>
/// Defines the API output contract represented by <c>AdminPrincipalSnapshotDto</c>.
/// </summary>
public readonly record struct AdminPrincipalSnapshotDto(
    string Id,
    string DisplayName,
    string Source,
    IReadOnlyList<string> Permissions,
    string AdminSessionStatus,
    bool TotpStepUpRequired);

/// <summary>
/// Admin-only summary of one installed plugin. Package bytes and unredacted
/// manifest documents are deliberately excluded.
/// </summary>
public sealed record PluginAdminSummaryDto(
    string PluginId,
    string Name,
    string Version,
    string Runtime,
    string InstallState,
    string HealthState,
    bool Enabled,
    DateTimeOffset InstalledAtUtc,
    DateTimeOffset UpdatedAtUtc,
    string? LastErrorCode,
    int ActiveHookCount,
    int GrantedCapabilityCount,
    int RequestedCapabilityCount,
    bool ClusterConsistent);

/// <summary>
/// Admin-only plugin collection returned by the binary authoring surface.
/// </summary>
public sealed record PluginAdminOverviewDto(
    DateTimeOffset GeneratedAtUtc,
    string CurrentNodeId,
    IReadOnlyList<PluginAdminSummaryDto> Plugins);

/// <summary>
/// Defines the validated plugin manifest fields exposed to administrators.
/// </summary>
public sealed record PluginAdminManifestSummaryDto(
    string PluginId,
    string Name,
    string Version,
    string Author,
    string Description,
    string HostVersionRange,
    string Runtime,
    string RuntimeEntry,
    IReadOnlyList<string> RequestedCapabilities,
    IReadOnlyList<string> DeniedRawPermissions,
    IReadOnlyList<PluginAdminHookDto> Hooks);

/// <summary>
/// Defines one plugin hook registration exposed to administrators.
/// </summary>
public sealed record PluginAdminHookDto(
    string Name,
    int Priority,
    int TimeoutMs,
    string FailPolicy,
    string ExecutionMode,
    string Scope,
    bool Idempotent);

/// <summary>
/// Defines one requested plugin capability and its grant decision.
/// </summary>
public sealed record PluginAdminCapabilityDto(
    string Name,
    string Risk,
    bool Granted,
    bool RequiresAdministratorConfirmation,
    string Reason);

/// <summary>
/// Defines the current versioned plugin configuration.
/// </summary>
public sealed record PluginAdminConfigDto(
    long Version,
    System.Text.Json.JsonElement Schema,
    System.Text.Json.JsonElement Value,
    DateTimeOffset UpdatedAtUtc,
    string ReloadState);

/// <summary>
/// Defines one plugin hook execution measurement.
/// </summary>
public sealed record PluginAdminExecutionMetricDto(
    string PluginId,
    string PluginVersion,
    string Runtime,
    string HookName,
    double DurationMilliseconds,
    bool Success,
    string? ErrorCode,
    bool Timeout,
    long MemoryUsedBytes,
    long MemoryBudgetBytes,
    string NodeId,
    string TraceId,
    string FailPolicy,
    string Scope,
    DateTimeOffset CreatedAtUtc);

/// <summary>
/// Defines aggregate plugin execution counters and latency.
/// </summary>
public sealed record PluginAdminMetricSummaryDto(
    long ExecutionCount,
    long SuccessCount,
    long ErrorCount,
    long TimeoutCount,
    long PermissionDeniedCount,
    long QuarantineCount,
    long RuntimeLoadCount,
    long RuntimeLoadFailureCount,
    double AverageDurationMilliseconds,
    double MaximumDurationMilliseconds);

/// <summary>
/// Defines one sanitized plugin runtime log entry.
/// </summary>
public sealed record PluginAdminLogDto(
    string PluginId,
    string Runtime,
    string HookName,
    string NodeId,
    string TraceId,
    string Level,
    string Message,
    DateTimeOffset CreatedAtUtc);

/// <summary>
/// Defines one sanitized plugin runtime error entry.
/// </summary>
public sealed record PluginAdminErrorDto(
    string PluginId,
    string Runtime,
    string HookName,
    string NodeId,
    string TraceId,
    string Code,
    DateTimeOffset CreatedAtUtc);

/// <summary>
/// Defines one cluster node's observed plugin runtime state.
/// </summary>
public sealed record PluginAdminNodeStateDto(
    string NodeId,
    string MemberStatus,
    string RuntimeState,
    bool Loaded,
    IReadOnlyList<string> RegisteredHooks,
    string? LastErrorCode,
    DateTimeOffset? ObservedAtUtc);

/// <summary>
/// Defines the complete administrator-facing plugin detail projection.
/// </summary>
public sealed record PluginAdminDetailDto(
    PluginAdminSummaryDto Summary,
    PluginAdminManifestSummaryDto Manifest,
    IReadOnlyList<PluginAdminCapabilityDto> Permissions,
    PluginAdminConfigDto Config,
    PluginAdminMetricSummaryDto Metrics,
    IReadOnlyList<PluginAdminExecutionMetricDto> RecentExecutions,
    IReadOnlyList<PluginAdminLogDto> RecentLogs,
    IReadOnlyList<PluginAdminErrorDto> RecentErrors,
    IReadOnlyList<PluginAdminNodeStateDto> Nodes);
