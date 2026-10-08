import type { SupportedLocale } from '@/locales/localeCatalog';

export type { WritingAidPreferenceValues, WritingAidPreferenceOwner, WritingAidPreferenceSnapshot, WritingAidPreferenceUpdate, WritingAidPreferenceReceipt } from '@/codecs/binary/writingAidPreferenceWire.generated';

export const ArticlePublishStatus = {
    Draft: 0,
    Scheduled: 1,
    Published: 2,
    Archived: 3,
    Deleted: 4
} as const;

export type ArticlePublishStatus = typeof ArticlePublishStatus[keyof typeof ArticlePublishStatus];

export interface ArticleTag {
    id: number;
    name: string;
}

export interface PopularArticleSummaryResponse {
    id: number;
    title: string;
    views: number;
}

export interface FeaturedArticleItem {
    id: number;
    title: string;
    coverImageUrl: string;
    views: number;
    createTime: string;
    category: {
        id: number;
        name: string;
    };
}

export interface ArticleListItemResponse {
    id: number;
    title: string;
    summary: string;
    coverImageUrl?: string;
    views: number;
    createTime: string;
    category: {
        id: number;
        name: string;
    };
    tags: ArticleTag[];
    isDeleted?: boolean;
    status?: ArticlePublishStatus;
    scheduledPublishAt?: string | null;
    publishedAt?: string | null;
    currentRevisionId?: string;
    revisionNo?: number;
    currentPublicationId?: string | null;
    publicationNo?: number | null;
}

export interface ArticleRightsResponse {
    snapshotId: string;
    articleRevisionId: string;
    revisionNo: number;
    enabled: boolean;
    licenseType: string;
    copyrightHolder: string | null;
    copyrightYear: number | null;
    rightsStatement: string | null;
    attributionTemplate: string | null;
    copyPolicy: string;
    maxExcerptChars: number;
    allowCodeCopy: boolean;
    showPublicBadge: boolean;
    proofBindingEnabled: boolean;
    canonicalUrl: string | null;
    policyHash: string;
    contentCanonicalHash: string;
    proofUrl: string | null;
    proofStatus: string | null;
}

export interface ArticleDetailResponse {
    id: number;
    title: string;
    content: string;
    summary: string;
    coverImageUrl?: string;
    views: number;
    createTime: string;
    category: {
        id: number;
        name: string;
    };
    tags: ArticleTag[];
    isDeleted?: boolean;
    status?: ArticlePublishStatus;
    scheduledPublishAt?: string | null;
    publishedAt?: string | null;
    updatedAt?: string | null;
    currentRevisionId?: string;
    revisionNo?: number;
    currentPublicationId?: string | null;
    publicationNo?: number | null;
    rights: ArticleRightsResponse;
}

export interface RelatedReadingItemResponse {
    id: number;
    title: string;
    summary?: string | null;
    createTime: string;
    reason: string;
}

export interface RelatedReadingResponse {
    related: RelatedReadingItemResponse[];
    previous?: RelatedReadingItemResponse | null;
    next?: RelatedReadingItemResponse | null;
}

export interface BinaryPageResponse<T> {
    items: T[];
    total: number;
    nextCursor?: string | null;
    hasMore?: boolean;
}

export interface ArticleRightsRequest {
    mode?: 'site' | 'custom';
    enabled?: boolean;
    licenseType?: string | null;
    copyrightHolder?: string | null;
    copyrightYear?: number | null;
    rightsStatement?: string | null;
    attributionTemplate?: string | null;
    copyPolicy?: string | null;
    maxExcerptChars?: number;
    allowCodeCopy?: boolean;
    showPublicBadge?: boolean;
    proofBindingEnabled?: boolean;
}

export interface ArticleWriteRequest {
    title: string;
    content: string;
    summary: string;
    coverImageUrl?: string;
    categoryId: number | undefined;
    tagIds: number[];
    status?: ArticlePublishStatus;
    scheduledPublishAt?: string | null;
    rights?: ArticleRightsRequest | null;
    resetRights?: boolean;
    baseRevisionId?: string | number | null;
}

