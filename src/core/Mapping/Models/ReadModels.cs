using FsusBlog.Contracts.Articles;
using FsusBlog.Shared.Contracts.Models;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Core.Mapping.Models;

public readonly record struct CorePageResult<T>(IReadOnlyList<T> Items, int Total, string? NextCursor = null, bool HasMore = false);

public readonly record struct CoreCursorResult<T>(IReadOnlyList<T> Data, long? NextCursor, bool HasMore);

public readonly record struct ArticleCategoryCoreModel(int Id, string Name);

public readonly record struct TagCoreModel(int Id, string Name);

public readonly record struct TaxonomyMetadataMutationRequestCoreModel(string Name, string? Description);

public readonly record struct TaxonomyExactMetadataCoreModel(int Id, string Name, string? Description);

public readonly record struct ArticleRightsCoreModel(
    long SnapshotId,
    long ArticleRevisionId,
    int RevisionNo,
    bool Enabled,
    string LicenseType,
    string? CopyrightHolder,
    int? CopyrightYear,
    string? RightsStatement,
    string? AttributionTemplate,
    string CopyPolicy,
    int MaxExcerptChars,
    bool AllowCodeCopy,
    bool ShowPublicBadge,
    bool ProofBindingEnabled,
    string? CanonicalUrl,
    string PolicyHash,
    string ContentCanonicalHash,
    string? ProofUrl,
    string? ProofStatus);

public readonly record struct ArticleListCoreModel(
    ArticleListItemPod Pod,
    int Id,
    string Title,
    string? Summary,
    string? CoverImageUrl,
    string? Snippet,
    int Views,
    DateTime CreateTime,
    ArticleCategoryCoreModel Category,
    IReadOnlyList<TagCoreModel> Tags,
    bool? IsDeleted,
    int Status = 2,
    DateTime? ScheduledPublishAt = null,
    DateTime? PublishedAt = null,
    long CurrentRevisionId = 0,
    int RevisionNo = 0,
    long? CurrentPublicationId = null,
    int? PublicationNo = null);

public readonly record struct ArticleDetailCoreModel(
    ArticleDetailPod Pod,
    int Id,
    string Title,
    string Content,
    string? Summary,
    string? CoverImageUrl,
    int Views,
    int WordCount,
    int EstimatedReadingMinutes,
    bool ShowReadingNotice,
    DateTime CreateTime,
    ArticleCategoryCoreModel Category,
    IReadOnlyList<TagCoreModel> Tags,
    int CategoryId,
    bool IsDeleted,
    int Status = 2,
    DateTime? ScheduledPublishAt = null,
    DateTime? PublishedAt = null,
    DateTime? UpdatedAt = null,
    ArticleRightsCoreModel Rights = default,
    long CurrentRevisionId = 0,
    int RevisionNo = 0,
    long? CurrentPublicationId = null,
    int? PublicationNo = null);

public readonly record struct PopularArticleCoreModel(PopularArticlePod Pod, int Id, string Title, int Views);

public readonly record struct FeaturedArticleCoreModel(
    int Id,
    string Title,
    string CoverImageUrl,
    int Views,
    DateTime CreateTime,
    ArticleCategoryCoreModel Category);

public readonly record struct CommentQueryCoreModel(
    CommentItemPod Pod,
    long Id,
    string Content,
    DateTime CreateTime,
    FsusBlog.Shared.Contracts.Outputs.CommentAuthorViewDto Author);

public readonly record struct UserCommentCoreModel(
    UserCommentPod Pod,
    long Id,
    string Content,
    DateTime CreateTime,
    int ArticleId,
    string ArticleTitle,
    long? RootId,
    FsusBlog.Shared.Contracts.Outputs.CommentAuthorViewDto Author,
    FsusBlog.Shared.Contracts.Outputs.CommentAuthorViewDto? ReplyToAuthor,
    int ModerationStatus,
    string ModerationStatusLabel,
    string VisibilityState,
    string VisibilityReasonCode,
    bool IsPubliclyVisible);

public readonly record struct IdentityAccountSnapshotCoreModel(
    int AccountId,
    string? PublicHandle,
    bool PasskeyEnabled,
    bool RecoveryEnabled,
    bool? TotpStepUpEnabled,
    string? AnonymousCredentialStatus,
    string? AnonymousCredentialLevel,
    string IdentityKind = "anonymous_account",
    int Status = 0,
    string? BanReason = null,
    DateTime? DeletedAt = null);

