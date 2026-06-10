import { FrameType } from '@wasm/protocol/frame';
import { AppErrorCode, createAppError } from '@/utils/appError';
import { mapEmptySuccessFromPayload, mapMutationIdFromPayload } from './commonAdapter';
import { mapArticleDetailFromPodPayload, mapArticleFeaturedFromPodPayload, mapArticleHotFromPodPayload, mapArticlePageFromPodPayload, mapArticleSearchFromPodPayload, mapTrashClearResponseFromPodPayload } from './articleAdapter';
import { mapCommentCursorFromPodPayload, mapThreadReplyCursorFromPodPayload, mapUserCommentCursorFromPodPayload } from './commentAdapter';
import { mapRecentCommentsFromPodPayload, mapRegionsFromPodPayload, mapSiteStatsFromPodPayload } from './statsAdapter';
import { mapPageContentFromPayload, mapSeoConfigFromPayload, mapSiteComplianceConfigFromPayload } from './systemAdapter';
import { mapCategoryListFromPayload, mapTagListFromPayload } from './taxonomyAdapter';
import { mapUploadCompleteFromPayload, mapUploadInitFromPayload, mapUploadPartAckFromPayload, mapUploadPartMapFromPayload, mapUploadStatusFromPayload } from './uploadAdapter';
import { mapAdminUserPageFromPayload } from './userAdapter';
import { mapAuthLoginFlowFromPayload, mapCurrentUserSnapshotFromPayload, mapMfaChallengeResultFromPayload, mapMfaProfileFromPayload, mapMfaSetupStartFromPayload, mapMfaSetupVerifyFromPayload, mapPowChallengeFromPayload, mapUserSessionsFromPayload } from './authAdapter';
import { mapConversationDetailFromPayload, mapConversationListFromPayload, mapConversationMessageFromPayload } from './messageAdapter';
import { mapPasskeyCredentialListFromPayload, mapPasskeyLoginBeginFromPayload, mapPasskeyRegisterBeginFromPayload } from './passkeyAdapter';

const framePayloadMappers: Record<number, (payload: Uint8Array) => unknown> = {
  [FrameType.ArticleList]: mapArticlePageFromPodPayload,
  [FrameType.ArticleDetail]: mapArticleDetailFromPodPayload,
  [FrameType.ArticleHot]: mapArticleHotFromPodPayload,
  [FrameType.ArticleSearch]: mapArticleSearchFromPodPayload,
  [FrameType.ArticleFeatured]: mapArticleFeaturedFromPodPayload,
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
  [FrameType.ConversationList]: mapConversationListFromPayload,
  [FrameType.ConversationDetail]: mapConversationDetailFromPayload,
  [FrameType.ConversationMessage]: mapConversationMessageFromPayload,
  [FrameType.PasskeyRegisterBegin]: mapPasskeyRegisterBeginFromPayload,
  [FrameType.PasskeyLoginBegin]: mapPasskeyLoginBeginFromPayload,
  [FrameType.PasskeyCredentialList]: mapPasskeyCredentialListFromPayload,
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