export interface AuthAccountIdentitySnapshot {
    accountId: number;
    identityKind: string;
}

export interface CurrentUserSnapshot {
    accountId: number;
    identityKind: string;
    publicHandle: string | null;
    passkeyEnabled: boolean;
    recoveryEnabled: boolean;
    totpStepUpEnabled: boolean | null;
    anonymousCredentialStatus: string | null;
    anonymousCredentialLevel: string | null;
    status: number;
    banReason: string | null;
    deletedAt: string | null;
    accessExpiresAtUtc: string;
}

export type LocalePreferenceMode = 'auto' | 'fixed';

export interface UserLocalePreference {
    mode: LocalePreferenceMode;
    fixedLocale: SupportedLocale | null;
    revision: number;
    updatedAt: string;
}

export interface UserLocalePreferenceUpdate {
    mode: LocalePreferenceMode;
    fixedLocale: SupportedLocale | null;
    expectedRevision: number;
}

export interface AuthLoginFlow {
    accountId: number;
    identityKind: string;
    authPhase: 'authenticated' | 'mfa_required' | 'enrollment_required';
    mfaMode: 'risk' | 'standard' | null;
    challengeToken: string | null;
}

export interface MfaSetupStart {
    enabled: boolean;
    secret: string;
    otpAuthUrl: string;
    issuer: string;
    account: string;
}

export interface MfaSetupVerify {
    enabled: boolean;
    recoveryCodes: string[];
}

export interface MfaProfile {
    enabled: boolean;
    verifiedAt: string | null;
}

export interface MfaChallengeResult {
    verified: boolean;
    action: string;
    proofToken: string | null;
    user: AuthAccountIdentitySnapshot | null;
}

export interface RecoveryKeyCreateResponse {
    keyVersion: number;
    createdAt: string;
    recoveryKey: string;
}

export interface RecoveryKeyVerifyRequest {
    recoveryKey: string;
    revokeSessions?: boolean;
    revokePasskeys?: boolean;
}

export interface RecoveryKeyVerifyResponse {
    expiresAt: string;
    recoverySessionToken: string;
}

export interface UserSessionSummary {
    sessionId: string;
    deviceLabel: string;
    createdAt: string;
    lastSeenAt: string | null;
    authenticationMethod: 'passkey' | 'recovery_key' | 'enrollment' | 'other';
    authenticationStrength: 'webauthn_uv' | 'mfa' | 'recovery' | 'legacy_verified' | 'legacy_unverified';
    passkeyFriendlyName: string | null;
    durationPolicy: 'browser_session' | 'persistent_30d';
    isCurrent: boolean;
}

export interface PasskeyCredentialSummary {
    id: number;
    deviceFriendlyName: string | null;
    createdAt: string;
    lastUsedAt: string | null;
    aaGuid: string;
    backupEligible: boolean;
    backupState: boolean;
}

export interface PasskeySignalState {
    revision: number;
    rpId: string;
    userId: string;
    name: string;
    displayName: string;
    allAcceptedCredentialIds: string[];
}

export interface PasskeyRegisterBeginResponse {
    sessionKey: string;
    options: Record<string, unknown>;
}

export interface PasskeyLoginBeginResponse {
    challengeToken: string;
    options: Record<string, unknown>;
}

export type CommentAuthorMode = 'public' | 'zk_anonymous';
export type CommentAuthorViewMode = CommentAuthorMode | 'legacy_server_visible_pseudonymous';
export type CommentDisplayLanguage = 'zh-CN' | 'en';

export type {
    CommentPolicyContractVersion,
    CommentPolicyReadiness,
    CommentPolicySnapshot,
    ZkProdUnavailableReason
} from './commentPolicy';

export interface CommentAuthorView {
    mode: CommentAuthorViewMode;
    displayName: string;
    displayLanguage: CommentDisplayLanguage;
    badge?: string | null;
    scopeLabel?: string | null;
}

