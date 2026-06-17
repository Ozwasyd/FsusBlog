import { FrameType } from '@wasm/protocol/frame';
import { AppErrorCode, createAppError } from '@/utils/appError';
import { mapEmptySuccessFromPayload, mapMutationIdFromPayload } from './commonAdapter';
import { mapArticleDetailFromPodPayload, mapArticleFeaturedFromPodPayload, mapArticleHotFromPodPayload, mapArticlePageFromPodPayload, mapArticleSearchFromPodPayload, mapRelatedReadingFromPodPayload, mapTrashClearResponseFromPodPayload } from './articleAdapter';
import { mapCommentCursorFromPodPayload, mapCommentPolicySnapshotFromPayload, mapThreadReplyCursorFromPodPayload, mapUserCommentCursorFromPodPayload } from './commentAdapter';
import { mapRecentCommentsFromPodPayload, mapRegionsFromPodPayload, mapSiteStatsFromPodPayload } from './statsAdapter';
import { mapPageContentFromPayload, mapSeoConfigFromPayload, mapSiteComplianceConfigFromPayload } from './systemAdapter';
import { mapCategoryListFromPayload, mapTagListFromPayload } from './taxonomyAdapter';
import { mapUploadCompleteFromPayload, mapUploadInitFromPayload, mapUploadPartAckFromPayload, mapUploadPartMapFromPayload, mapUploadStatusFromPayload } from './uploadAdapter';
import { mapAdminUserPageFromPayload } from './userAdapter';
import { mapAuthLoginFlowFromPayload, mapCurrentUserSnapshotFromPayload, mapMfaChallengeResultFromPayload, mapMfaProfileFromPayload, mapMfaSetupStartFromPayload, mapMfaSetupVerifyFromPayload, mapPowChallengeFromPayload, mapRecoveryKeyCreateResponseFromPayload, mapRecoveryKeyVerifyResponseFromPayload, mapUserSessionsFromPayload } from './authAdapter';
import { mapConversationDetailFromPayload, mapConversationListFromPayload, mapConversationMessageFromPayload } from './messageAdapter';
import { mapPasskeyCredentialListFromPayload, mapPasskeyLoginBeginFromPayload, mapPasskeyRegisterBeginFromPayload } from './passkeyAdapter';
import { mapHumanReadChallengeFromPayload, mapHumanReadSubmitFromPayload } from './readProofAdapter';
import { mapAuthoringJsonFromPayload } from './authoringAdapter';
import { mapSecurityJsonFromPayload } from './securityAdapter';
import { mapSiteSubscriptionResponseFromPayload } from './subscriptionAdapter';

