import { mapArticleDetailFromPodPayload, mapArticleFeaturedFromPodPayload, mapArticleHotFromPodPayload, mapArticlePageFromPodPayload, mapArticleSearchFromPodPayload, mapRelatedReadingFromPodPayload, mapTrashClearResponseFromPodPayload } from '@/adapters/binary/articleAdapter';
import { mapPublicArticleListCardProjection } from '@/adapters/binary/articleProjectionReader';
import { mapAuthLoginFlowFromPayload, mapCurrentUserSnapshotFromPayload, mapIdentityAccountSnapshotFromPayload, mapMfaChallengeResultFromPayload, mapMfaProfileFromPayload, mapMfaSetupStartFromPayload, mapMfaSetupVerifyFromPayload, mapPowChallengeFromPayload, mapRecoveryKeyCreateResponseFromPayload, mapRecoveryKeyVerifyResponseFromPayload, mapUserSessionsFromPayload } from '@/adapters/binary/authAdapter';
import { mapAuthoringJsonFromPayload } from '@/adapters/binary/authoringAdapter';
import { mapAnonymousCommentTicketResponseFromPayload, mapAnonymousCredentialRevocationArtifactFromPayload, mapAnonymousCredentialRootSnapshotFromPayload, mapAnonymousPrivacyStateSnapshotFromPayload, mapBlindCredentialIssuerMetadataFromPayload, mapBlindCredentialIssueResponseFromPayload, mapCommentChildCursorFromPayload, mapCommentCreateResultFromPayload, mapCommentCursorFromPodPayload, mapCommentPermalinkContextFromPayload, mapCommentPolicySnapshotFromPayload, mapCommentTreeRootCursorFromPayload, mapThreadReplyCursorFromPodPayload, mapUserCommentCursorFromPodPayload } from '@/adapters/binary/commentAdapter';
import { mapEmptySuccessFromPayload, mapMutationIdFromPayload } from '@/adapters/binary/commonAdapter';
import { mapFontActivationListFromPayload, mapFontRegistryDetailFromPayload, mapFontRegistryListFromPayload, mapThemeActivationFromPayload, mapThemeActivationHistoryFromPayload, mapThemeActivationListFromPayload, mapThemeRegistryDetailFromPayload, mapThemeRegistryListFromPayload } from '@/adapters/binary/fontThemeAdminAdapter';
import { mapUserLocalePreferenceFromPayload } from '@/adapters/binary/localePreferenceAdapter';
import { mapAdminConversationDetailFromPayload, mapAdminConversationListFromPayload, mapConversationDetailFromPayload, mapConversationDetailV2FromPayload, mapConversationDetailV3FromPayload, mapConversationListFromPayload, mapConversationMessageFromPayload, mapConversationStatusMutationResultFromPayload } from '@/adapters/binary/messageAdapter';
import { mapPasskeyCredentialListFromPayload, mapPasskeyLoginBeginFromPayload, mapPasskeyRegisterBeginFromPayload, mapPasskeySignalStateFromPayload } from '@/adapters/binary/passkeyAdapter';
import { mapHumanReadChallengeFromPayload, mapHumanReadSubmitFromPayload } from '@/adapters/binary/readProofAdapter';
import { mapSecurityChallengeIssueResponseFromPayload, mapSecurityChallengeVerifyResponseFromPayload, mapSecurityJsonFromPayload } from '@/adapters/binary/securityAdapter';
import { mapRecentCommentsFromPodPayload, mapRegionsFromPodPayload, mapSiteStatsFromPodPayload } from '@/adapters/binary/statsAdapter';
import { mapSiteSubscriptionResponseFromPayload } from '@/adapters/binary/subscriptionAdapter';
import { mapPageContentFromPayload, mapSeoConfigFromPayload, mapSiteComplianceConfigFromPayload } from '@/adapters/binary/systemAdapter';
import { mapCategoryListFromPayload, mapTagListFromPayload, mapTaxonomyExactMetadataFromPayload } from '@/adapters/binary/taxonomyAdapter';
import { mapUploadCompleteFromPayload, mapUploadInitFromPayload, mapUploadPartAckFromPayload, mapUploadPartMapFromPayload, mapUploadStatusFromPayload } from '@/adapters/binary/uploadAdapter';
import { mapAdminUserPageFromPayload } from '@/adapters/binary/userAdapter';
import { decodeArticleCanvasLinkReceipt, decodeArticleCanvasLinkHistoryResponse } from '@/codecs/binary/articleCanvasLinkWire.generated';
import { decodeArticlePropertyValueReadResponse } from '@/codecs/binary/articlePropertyValueReadWire.generated';
import { decodeAuthoringWorkspaceSnapshotResponse } from '@/codecs/binary/authoringWorkspaceSnapshotWire.generated';
import { AEDS_ACCESS_PROFILE, type AedsAccessProfileId } from '@/generated/aedsAccessProfiles';
import { AppErrorCode, createAppError } from '@/utils/appError';