export interface CommentCreateV2Dto {
    clientMutationId?: string;
    articleId: number;
    content: string;
    parentId?: string | null;
    rootId?: string | null;
    replyToCommentId?: string | null;
    /** @deprecated Anonymous mode must leave this unset; the POD encoder writes the compatibility placeholder. */
    replyToUserId?: number | null;
    authorMode: 'public';
    publicSendExplicitlySelected: boolean;
    displayLanguage: CommentDisplayLanguage;
    powSalt?: string;
    powSignature?: string;
    powTimestamp?: number;
    difficulty?: number;
    powNonce?: string;
    browserFp?: string;
}

export interface CommentCreateResult {
    commentId: string;
    rootId: string;
    parentId: string | null;
    createdAtUtc: string;
    moderationStatus: number;
    visibilityState: 'pending' | 'public' | 'hidden' | 'rejected';
    isPubliclyVisible: boolean;
    idempotencyReplay: boolean;
}

export interface AnonymousCommentCreateResult extends CommentCreateResult {
    managementSecret: string;
}

export interface CommentManagementChallengeResult {
    issued: boolean;
    challenge: string;
    expiresAtUtc: string;
    failureCode?: string | null;
    currentVersion: number;
}

export interface CommentAuthorMutationResult {
    success: boolean;
    code: string;
    currentVersion: number;
    moderationStatus: number;
    editedAtUtc?: string | null;
}

export interface CommentAuthorStatusResult {
    found: boolean;
    currentVersion: number;
    moderationStatus: number;
    moderationReason?: string | null;
    isDeleted: boolean;
    editedAtUtc?: string | null;
}

export interface CommentRevisionResult {
    version: number;
    content: string;
    contentSha256: string;
    operation: 'created' | 'edited' | 'deleted';
    createdAtUtc: string;
    actorMode: string;
}

export interface AnonymousCommentSubmitDto {
    articleId: number;
    content: string;
    parentId?: string | null;
    rootId?: string | null;
    replyToCommentId?: string | null;
    anonymousScope: string;
    displayLanguage: string;
}

export interface AnonymousCommentSubmitTicket {
    ticket: Uint8Array | number[];
}

export type PublicCommentCreateInput = Omit<CommentCreateV2Dto, 'authorMode' | 'publicSendExplicitlySelected'> & {
    authorMode?: CommentAuthorMode | null;
    publicSendExplicitlySelected?: boolean | null;
};

export interface BlindCredentialIssuerMetadata {
    credentialEpoch: number;
    expiresAtUnixMs: number;
    circuitNumericId: number;
    publicInputLayoutVersion: number;
    circuitId: string;
    credentialLevel: string;
    schemeId: string;
    issuerPublicKeyId: string;
    issuerPublicKeyHash: string;
    modulusBytes: number;
    subjectPublicKeyInfo: Uint8Array;
}

export interface BlindCredentialIssueResponse {
    credentialEpoch: number;
    expiresAtUnixMs: number;
    circuitNumericId: number;
    publicInputLayoutVersion: number;
    circuitId: string;
    credentialLevel: string;
    schemeId: string;
    issuerPublicKeyId: string;
    blindSignature: Uint8Array;
}

export interface BlindCredentialIssueRequestDto {
    credentialEpoch: number;
    circuitNumericId: number;
    publicInputLayoutVersion: number;
    circuitId: string;
    credentialLevel: string;
    schemeId: string;
    issuerPublicKeyId: string;
    blindedMessage: Uint8Array;
}

export interface AnonymousCredentialRootSnapshot {
    credentialEpoch: number;
    rootExpiresAtUnixMs: number;
    rootGraceExpiresAtUnixMs: number;
    circuitNumericId: number;
    publicInputLayoutVersion: number;
    zkAnonymousEnabled: boolean;
    verifierConfigured: boolean;
    circuitId: string;
    verifyingKeyHash: string;
    issuerPublicKeyHash: string;
    credentialRoot: Uint8Array;
    revocationRoot: Uint8Array;
    circuitMetadata: Uint8Array;
}