const framePayloadMappers: Record<number, (payload: Uint8Array) => unknown> = {
  [FrameType.ArticleList]: mapArticlePageFromPodPayload,
  [FrameType.ArticleDetail]: mapArticleDetailFromPodPayload,
  [FrameType.ArticleHot]: mapArticleHotFromPodPayload,
  [FrameType.ArticleSearch]: mapArticleSearchFromPodPayload,
  [FrameType.ArticleFeatured]: mapArticleFeaturedFromPodPayload,
  [FrameType.ArticleRelatedReading]: mapRelatedReadingFromPodPayload,
  [FrameType.HumanReadChallengeResponse]: mapHumanReadChallengeFromPayload,
  [FrameType.HumanReadSubmitResponse]: mapHumanReadSubmitFromPayload,
  [FrameType.TrashClearResponse]: mapTrashClearResponseFromPodPayload,
  [FrameType.AdminUserList]: mapAdminUserPageFromPayload,
  [FrameType.AuthLoginFlow]: mapAuthLoginFlowFromPayload,
  [FrameType.CurrentUserSnapshot]: mapCurrentUserSnapshotFromPayload,
  [FrameType.AuthSessionList]: mapUserSessionsFromPayload,
  [FrameType.PowChallenge]: mapPowChallengeFromPayload,
  [FrameType.MfaSetupStart]: mapMfaSetupStartFromPayload,
  [FrameType.MfaSetupVerify]: mapMfaSetupVerifyFromPayload,
  [FrameType.MfaProfile]: mapMfaProfileFromPayload,
  [FrameType.MfaChallengeResult]: mapMfaChallengeResultFromPayload,
  [FrameType.RecoveryKeyCreateResponse]: mapRecoveryKeyCreateResponseFromPayload,
  [FrameType.RecoveryKeyVerifyResponse]: mapRecoveryKeyVerifyResponseFromPayload,
  [FrameType.ConversationList]: mapConversationListFromPayload,
  [FrameType.ConversationDetail]: mapConversationDetailFromPayload,
  [FrameType.ConversationMessage]: mapConversationMessageFromPayload,
  [FrameType.PasskeyRegisterBegin]: mapPasskeyRegisterBeginFromPayload,
  [FrameType.PasskeyLoginBegin]: mapPasskeyLoginBeginFromPayload,
  [FrameType.PasskeyCredentialList]: mapPasskeyCredentialListFromPayload,
  [FrameType.CommentPolicySnapshot]: mapCommentPolicySnapshotFromPayload,
  [FrameType.CommentArticleCursor]: mapCommentCursorFromPodPayload,
  [FrameType.CommentUserCursor]: mapUserCommentCursorFromPodPayload,
  [FrameType.CommentThreadReplyCursor]: mapThreadReplyCursorFromPodPayload,
  [FrameType.AdminStats]: mapSiteStatsFromPodPayload,
  [FrameType.CategoryList]: mapCategoryListFromPayload,
  [FrameType.TagList]: mapTagListFromPayload,
  [FrameType.RecentCommentStats]: mapRecentCommentsFromPodPayload,
  [FrameType.RegionStats]: mapRegionsFromPodPayload,
  [FrameType.SeoConfig]: mapSeoConfigFromPayload,
  [FrameType.PageContent]: mapPageContentFromPayload,
  [FrameType.SiteComplianceConfig]: mapSiteComplianceConfigFromPayload,
  [FrameType.UploadInit]: mapUploadInitFromPayload,
  [FrameType.UploadStatus]: mapUploadStatusFromPayload,
  [FrameType.UploadPartAck]: mapUploadPartAckFromPayload,
  [FrameType.UploadComplete]: mapUploadCompleteFromPayload,
  [FrameType.UploadPartMap]: mapUploadPartMapFromPayload,
  [FrameType.AuthorDraftResponse]: mapAuthoringJsonFromPayload,
  [FrameType.AuthorDraftDiscardResponse]: mapAuthoringJsonFromPayload,
  [FrameType.ArticlePreviewResponse]: mapAuthoringJsonFromPayload,
  [FrameType.PrepublishCheckResponse]: mapAuthoringJsonFromPayload,
  [FrameType.AiAssistResponse]: mapAuthoringJsonFromPayload,
  [FrameType.AssetLibraryList]: mapAuthoringJsonFromPayload,
  [FrameType.AssetCleanupResponse]: mapAuthoringJsonFromPayload,
  [FrameType.AuthorTaxonomyCategoryList]: mapAuthoringJsonFromPayload,
  [FrameType.AuthorTaxonomyTagList]: mapAuthoringJsonFromPayload,
  [FrameType.AuthorAnalytics]: mapAuthoringJsonFromPayload,
  [FrameType.AuditLogList]: mapAuthoringJsonFromPayload,
  [FrameType.AuditLogSummary]: mapAuthoringJsonFromPayload,
  [FrameType.AuditLogDetail]: mapAuthoringJsonFromPayload,
  [FrameType.AuditTamperVerifyResponse]: mapAuthoringJsonFromPayload,
  [FrameType.OpsHealth]: mapAuthoringJsonFromPayload,
  [FrameType.BackupStatus]: mapAuthoringJsonFromPayload,
  [FrameType.DangerousOperationPolicy]: mapAuthoringJsonFromPayload,
  [FrameType.CacheDiagnostics]: mapAuthoringJsonFromPayload,
  [FrameType.AdminCacheActionResponse]: mapAuthoringJsonFromPayload,
  [FrameType.IntegrityReport]: mapAuthoringJsonFromPayload,
  [FrameType.IntegrityFixPreview]: mapAuthoringJsonFromPayload,
  [FrameType.IntegrityFixResponse]: mapAuthoringJsonFromPayload,
  [FrameType.CommentModerationQueue]: mapAuthoringJsonFromPayload,
  [FrameType.CommentModerationBulkResponse]: mapAuthoringJsonFromPayload,
  [FrameType.CommentModerationResult]: mapAuthoringJsonFromPayload,
  [FrameType.ContentExport]: mapAuthoringJsonFromPayload,
  [FrameType.ContentBackupExport]: mapAuthoringJsonFromPayload,
  [FrameType.ContentImportResponse]: mapAuthoringJsonFromPayload,
  [FrameType.ArticleRevisionList]: mapAuthoringJsonFromPayload,
  [FrameType.ArticleRevisionDetail]: mapAuthoringJsonFromPayload,
  [FrameType.ArticleRevisionRollbackResponse]: mapAuthoringJsonFromPayload,
  [FrameType.ModerationOverview]: mapAuthoringJsonFromPayload,
  [FrameType.ModerationDictionarySnapshot]: mapAuthoringJsonFromPayload,
  [FrameType.ModerationDictionaryReloadResponse]: mapAuthoringJsonFromPayload,
  [FrameType.ModerationRuntimeStatus]: mapAuthoringJsonFromPayload,
  [FrameType.ModerationRegionList]: mapAuthoringJsonFromPayload,
  [FrameType.ModerationRegionGroupList]: mapAuthoringJsonFromPayload,
  [FrameType.ModerationPolicyTemplateList]: mapAuthoringJsonFromPayload,
  [FrameType.ModerationEffectivePolicy]: mapAuthoringJsonFromPayload,
  [FrameType.RegionPolicySummaryList]: mapAuthoringJsonFromPayload,
  [FrameType.ModerationModelStatus]: mapAuthoringJsonFromPayload,
  [FrameType.ModerationReplayPreview]: mapAuthoringJsonFromPayload,
  [FrameType.SecurityOverview]: mapSecurityJsonFromPayload,
  [FrameType.AntiCrawlerOverview]: mapSecurityJsonFromPayload,
  [FrameType.AntiCrawlerPolicySnapshot]: mapSecurityJsonFromPayload,
  [FrameType.CrawlerRangesAdminStatus]: mapSecurityJsonFromPayload,
  [FrameType.CrawlerRangeSyncResponse]: mapSecurityJsonFromPayload,
  [FrameType.SecurityRiskEventList]: mapSecurityJsonFromPayload,
  [FrameType.SecurityRiskSnapshotList]: mapSecurityJsonFromPayload,
  [FrameType.SecurityRiskResetResponse]: mapSecurityJsonFromPayload,
  [FrameType.AntiCrawlerRuleList]: mapSecurityJsonFromPayload,
  [FrameType.AntiCrawlerRuleResponse]: mapSecurityJsonFromPayload,
  [FrameType.AntiCrawlerRuleDeleteResponse]: mapSecurityJsonFromPayload,
  [FrameType.AntiCrawlerListEntryList]: mapSecurityJsonFromPayload,
  [FrameType.AntiCrawlerListEntryResponse]: mapSecurityJsonFromPayload,
  [FrameType.AntiCrawlerListEntryDeleteResponse]: mapSecurityJsonFromPayload,
  [FrameType.AntiCrawlerSimulationResult]: mapSecurityJsonFromPayload,
  [FrameType.PowOverview]: mapSecurityJsonFromPayload,
  [FrameType.PowPolicySnapshot]: mapSecurityJsonFromPayload,
  [FrameType.SiteSubscriptionResponse]: mapSiteSubscriptionResponseFromPayload,
  [FrameType.EmptySuccess]: mapEmptySuccessFromPayload,
  [FrameType.MutationId]: mapMutationIdFromPayload
};

export function mapFramePayloadToViewModel(frameType: FrameType, payload: Uint8Array): unknown {
  const mapper = framePayloadMappers[frameType];
  if (!mapper) {
    throw createAppError(AppErrorCode.ProtocolFailure, `frame_type_unsupported:${frameType}`);
  }

  return mapper(payload);
}