import { FrameType } from '@wasm/protocol/frame';

export type BinaryFrameDecoder = (payload: Uint8Array) => unknown;
export type BinaryFrameDecoderRegistration = readonly [FrameType, BinaryFrameDecoder];

const knownFrameTypes = new Set<number>(Object.values(FrameType));

// This is the protocol-facing response catalog. Keep it independent from the
// decoder registrations so registry validation can detect missing mappings.
export const binaryFrameDecoderFrameTypes = Object.freeze([
    FrameType.ArticleList,
    FrameType.ArticleDetail,
    FrameType.ArticleHot,
    FrameType.ArticleSearch,
    FrameType.ArticleFeatured,
    FrameType.ArticleRelatedReading,
    FrameType.ArticleCanvasLinkReceipt,
    FrameType.ArticleCanvasLinkHistoryResponse,
    FrameType.ArticlePropertyValueReadResponse,
    FrameType.AuthoringWorkspaceSnapshotResponse,
    FrameType.HumanReadChallengeResponse,
    FrameType.HumanReadSubmitResponse,
    FrameType.TrashClearResponse,
    FrameType.AdminUserList,
    FrameType.AuthLoginFlow,
    FrameType.CurrentUserSnapshot,
    FrameType.IdentityAccountSnapshot,
    FrameType.UserLocalePreference,
    FrameType.AuthSessionList,
    FrameType.PowChallenge,
    FrameType.MfaSetupStart,
    FrameType.MfaSetupVerify,
    FrameType.MfaProfile,
    FrameType.MfaChallengeResult,
    FrameType.RecoveryKeyCreateResponse,
    FrameType.RecoveryKeyVerifyResponse,
    FrameType.ConversationList,
    FrameType.ConversationDetail,
    FrameType.ConversationDetailV2,
    FrameType.ConversationDetailV3,
    FrameType.AdminConversationList,
    FrameType.AdminConversationDetail,
    FrameType.ConversationStatusMutationResult,
    FrameType.ConversationMessage,
    FrameType.PasskeyRegisterBegin,
    FrameType.PasskeyLoginBegin,
    FrameType.PasskeyCredentialList,
    FrameType.PasskeySignalState,
    FrameType.CommentPolicySnapshot,
    FrameType.CommentCreateResult,
    FrameType.AnonymousCommentCreateResult,
    FrameType.CommentManagementChallengeResponse,
    FrameType.CommentAuthorMutationResult,
    FrameType.CommentAuthorStatusResult,
    FrameType.CommentRevisionList,
    FrameType.CommentArticleCursor,
    FrameType.CommentUserCursor,
    FrameType.CommentThreadReplyCursor,
    FrameType.CommentTreeRootCursor,
    FrameType.CommentChildCursor,
    FrameType.CommentPermalinkContext,
    FrameType.AnonymousCredentialRootSnapshot,
    FrameType.AnonymousCredentialRevocationSnapshot,
    FrameType.AnonymousCredentialRevocationDelta,
    FrameType.AnonymousCommentTicketResponse,
    FrameType.AnonymousPrivacyStateSnapshot,
    FrameType.BlindCredentialIssuerMetadata,
    FrameType.BlindCredentialIssueResponse,
    FrameType.AdminStats,
    FrameType.CategoryList,
    FrameType.TagList,
    FrameType.TaxonomyExactMetadata,
    FrameType.FontRegistryList,
    FrameType.FontRegistryDetail,
    FrameType.FontActivationList,
    FrameType.ThemeRegistryList,
    FrameType.ThemeRegistryDetail,
    FrameType.ThemeActivationList,
    FrameType.ThemeActivation,
    FrameType.ThemeActivationHistory,
    FrameType.RecentCommentStats,
    FrameType.RegionStats,
    FrameType.SeoConfig,
    FrameType.PageContent,
    FrameType.SiteComplianceConfig,
    FrameType.UploadInit,
    FrameType.UploadStatus,
    FrameType.UploadPartAck,
    FrameType.UploadComplete,
    FrameType.UploadPartMap,
    FrameType.AuthorDraftResponse,
    FrameType.AuthorDraftDiscardResponse,
    FrameType.ArticlePreviewResponse,
    FrameType.PrepublishCheckResponse,
    FrameType.AiAssistResponse,
    FrameType.AssetLibraryList,
    FrameType.AssetCleanupResponse,
    FrameType.AuthorTaxonomyCategoryList,
    FrameType.AuthorTaxonomyTagList,
    FrameType.AuthorAnalytics,
    FrameType.AuditLogList,
    FrameType.AuditLogSummary,
    FrameType.AuditLogDetail,
    FrameType.AuditTamperVerifyResponse,
    FrameType.OpsHealth,
    FrameType.ClusterRuntimeSnapshot,
    FrameType.BackupStatus,
    FrameType.DangerousOperationPolicy,
    FrameType.CacheDiagnostics,
    FrameType.AdminCacheActionResponse,
    FrameType.IntegrityReport,
    FrameType.IntegrityFixPreview,
    FrameType.IntegrityFixResponse,
    FrameType.PluginAdminSnapshot,
    FrameType.CommentModerationQueue,
    FrameType.CommentModerationBulkResponse,
    FrameType.CommentModerationResult,
    FrameType.AnonymousGovernanceActionResponse,
    FrameType.ContentExport,
    FrameType.ContentBackupExport,
    FrameType.ContentImportResponse,
    FrameType.ArticleRevisionList,
    FrameType.ArticleRevisionDetail,
    FrameType.ArticleRevisionRollbackResponse,
    FrameType.ModerationOverview,
    FrameType.ModerationDictionarySnapshot,
    FrameType.ModerationDictionaryReloadResponse,
    FrameType.ModerationRuntimeStatus,
    FrameType.ModerationRegionList,
    FrameType.ModerationRegionGroupList,
    FrameType.ModerationPolicyTemplateList,
    FrameType.ModerationEffectivePolicy,
    FrameType.RegionPolicySummaryList,
    FrameType.ModerationModelStatus,
    FrameType.ModerationReplayPreview,
    FrameType.SecurityOverview,
    FrameType.AntiCrawlerOverview,
    FrameType.AntiCrawlerPolicySnapshot,
    FrameType.CrawlerRangesAdminStatus,
    FrameType.CrawlerRangeSyncResponse,
    FrameType.SecurityRiskEventList,
    FrameType.SecurityRiskSnapshotList,
    FrameType.SecurityRiskResetResponse,
    FrameType.AntiCrawlerRuleList,
    FrameType.AntiCrawlerRuleResponse,
    FrameType.AntiCrawlerRuleDeleteResponse,
    FrameType.AntiCrawlerListEntryList,
    FrameType.AntiCrawlerListEntryResponse,
    FrameType.AntiCrawlerListEntryDeleteResponse,
    FrameType.AntiCrawlerSimulationResult,
    FrameType.PowOverview,
    FrameType.PowPolicySnapshot,
    FrameType.SecurityChallengeIssueResponse,
    FrameType.SecurityChallengeVerifyResponse,
    FrameType.SiteSubscriptionResponse,
    FrameType.AdminPrincipalSnapshot,
    FrameType.EmptySuccess,
    FrameType.MutationId
] as const satisfies readonly FrameType[]);