export interface AnonymousCredentialRevocationArtifact {
    credentialEpoch: number;
    version: number;
    baseVersion: number;
    expiresAtUnixMs: number;
    kind: 1 | 2;
    algorithmId: string;
    pathDepth: number;
    issuerPublicKeyHash: string;
    revocationRoot: Uint8Array;
    contentHash: Uint8Array;
    signature: Uint8Array;
    entryHashes: Uint8Array;
}

export interface AnonymousCommentTicketResponse {
    ticketExpiresAtUnixMs: number;
    rateClass: 'common' | 'unknown';
    requiresModeration: boolean;
    ticket: Uint8Array;
    moderationSubjectHash: Uint8Array;
}

export interface AnonymousCommentTicketRequestDto {
    articleId: number;
    parentId?: string | null;
    rootId?: string | null;
    replyToCommentId?: string | null;
    circuitNumericId: number;
    publicInputLayoutVersion: number;
    actionContext: string;
    anonymousScope: string;
    circuitId: string;
    verifyingKeyHash: string;
    nullifierHash: Uint8Array | number[];
    credentialRoot: Uint8Array | number[];
    revocationRoot: Uint8Array | number[];
    isEligible: boolean;
    mayComment: boolean;
    rateClass: 'common' | 'unknown';
    requiresModeration: boolean;
    zkProof: Uint8Array | number[];
    publicInputs: Uint8Array | number[];
}

export interface AnonymousCommentCreateRequestDto {
    articleId: number;
    content: string;
    parentId?: string | null;
    rootId?: string | null;
    replyToCommentId?: string | null;
    anonymousScope: string;
    displayLanguage: string;
    ticket: Uint8Array | number[];
}

export interface AnonymousPrivacyStateSnapshot {
    credentialEpoch: number;
    rootExpiresAtUnixMs: number;
    ticketExpiresAtUnixMs: number;
    circuitNumericId: number;
    publicInputLayoutVersion: number;
    hasActiveCredential: boolean;
    canIssueCredential: boolean;
    canSubmitAnonymousComment: boolean;
    circuitId: string;
    verifyingKeyHash: string;
    credentialStatus: string;
    credentialLevel: string;
}

export interface CursorResponse<T> {
    data: T[];
    /** Snowflake cursors stay strings to avoid numeric precision loss. */
    nextCursor: string | null;
    hasMore: boolean;
}

export interface CommentReplyItem {
    id: string;
    content: string;
    createTime: string;
    author: CommentAuthorView;
    replyToAuthor?: CommentAuthorView | null;
    parentId?: string | null;
    rootId: string;
    replyToCommentId?: string | null;
    depth: number;
    isDeleted: boolean;
    isEdited: boolean;
}

export interface CommentThreadItem {
    id: string;
    content: string;
    createTime: string;
    author: CommentAuthorView;
    rootId: string;
    isDeleted: boolean;
    isEdited: boolean;
    replyCount: number;
    hasMoreReplies: boolean;
    repliesPreview: CommentReplyPreviewItem[];
}

export interface CommentReplyPreviewItem {
    id: string;
    content: string;
    createTime: string;
    author: CommentAuthorView;
    replyToAuthor?: CommentAuthorView | null;
    isDeleted: boolean;
    isEdited: boolean;
}

export interface CommentTreeNode {
    id: string;
    content: string;
    createTime: string;
    author: CommentAuthorView;
    replyToAuthor?: CommentAuthorView | null;
    parentId?: string | null;
    rootId: string;
    replyToCommentId?: string | null;
    depth: number;
    isDeleted: boolean;
    isEdited: boolean;
    childCount: number;
    hasMoreChildren: boolean;
}

export interface CommentTreeRoot {
    node: CommentTreeNode;
    childrenPreview: CommentTreeNode[];
}

export type CommentPermalinkStatus = 'found' | 'unavailable';

export interface CommentPermalinkContext {
    status: CommentPermalinkStatus;
    targetId: string | null;
    rootId: string | null;
    ancestors: CommentTreeNode[];
    target: CommentTreeNode | null;
    siblings: CommentTreeNode[];
    hasPreviousSiblings: boolean;
    hasNextSiblings: boolean;
}

