using FsusBlog.Shared.Contracts.Models;

namespace FsusBlog.Core.Mapping.Models;

public readonly record struct CorePageResult<T>(IReadOnlyList<T> Items, int Total, string? NextCursor = null, bool HasMore = false);

public readonly record struct CoreCursorResult<T>(IReadOnlyList<T> Data, long? NextCursor, bool HasMore);

public readonly record struct ArticleCategoryCoreModel(int Id, string Name);

public readonly record struct TagCoreModel(int Id, string Name);

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
    DateTime? PublishedAt = null);

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
    DateTime? PublishedAt = null);

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
    IReadOnlyList<string>? SupportedDisplayLanguages);

public readonly record struct CommentCreateV2RequestCoreModel(
    int ArticleId,
    string Content,
    string? ParentId,
    string? RootId,
    string? ReplyToCommentId,
    int? ReplyToUserId,
    string AuthorMode,
    bool PublicSendExplicitlySelected,
    string? AnonymousScope,
    string? DisplayLanguage,
    string? ProofToken,
    byte[] ZkProof);

public readonly record struct AnonymousCredentialIssueRequestCoreModel(
    long CredentialEpoch,
    uint CircuitNumericId,
    ushort PublicInputLayoutVersion,
    string CircuitId,
    string CredentialLevel,
    byte[] CredentialRequest,
    byte[] ClientNonce);

public readonly record struct AnonymousCredentialIssueResponseCoreModel(
    long CredentialEpoch,
    long ExpiresAtUnixMs,
    uint CircuitNumericId,
    ushort PublicInputLayoutVersion,
    string CircuitId,
    string CredentialLevel,
    string IssuerPublicKeyId,
    byte[] IssuerSignature);

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

public readonly record struct AnonymousCredentialRevocationWitnessRequestCoreModel(
    long CredentialEpoch,
    uint CircuitNumericId,
    ushort PublicInputLayoutVersion,
    string CircuitId,
    string IssuerPublicKeyHash,
    byte[] RevocationRoot,
    byte[] RevocationHandleHash);

public readonly record struct AnonymousCredentialRevocationWitnessResponseCoreModel(
    long CredentialEpoch,
    string AlgorithmId,
    ushort PathDepth,
    byte[] RevocationRoot,
    string IssuerPublicKeyHash,
    byte[] RevocationHandleHash,
    byte[] LeafKey,
    byte[] WitnessHash,
    byte[] SiblingHashes);

public readonly record struct AnonymousCommentTicketRequestCoreModel(
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

public readonly record struct AnonymousCommentTicketResponseCoreModel(
    long CredentialEpoch,
    long TicketExpiresAtUnixMs,
    string CredentialLevel,
    byte[] Ticket,
    byte[] ModerationSubjectHash);

public readonly record struct AnonymousCommentCreateRequestCoreModel(
    int ArticleId,
    string Content,
    string? ParentId,
    string? RootId,
    string? ReplyToCommentId,
    long CredentialEpoch,
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
    string? ScopeLabel,
    string? CredentialLevel);

public readonly record struct AdminChangeUserStatusRequestCoreModel(int AccountId, int Status, string? Reason);

public readonly record struct AuthAnonymousBootstrapRequestCoreModel(string? PublicHandle, bool AcceptedGuidelines);

public readonly record struct AuthDeleteAccountRequestCoreModel(string ConfirmText);

public readonly record struct MfaPasswordProofRequestCoreModel(string Password, string? Code, string? RecoveryCode);

public readonly record struct MfaChallengeVerifyRequestCoreModel(string ChallengeToken, string? Action, string? Code, string? RecoveryCode);

public readonly record struct RecoveryKeyCreateResponseCoreModel(string RecoveryKey, int KeyVersion, DateTime CreatedAt);

public readonly record struct RecoveryKeyVerifyRequestCoreModel(string RecoveryKey, bool RevokeSessions, bool RevokePasskeys);

public readonly record struct RecoveryKeyVerifyResponseCoreModel(string RecoverySessionToken, DateTime ExpiresAt);

public readonly record struct ConversationCreateRequestCoreModel(string Subject, string Body);

public readonly record struct SystemMessageRequestCoreModel(long? TargetAccountId, string Subject, string Body);

public sealed record class PasskeyRegisterCompleteCoreModel
{
    public string SessionKey { get; init; } = string.Empty;
    public string Id { get; init; } = string.Empty;
    public byte[] RawId { get; init; } = [];
    public byte[] ClientDataBytes { get; init; } = [];
    public byte[] AttestationObject { get; init; } = [];
    public IReadOnlyList<int> Transports { get; init; } = [];
    public string? FriendlyName { get; init; }
    public string? MfaProofToken { get; init; }
}

public readonly record struct PasskeyCredentialDescriptorCoreModel(
    int Type,
    byte[] Id,
    IReadOnlyList<int> Transports);

public readonly record struct PasskeyPublicKeyCredentialParamCoreModel(int Type, int Alg);

public sealed record class PasskeyRegisterBeginCoreModel
{
    public string SessionKey { get; init; } = string.Empty;
    public ulong Timeout { get; init; }
    public int Attestation { get; init; }
    public int ResidentKey { get; init; }
    public int UserVerification { get; init; }
    public int? AuthenticatorAttachment { get; init; }
    public bool RequireResidentKey { get; init; }
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
    public ulong Timeout { get; init; }
    public string RpId { get; init; } = string.Empty;
    public int? UserVerification { get; init; }
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
    public byte[]? UserHandle { get; init; }
    public bool RememberMe { get; init; }
}

public readonly record struct ArticleRightsRequestCoreModel(
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
    bool ProofBindingEnabled);

public readonly record struct ArticleWriteRequestCoreModel(
    string Title,
    string Content,
    string? Summary,
    string? CoverImageUrl,
    int CategoryId,
    IReadOnlyList<int> TagIds,
    int Status = 2,
    DateTime? ScheduledPublishAt = null,
    ArticleRightsRequestCoreModel? Rights = null);

public readonly record struct RecentCommentCoreModel(
    RecentCommentPod Pod,
    string AuthorDisplayName,
    string AuthorMode,
    string? AuthorBadge,
    string? AuthorScopeLabel,
    string? CredentialLevel,
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