export function createBinaryFrameDecoderRegistry(
    registrations: readonly BinaryFrameDecoderRegistration[],
    expectedFrameTypes?: readonly FrameType[]
): Readonly<Record<number, BinaryFrameDecoder>>
{
    const registry: Record<number, BinaryFrameDecoder> = Object.create(null) as Record<number, BinaryFrameDecoder>;
    for (const [frameType, decoder] of registrations)
    {
        if (!knownFrameTypes.has(frameType) || frameType === FrameType.Unknown || frameType === FrameType.ApiError)
        {
            throw createAppError(AppErrorCode.ProtocolFailure, `decoder_frame_type_invalid:${frameType}`);
        }
        if (registry[frameType])
        {
            throw createAppError(AppErrorCode.ProtocolFailure, `decoder_frame_type_duplicate:${frameType}`);
        }
        if (typeof decoder !== 'function')
        {
            throw createAppError(AppErrorCode.ProtocolFailure, `decoder_invalid:${frameType}`);
        }
        registry[frameType] = decoder;
    }
    if (Object.keys(registry).length === 0)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, 'decoder_registry_empty');
    }
    if (expectedFrameTypes)
    {
        const expected = new Set(expectedFrameTypes);
        if (expected.size !== expectedFrameTypes.length)
        {
            throw createAppError(AppErrorCode.ProtocolFailure, 'decoder_expected_frame_type_duplicate');
        }
        for (const frameType of expected)
        {
            if (!knownFrameTypes.has(frameType) || frameType === FrameType.Unknown || frameType === FrameType.ApiError)
            {
                throw createAppError(AppErrorCode.ProtocolFailure, `decoder_expected_frame_type_invalid:${frameType}`);
            }
            if (!registry[frameType])
            {
                throw createAppError(AppErrorCode.ProtocolFailure, `decoder_frame_type_missing:${frameType}`);
            }
        }
        for (const frameType of Object.keys(registry).map(Number))
        {
            if (!expected.has(frameType as FrameType))
            {
                throw createAppError(AppErrorCode.ProtocolFailure, `decoder_frame_type_unexpected:${frameType}`);
            }
        }
    }
    return Object.freeze(registry);
}