export interface UserCommentResponse {
    id: string;
    content: string;
    createTime: string;
    articleId: number;
    articleTitle: string;
    rootId?: string | null;
    author: CommentAuthorView;
    replyToAuthor?: CommentAuthorView | null;
    moderationStatus: number;
    moderationStatusLabel: string;
    visibilityState: string;
    visibilityReasonCode: string;
    isPubliclyVisible: boolean;
}

export interface ConversationMessagePreviewResponse {
    senderType: 0 | 1 | 2;
    senderName?: string | null;
    bodyPreview: string;
    createdAt: string;
}

export interface ConversationMessageResponse {
    messageId: string;
    conversationId: string;
    idempotencyReplay?: boolean;
    senderType: 0 | 1 | 2;
    senderName?: string | null;
    body: string;
    createdAt: string;
}

export interface ConversationListItemResponse {
    conversationId: string;
    subject: string;
    status: 0 | 1 | 2;
    isSystemSource: boolean;
    canReply: boolean;
    unreadCount: number;
    lastMessageAt: string;
    updatedAt: string;
    lastMessage?: ConversationMessagePreviewResponse | null;
}

export interface AdminConversationListItemResponse extends ConversationListItemResponse {
    counterpartyAccountId: string;
    counterpartyAccountStatus: 0 | 1 | 2 | 3;
}

export interface ConversationDetailResponse {
    conversationId: string;
    idempotencyReplay?: boolean;
    readSnapshotMessageId: string;
    previousCursor?: string | null;
    hasOlder?: boolean;
    subject: string;
    status: 0 | 1 | 2;
    isSystemSource: boolean;
    canReply: boolean;
    unreadCount: number;
    lastMessageAt: string;
    messages: ConversationMessageResponse[];
}

export interface AdminConversationDetailResponse extends ConversationDetailResponse {
    counterpartyAccountId: string;
    counterpartyAccountStatus: 0 | 1 | 2 | 3;
}

export interface InboxConversationUpsertPayload {
    conversation: ConversationListItemResponse;
    totalUnread?: number | null;
    time?: string | null;
}

export interface InboxMessageAppendPayload {
    conversationId: string;
    message: ConversationMessageResponse;
    conversationUnreadCount?: number | null;
    totalUnread?: number | null;
    time?: string | null;
}

export interface InboxReadUpdatedPayload {
    conversationId: string;
    lastReadMessageId?: string | null;
    conversationUnreadCount: number;
    totalUnread?: number | null;
    time?: string | null;
}

export interface InboxConversationStatusChangedPayload {
    conversationId: string;
    status: 0 | 1 | 2;
    time: string;
}

export interface ConversationStatusMutationResultResponse {
    previousStatus: 0 | 1 | 2;
    currentStatus: 0 | 1 | 2;
    outcome: 'changed' | 'no_change';
}

export interface RecentCommentStatItem {
    authorDisplayName: string;
    authorMode: string;
    authorBadge: string | null;
    authorScopeLabel: string | null;
    content: string;
    createTime: string;
}

export interface RegionStatItem {
    region: string;
    count: number;
}

export interface StatsSummary {
    totalArticles: number;
    totalComments: number;
    trashCount: number;
    totalReads: number;
    humanVerifiedReads: number;
    uniqueViewerKeyEstimate: number;
    articleReads: number;
    siteReads: number;
}

export interface AdminStatsOverview {
    summary: StatsSummary;
    popularArticles: PopularArticleSummaryResponse[];
}

export interface AdminStatsQuery {
    overview: AdminStatsOverview;
    recentComments: RecentCommentStatItem[];
    regions: RegionStatItem[];
}

export interface TrashClearResponse {
    count: number;
}