public readonly record struct CommentPolicySnapshotCoreModel(
    bool AnonymousCommentsEnabled,
    bool PublicCommentsEnabled,
    bool ZkAnonymousEnabled,
    string DefaultAuthorMode,
    IReadOnlyList<string> SupportedDisplayLanguages,
    string SnapshotHash = "",
    int CommentMaxChars = 1000,
    int CommentMaxUtf8Bytes = 4096,
    bool ZkProdEnabled = false,
    bool ZkProdNativeVerifierConfigured = false,
    bool ZkProdTrustedSetupVerified = false,
    bool ZkProdCredentialRequired = true,
    bool ZkProdCredentialRootReady = false,
    string ZkProdUnavailableReason = "disabled");

public readonly record struct CommentPolicyUpdateRequestCoreModel(
    bool? AnonymousCommentsEnabled,
    bool? PublicCommentsEnabled,
    bool? ZkAnonymousEnabled,
    string? DefaultAuthorMode,
    IReadOnlyList<string>? SupportedDisplayLanguages,
    int? CommentMaxChars = null,
    int? CommentMaxUtf8Bytes = null);

public readonly record struct BlindCredentialIssuerMetadataCoreModel(
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

public readonly record struct BlindCredentialIssueRequestCoreModel(
    long CredentialEpoch,
    uint CircuitNumericId,
    ushort PublicInputLayoutVersion,
    string CircuitId,
    string CredentialLevel,
    string SchemeId,
    string IssuerPublicKeyId,
    byte[] BlindedMessage);

public readonly record struct BlindCredentialIssueResponseCoreModel(
    long CredentialEpoch,
    long ExpiresAtUnixMs,
    uint CircuitNumericId,
    ushort PublicInputLayoutVersion,
    string CircuitId,
    string CredentialLevel,
    string SchemeId,
    string IssuerPublicKeyId,
    byte[] BlindSignature);

public readonly record struct AnonymousCredentialRootSnapshotCoreModel(
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

public readonly record struct AnonymousCredentialRevocationArtifactCoreModel(
    long CredentialEpoch,
    long Version,
    long BaseVersion,
    long ExpiresAtUnixMs,
    byte Kind,
    ushort PathDepth,
    string AlgorithmId,
    string IssuerPublicKeyHash,
    byte[] RevocationRoot,
    byte[] ContentHash,
    byte[] Signature,
    byte[] EntryHashes);

public readonly record struct AnonymousCommentTicketRequestCoreModel(
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

public readonly record struct AnonymousCommentTicketResponseCoreModel(
    long TicketExpiresAtUnixMs,
    string RateClass,
    bool RequiresModeration,
    byte[] Ticket,
    byte[] ModerationSubjectHash);

public readonly record struct AnonymousCommentCreateRequestCoreModel(
    int ArticleId,
    string Content,
    string? ParentId,
    string? RootId,
    string? ReplyToCommentId,
    string AnonymousScope,
    string DisplayLanguage,
    byte[] Ticket);

public readonly record struct AnonymousPrivacyStateSnapshotCoreModel(
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

public readonly record struct CommentAuthorViewCoreModel(
    string Mode,
    string DisplayName,
    string DisplayLanguage,
    string? Badge,
    string? ScopeLabel);

public readonly record struct AdminChangeUserStatusRequestCoreModel(int AccountId, int Status, string? Reason);

public readonly record struct AuthAnonymousBootstrapRequestCoreModel(string? PublicHandle, bool AcceptedGuidelines);

public readonly record struct AuthDeleteAccountRequestCoreModel(string ConfirmText);

public readonly record struct MfaPasswordProofRequestCoreModel(string Password, string? Code, string? RecoveryCode);

public readonly record struct MfaChallengeVerifyRequestCoreModel(string ChallengeToken, string? Action, string? Code, string? RecoveryCode);

public readonly record struct RecoveryKeyCreateResponseCoreModel(string RecoveryKey, int KeyVersion, DateTime CreatedAt);

public readonly record struct RecoveryKeyVerifyRequestCoreModel(string RecoveryKey, bool RevokeSessions, bool RevokePasskeys);

public readonly record struct RecoveryKeyVerifyResponseCoreModel(string RecoverySessionToken, DateTime ExpiresAt);

public readonly record struct ConversationCreateRequestCoreModel(string Subject, string Body);

public readonly record struct ConversationReadRequestCoreModel(long ReadThroughMessageId);

public readonly record struct AccountConversationReplyRequestCoreModel(long ReadThroughMessageId, string Body);

public readonly record struct ConversationStatusRequestCoreModel(ConversationStatusValue Status, string Reason);

public readonly record struct SystemMessageRequestCoreModel(long? TargetAccountId, string Subject, string Body);

public sealed record class PasskeyRegisterCompleteCoreModel
{
    public string SessionKey { get; init; } = string.Empty;
    public string Id { get; init; } = string.Empty;
    public byte[] RawId { get; init; } = [];
    public byte[] ClientDataBytes { get; init; } = [];
    public byte[] AttestationObject { get; init; } = [];
    public IReadOnlyList<int> Transports { get; init; } = [];
    public string? FriendlyName
    {
        get; init;
    }
    public string? MfaProofToken
    {
        get; init;
    }
}

public readonly record struct PasskeyCredentialDescriptorCoreModel(
    int Type,
    byte[] Id,
    IReadOnlyList<int> Transports);

public readonly record struct PasskeyPublicKeyCredentialParamCoreModel(int Type, int Alg);

public sealed record class PasskeyRegisterBeginCoreModel
{
    public string SessionKey { get; init; } = string.Empty;
    public ulong Timeout
    {
        get; init;
    }
    public int Attestation
    {
        get; init;
    }
    public int ResidentKey
    {
        get; init;
    }
    public int UserVerification
    {
        get; init;
    }
    public int? AuthenticatorAttachment
    {
        get; init;
    }
    public bool RequireResidentKey
    {
        get; init;
    }
    public string RpId { get; init; } = string.Empty;
    public string RpName { get; init; } = string.Empty;
    public string AccountName { get; init; } = string.Empty;
    public string AccountDisplayName { get; init; } = string.Empty;
    public byte[] AccountHandle { get; init; } = [];
    public byte[] Challenge { get; init; } = [];
    public IReadOnlyList<PasskeyPublicKeyCredentialParamCoreModel> PubKeyCredParams { get; init; } = [];
    public IReadOnlyList<PasskeyCredentialDescriptorCoreModel> ExcludeCredentials { get; init; } = [];
}

public sealed record class PasskeyLoginBeginCoreModel
{
    public string ChallengeToken { get; init; } = string.Empty;
    public ulong Timeout
    {
        get; init;
    }
    public string RpId { get; init; } = string.Empty;
    public int? UserVerification
    {
        get; init;
    }
    public byte[] Challenge { get; init; } = [];
    public IReadOnlyList<PasskeyCredentialDescriptorCoreModel> AllowCredentials { get; init; } = [];
}

public sealed record class PasskeyLoginCompleteCoreModel
{
    public string ChallengeToken { get; init; } = string.Empty;
    public string Id { get; init; } = string.Empty;
    public byte[] RawId { get; init; } = [];
    public byte[] ClientDataBytes { get; init; } = [];
    public byte[] AuthenticatorData { get; init; } = [];
    public byte[] Signature { get; init; } = [];
    public byte[]? UserHandle
    {
        get; init;
    }
    public bool RememberMe
    {
        get; init;
    }
}

public enum ArticleRightsMutationMode
{
    Preserve = 0,
    Replace = 1,
    Reset = 2
}

public readonly record struct ArticleWriteRequestCoreModel(
    string Title,
    string Content,
    string? Summary,
    string? CoverImageUrl,
    int CategoryId,
    IReadOnlyList<int> TagIds,
    int Status = 2,
    DateTime? ScheduledPublishAt = null,
    ArticleRightsRequestCoreModel? Rights = null,
    ArticleRightsMutationMode RightsMutation = ArticleRightsMutationMode.Preserve,
    long? BaseRevisionId = null);

public readonly record struct RecentCommentCoreModel(
    RecentCommentPod Pod,
    string AuthorDisplayName,
    string AuthorMode,
    string? AuthorBadge,
    string? AuthorScopeLabel,
    string Content,
    DateTime CreateTime);

public readonly record struct RegionDistributionCoreModel(RegionDistributionPod Pod, string Region, int Count);

public readonly record struct SiteStatsCoreModel(
    SiteStatsPod Pod,
    int TotalArticles,
    int TotalComments,
    int TrashCount,
    int TotalReads,
    int HumanVerifiedReads,
    int UniqueViewerKeyEstimate,
    int ArticleReads,
    int SiteReads,
    IReadOnlyList<PopularArticleCoreModel> PopularArticles,
    IReadOnlyList<RecentCommentCoreModel> RecentComments,
    IReadOnlyList<RegionDistributionCoreModel> RegionDistributions);