export const binaryFrameDecoderRegistrations = Object.freeze([
    [FrameType.ArticleList, mapArticlePageFromPodPayload],
    [FrameType.ArticleDetail, mapArticleDetailFromPodPayload],
    [FrameType.ArticleHot, mapArticleHotFromPodPayload],
    [FrameType.ArticleSearch, mapArticleSearchFromPodPayload],
    [FrameType.ArticleFeatured, mapArticleFeaturedFromPodPayload],
    [FrameType.ArticleRelatedReading, mapRelatedReadingFromPodPayload],
    [FrameType.HumanReadChallengeResponse, mapHumanReadChallengeFromPayload],
    [FrameType.HumanReadSubmitResponse, mapHumanReadSubmitFromPayload],
    [FrameType.TrashClearResponse, mapTrashClearResponseFromPodPayload],
    [FrameType.AdminUserList, mapAdminUserPageFromPayload],
    [FrameType.AuthLoginFlow, mapAuthLoginFlowFromPayload],
    [FrameType.CurrentUserSnapshot, mapCurrentUserSnapshotFromPayload],
    [FrameType.IdentityAccountSnapshot, mapIdentityAccountSnapshotFromPayload],
    [FrameType.UserLocalePreference, mapUserLocalePreferenceFromPayload],
    [FrameType.AuthSessionList, mapUserSessionsFromPayload],
    [FrameType.PowChallenge, mapPowChallengeFromPayload],
    [FrameType.MfaSetupStart, mapMfaSetupStartFromPayload],
    [FrameType.MfaSetupVerify, mapMfaSetupVerifyFromPayload],
    [FrameType.MfaProfile, mapMfaProfileFromPayload],
    [FrameType.MfaChallengeResult, mapMfaChallengeResultFromPayload],
    [FrameType.RecoveryKeyCreateResponse, mapRecoveryKeyCreateResponseFromPayload],
    [FrameType.RecoveryKeyVerifyResponse, mapRecoveryKeyVerifyResponseFromPayload],
    [FrameType.ConversationList, mapConversationListFromPayload],
    [FrameType.ConversationDetail, mapConversationDetailFromPayload],
    [FrameType.ConversationDetailV2, mapConversationDetailV2FromPayload],
    [FrameType.ConversationDetailV3, mapConversationDetailV3FromPayload],
    [FrameType.AdminConversationList, mapAdminConversationListFromPayload],
    [FrameType.AdminConversationDetail, mapAdminConversationDetailFromPayload],
    [FrameType.ConversationStatusMutationResult, mapConversationStatusMutationResultFromPayload],
    [FrameType.ConversationMessage, mapConversationMessageFromPayload],
    [FrameType.PasskeyRegisterBegin, mapPasskeyRegisterBeginFromPayload],
    [FrameType.PasskeyLoginBegin, mapPasskeyLoginBeginFromPayload],
    [FrameType.PasskeyCredentialList, mapPasskeyCredentialListFromPayload],
    [FrameType.PasskeySignalState, mapPasskeySignalStateFromPayload],
    [FrameType.CommentPolicySnapshot, mapCommentPolicySnapshotFromPayload],
    [FrameType.CommentCreateResult, mapCommentCreateResultFromPayload],
    [FrameType.AnonymousCommentCreateResult, mapAuthoringJsonFromPayload],
    [FrameType.CommentManagementChallengeResponse, mapAuthoringJsonFromPayload],
    [FrameType.CommentAuthorMutationResult, mapAuthoringJsonFromPayload],
    [FrameType.CommentAuthorStatusResult, mapAuthoringJsonFromPayload],
    [FrameType.CommentRevisionList, mapAuthoringJsonFromPayload],
    [FrameType.CommentArticleCursor, mapCommentCursorFromPodPayload],
    [FrameType.CommentUserCursor, mapUserCommentCursorFromPodPayload],
    [FrameType.CommentThreadReplyCursor, mapThreadReplyCursorFromPodPayload],
    [FrameType.CommentTreeRootCursor, mapCommentTreeRootCursorFromPayload],
    [FrameType.CommentChildCursor, mapCommentChildCursorFromPayload],
    [FrameType.CommentPermalinkContext, mapCommentPermalinkContextFromPayload],
    [FrameType.AnonymousCredentialRootSnapshot, mapAnonymousCredentialRootSnapshotFromPayload],
    [FrameType.AnonymousCredentialRevocationSnapshot, mapAnonymousCredentialRevocationArtifactFromPayload],
    [FrameType.AnonymousCredentialRevocationDelta, mapAnonymousCredentialRevocationArtifactFromPayload],
    [FrameType.AnonymousCommentTicketResponse, mapAnonymousCommentTicketResponseFromPayload],
    [FrameType.AnonymousPrivacyStateSnapshot, mapAnonymousPrivacyStateSnapshotFromPayload],
    [FrameType.BlindCredentialIssuerMetadata, mapBlindCredentialIssuerMetadataFromPayload],
    [FrameType.BlindCredentialIssueResponse, mapBlindCredentialIssueResponseFromPayload],
    [FrameType.AdminStats, mapSiteStatsFromPodPayload],
    [FrameType.CategoryList, mapCategoryListFromPayload],
    [FrameType.TagList, mapTagListFromPayload],
    [FrameType.TaxonomyExactMetadata, mapTaxonomyExactMetadataFromPayload],
    [FrameType.FontRegistryList, mapFontRegistryListFromPayload],
    [FrameType.FontRegistryDetail, mapFontRegistryDetailFromPayload],
    [FrameType.FontActivationList, mapFontActivationListFromPayload],
    [FrameType.ThemeRegistryList, mapThemeRegistryListFromPayload],
    [FrameType.ThemeRegistryDetail, mapThemeRegistryDetailFromPayload],
    [FrameType.ThemeActivationList, mapThemeActivationListFromPayload],
    [FrameType.ThemeActivation, mapThemeActivationFromPayload],
    [FrameType.ThemeActivationHistory, mapThemeActivationHistoryFromPayload],
    [FrameType.RecentCommentStats, mapRecentCommentsFromPodPayload],
    [FrameType.RegionStats, mapRegionsFromPodPayload],
    [FrameType.SeoConfig, mapSeoConfigFromPayload],
    [FrameType.PageContent, mapPageContentFromPayload],
    [FrameType.SiteComplianceConfig, mapSiteComplianceConfigFromPayload],
    [FrameType.UploadInit, mapUploadInitFromPayload],
    [FrameType.UploadStatus, mapUploadStatusFromPayload],
    [FrameType.UploadPartAck, mapUploadPartAckFromPayload],
    [FrameType.UploadComplete, mapUploadCompleteFromPayload],
    [FrameType.UploadPartMap, mapUploadPartMapFromPayload],
    [FrameType.AuthorDraftResponse, mapAuthoringJsonFromPayload],
    [FrameType.AuthorDraftDiscardResponse, mapAuthoringJsonFromPayload],
    [FrameType.ArticlePreviewResponse, mapAuthoringJsonFromPayload],
    [FrameType.PrepublishCheckResponse, mapAuthoringJsonFromPayload],
    [FrameType.AiAssistResponse, mapAuthoringJsonFromPayload],
    [FrameType.AssetLibraryList, mapAuthoringJsonFromPayload],
    [FrameType.AssetCleanupResponse, mapAuthoringJsonFromPayload],
    [FrameType.AuthorTaxonomyCategoryList, mapAuthoringJsonFromPayload],
    [FrameType.AuthorTaxonomyTagList, mapAuthoringJsonFromPayload],
    [FrameType.AuthorAnalytics, mapAuthoringJsonFromPayload],
    [FrameType.AuditLogList, mapAuthoringJsonFromPayload],
    [FrameType.AuditLogSummary, mapAuthoringJsonFromPayload],
    [FrameType.AuditLogDetail, mapAuthoringJsonFromPayload],
    [FrameType.AuditTamperVerifyResponse, mapAuthoringJsonFromPayload],
    [FrameType.OpsHealth, mapAuthoringJsonFromPayload],
    [FrameType.ClusterRuntimeSnapshot, mapAuthoringJsonFromPayload],
    [FrameType.BackupStatus, mapAuthoringJsonFromPayload],
    [FrameType.DangerousOperationPolicy, mapAuthoringJsonFromPayload],
    [FrameType.CacheDiagnostics, mapAuthoringJsonFromPayload],
    [FrameType.AdminCacheActionResponse, mapAuthoringJsonFromPayload],
    [FrameType.IntegrityReport, mapAuthoringJsonFromPayload],
    [FrameType.IntegrityFixPreview, mapAuthoringJsonFromPayload],
    [FrameType.IntegrityFixResponse, mapAuthoringJsonFromPayload],
    [FrameType.PluginAdminSnapshot, mapAuthoringJsonFromPayload],
    [FrameType.CommentModerationQueue, mapAuthoringJsonFromPayload],
    [FrameType.CommentModerationBulkResponse, mapAuthoringJsonFromPayload],
    [FrameType.CommentModerationResult, mapAuthoringJsonFromPayload],
    [FrameType.AnonymousGovernanceActionResponse, mapAuthoringJsonFromPayload],
    [FrameType.ContentExport, mapAuthoringJsonFromPayload],
    [FrameType.ContentBackupExport, mapAuthoringJsonFromPayload],
    [FrameType.ContentImportResponse, mapAuthoringJsonFromPayload],
    [FrameType.ArticleRevisionList, mapAuthoringJsonFromPayload],
    [FrameType.ArticleRevisionDetail, mapAuthoringJsonFromPayload],
    [FrameType.ArticleRevisionRollbackResponse, mapAuthoringJsonFromPayload],
    [FrameType.ModerationOverview, mapAuthoringJsonFromPayload],
    [FrameType.ModerationDictionarySnapshot, mapAuthoringJsonFromPayload],
    [FrameType.ModerationDictionaryReloadResponse, mapAuthoringJsonFromPayload],
    [FrameType.ModerationRuntimeStatus, mapAuthoringJsonFromPayload],
    [FrameType.ModerationRegionList, mapAuthoringJsonFromPayload],
    [FrameType.ModerationRegionGroupList, mapAuthoringJsonFromPayload],
    [FrameType.ModerationPolicyTemplateList, mapAuthoringJsonFromPayload],
    [FrameType.ModerationEffectivePolicy, mapAuthoringJsonFromPayload],
    [FrameType.RegionPolicySummaryList, mapAuthoringJsonFromPayload],
    [FrameType.ModerationModelStatus, mapAuthoringJsonFromPayload],
    [FrameType.ModerationReplayPreview, mapAuthoringJsonFromPayload],
    [FrameType.SecurityOverview, mapSecurityJsonFromPayload],
    [FrameType.AntiCrawlerOverview, mapSecurityJsonFromPayload],
    [FrameType.AntiCrawlerPolicySnapshot, mapSecurityJsonFromPayload],
    [FrameType.CrawlerRangesAdminStatus, mapSecurityJsonFromPayload],
    [FrameType.CrawlerRangeSyncResponse, mapSecurityJsonFromPayload],
    [FrameType.SecurityRiskEventList, mapSecurityJsonFromPayload],
    [FrameType.SecurityRiskSnapshotList, mapSecurityJsonFromPayload],
    [FrameType.SecurityRiskResetResponse, mapSecurityJsonFromPayload],
    [FrameType.AntiCrawlerRuleList, mapSecurityJsonFromPayload],
    [FrameType.AntiCrawlerRuleResponse, mapSecurityJsonFromPayload],
    [FrameType.AntiCrawlerRuleDeleteResponse, mapSecurityJsonFromPayload],
    [FrameType.AntiCrawlerListEntryList, mapSecurityJsonFromPayload],
    [FrameType.AntiCrawlerListEntryResponse, mapSecurityJsonFromPayload],
    [FrameType.AntiCrawlerListEntryDeleteResponse, mapSecurityJsonFromPayload],
    [FrameType.AntiCrawlerSimulationResult, mapSecurityJsonFromPayload],
    [FrameType.PowOverview, mapSecurityJsonFromPayload],
    [FrameType.PowPolicySnapshot, mapSecurityJsonFromPayload],
    [FrameType.SecurityChallengeIssueResponse, mapSecurityChallengeIssueResponseFromPayload],
    [FrameType.SecurityChallengeVerifyResponse, mapSecurityChallengeVerifyResponseFromPayload],
    [FrameType.SiteSubscriptionResponse, mapSiteSubscriptionResponseFromPayload],
    [FrameType.AdminPrincipalSnapshot, mapAuthoringJsonFromPayload],
    [FrameType.EmptySuccess, mapEmptySuccessFromPayload],
    [FrameType.MutationId, mapMutationIdFromPayload],
    [FrameType.ArticleCanvasLinkReceipt, decodeArticleCanvasLinkReceipt],
    [FrameType.ArticleCanvasLinkHistoryResponse, decodeArticleCanvasLinkHistoryResponse],
    [FrameType.ArticlePropertyValueReadResponse, decodeArticlePropertyValueReadResponse],
    [FrameType.AuthoringWorkspaceSnapshotResponse, decodeAuthoringWorkspaceSnapshotResponse]
] as const satisfies readonly BinaryFrameDecoderRegistration[]);