export interface SeoConfigPublic {
    title: string;
    description: string;
    keywords: string;
    author: string;
    ogImage: string;
    baseUrl: string;
    faviconSvgUrl: string;
    faviconIcoUrl: string;
    faviconPngUrl: string;
    appleTouchIconUrl: string;
    manifestName: string;
    manifestShortName: string;
    pwaIcon192Url: string;
    pwaIcon512Url: string;
    pwaMaskableIconUrl: string;
    themeColor: string;
    backgroundColor: string;
    siteLogoUrl: string;
    siteLogoDarkUrl: string;
    siteWordmarkUrl: string;
    adminLogoUrl: string;
    adminCollapsedIconUrl: string;
    loginLogoUrl: string;
    loginIconUrl: string;
}

export type SeoConfigAdmin = SeoConfigPublic;

export interface SiteComplianceConfigPublic {
    enabled: boolean;
    regionMode: 'global' | 'mainland-cn';
    copyrightOwner: string;
    copyrightStartYear: number | null;
    copyrightText: string;
    contentLicenseName: string;
    contentLicenseUrl: string;
    icpRecordNumber: string;
    icpRecordUrl: string;
    policeRecordNumber: string;
    policeRecordUrl: string;
    policeBadgeIconUrl: string;
    operatorName: string;
    contactEmail: string;
}

export type SiteComplianceConfigAdmin = SiteComplianceConfigPublic;

export interface PageContentPublic {
    slug: string;
    content: string;
}

export interface PageContentAdmin {
    slug: string;
    content: string;
}

export interface AdminAccountListItem {
    accountId: number;
    identityKind: string;
    publicHandle?: string | null;
    passkeyInitialized: boolean;
    recoveryInitialized: boolean;
    privacyInitializedAt?: string | null;
    anonymousCredentialStatus: string;
    riskFlags: number;
    /** 0: active, 1: banned, 2: deleted. */
    status: number;
    createTime: string;
    deletedAt?: string | null;
}

export interface PageResult<T> {
    total: number;
    items: T[];
}

export interface CategoryItem {
    id: number;
    name: string;
    articleCount: number;
}

export interface TagItem {
    id: number;
    name: string;
    articleCount: number;
}

export interface TaxonomyExactMetadata {
    id: number;
    name: string;
    description: string | null;
}

export type HumanReadScope = 'site' | 'article';

export interface HumanReadChallenge {
    token: string;
    scope: HumanReadScope;
    routeKey: string;
    articleId: number | null;
    minDwellMs: number;
    issuedAt: string;
    expiresAt: string;
}

export interface HumanReadSubmitResult {
    counted: boolean;
    status: string;
}

export interface SiteSubscriptionRequest {
    email: string;
    channel?: string | null;
}

export interface SiteSubscriptionResponse {
    subscribed: boolean;
    unsubscribed: boolean;
    channel: string;
}

export interface SiteSubscriptionRequestConfig {
    signal?: AbortSignal;
}

export const SecurityChallengeKind = {
    Unknown: 0,
    Sha256PowV1: 1,
    Argon2IdPoSpaceV1: 2,
    HumanReadProofV1: 4,
    PasskeyStepUpV1: 5,
    AdminPasskeyStepUpV1: 6,
    RecoveryKeyProofV1: 7,
    AnonymousCredentialProofV1: 8,
    ZkAnonymousCommentProofV1: 9,
    PerceptionLocalizationV2: 11,
    PerceptionMicroInteractionV2: 12,
    PerceptionCharacterV3: 14
} as const;

export type SecurityChallengeKind = typeof SecurityChallengeKind[keyof typeof SecurityChallengeKind];
export type SecurityChallengeDecision = 'unknown' | 'allow' | 'challenge' | 'stepUp' | 'queueForModeration' | 'throttle' | 'block';

export interface SecurityChallengeAssignment {
    challengeId: string;
    traceparent: string;
    tenantId: string;
    kind: SecurityChallengeKind;
    escalationLevel: number;
    action: string;
    routeKey: string;
    subjectHash: string;
    clientIpHash: string;
    deviceFpHash: string;
    issuedAtUnixMs: number;
    expiresAtUnixMs: number;
}