export const binaryFrameDecoderRegistry = createBinaryFrameDecoderRegistry(
    binaryFrameDecoderRegistrations,
    binaryFrameDecoderFrameTypes
);

export function decodeBinaryFramePayload(
    frameType: FrameType,
    payload: Uint8Array,
    accessProfile?: AedsAccessProfileId
): unknown
{
    if (accessProfile === AEDS_ACCESS_PROFILE.publicArticleListCard)
    {
        if (frameType !== FrameType.ArticleList)
        {
            throw createAppError(AppErrorCode.ProtocolFailure, 'access_profile_frame_type_mismatch');
        }
        return mapPublicArticleListCardProjection(payload);
    }
    if (accessProfile !== undefined)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, `access_profile_not_enabled:${accessProfile}`);
    }
    return decodeBinaryFramePayloadWithRegistry(binaryFrameDecoderRegistry, frameType, payload);
}

export function decodeBinaryFramePayloadWithRegistry(
    registry: Readonly<Record<number, BinaryFrameDecoder>>,
    frameType: FrameType,
    payload: Uint8Array
): unknown
{
    const mapper = registry[frameType];
    if (!mapper)
    {
        throw createAppError(AppErrorCode.ProtocolFailure, `frame_type_unsupported:${frameType}`);
    }

    return mapper(payload);
}