export interface SecurityChallengeEnvelope {
    envelopeId: string;
    policyVersion: string;
    assignments: SecurityChallengeAssignment[];
}

export interface SecurityChallengeProviderPayload {
    challengeId: string;
    payload: Record<string, string>;
    perceptionCharacterV3?: PerceptionCharacterV3IssuePayload;
}

export const PerceptionCharacterV3Representation = {
    Visual: 1,
    Audio: 2
} as const;

export type PerceptionCharacterV3Representation =
    typeof PerceptionCharacterV3Representation[keyof typeof PerceptionCharacterV3Representation];

export interface PerceptionCharacterV3IssuePayload {
    algorithm: 'fsu.challenge/perception-character-artifact@v3';
    challengeId: string;
    envelopeId: string;
    representation: PerceptionCharacterV3Representation;
    mediaType: 'image/png' | 'audio/ogg; codecs=opus';
    mediaBytes: Uint8Array;
    physicalWidth: number;
    physicalHeight: number;
    displayWidth: number;
    displayHeight: number;
    attemptBudget: 2;
    policyVersion: string;
    issuedAtUnixMs: number;
    expiresAtUnixMs: number;
    stateToken: string;
}

export interface PerceptionCharacterV3VerifyPayload {
    algorithm: 'fsu.challenge/perception-character-artifact@v3';
    challengeId: string;
    envelopeId: string;
    representation: PerceptionCharacterV3Representation;
    answer: string;
    stateToken: string;
}

export interface SecurityChallengeIssueResponse {
    decision: SecurityChallengeDecision;
    riskScore: number;
    effectiveRiskScore: number;
    escalationLevel: number;
    policyVersion: string;
    retryAfterMs: number;
    envelope: SecurityChallengeEnvelope | null;
    providerPayloads: SecurityChallengeProviderPayload[];
}

export interface SecurityChallengeVerifyResponse {
    verified: boolean;
    envelopeId: string;
    challengeId: string;
    kind: SecurityChallengeKind;
    policyVersion: string;
    completedCount: number;
    memberCount: number;
    envelopeCompleted: boolean;
    proofToken: string;
    expiresAtUnixMs: number;
    reason: string;
    retryAfterMs: number;
    nextAssignment?: SecurityChallengeAssignment | null;
    nextProviderPayload?: SecurityChallengeProviderPayload | null;
}

export interface SecurityChallengeIssuePodRequest {
    action: string;
    routeKey: string;
    deviceFingerprint: string;
    attributesJson: string;
    capabilityManifestVersion: string;
}

export interface SecurityChallengeVerifyPodRequest {
    envelopeId: string;
    challengeId: string;
    kind: SecurityChallengeKind;
    action: string;
    routeKey: string;
    providerPayloadJson: string;
    perceptionCharacterV3?: PerceptionCharacterV3VerifyPayload;
}

export interface SecurityChallengeCancelPodRequest {
    envelopeId: string;
    action: string;
    routeKey: string;
    deviceFingerprint: string;
    policyVersion: string;
}

export interface UploadInitViewModel {
    uploadId: string;
    fileName: string;
    mimeType: string;
    targetFormat: string;
    totalBytes: number;
    chunkSize: number;
    totalParts: number;
    expiresAt: string;
    uploadToken: string;
}

export interface UploadStatusViewModel {
    uploadId: string;
    status: string;
    totalBytes: number;
    uploadedBytes: number;
    chunkSize: number;
    totalParts: number;
    uploadedPartCount: number;
    nextPartHint: number;
    expiresAt: string;
}

export interface UploadPartRangeViewModel {
    start: number;
    end: number;
}

export interface UploadPartMapViewModel {
    uploadId: string;
    uploadedRanges: UploadPartRangeViewModel[];
}

export interface UploadPartAckViewModel {
    uploadId: string;
    partNumber: number;
    offset: number;
    size: number;
    uploadedBytes: number;
    uploadedPartCount: number;
}

export interface UploadCompleteViewModel {
    uploadId: string;
    url: string;
    relativeUrl: string;
    mimeType: string;
    totalBytes: number;
}
