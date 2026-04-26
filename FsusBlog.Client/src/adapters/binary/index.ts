import { FrameType } from '@wasm/protocol/frame';
import { AppErrorCode, createAppError } from '@/utils/appError';
import { mapArticleDetailFromPodPayload, mapArticleHotFromPodPayload, mapArticlePageFromPodPayload, mapArticleSearchFromPodPayload } from './articleAdapter';
import { mapCommentCursorFromPodPayload, mapThreadReplyCursorFromPodPayload, mapUserCommentCursorFromPodPayload } from './commentAdapter';
import { mapSiteStatsFromPodPayload } from './statsAdapter';
import { mapUploadCompleteFromPayload, mapUploadInitFromPayload, mapUploadPartAckFromPayload, mapUploadPartMapFromPayload, mapUploadStatusFromPayload } from './uploadAdapter';

const framePayloadMappers: Record<number, (payload: Uint8Array) => unknown> = {
  [FrameType.ArticleList]: mapArticlePageFromPodPayload,
  [FrameType.ArticleDetail]: mapArticleDetailFromPodPayload,
  [FrameType.ArticleHot]: mapArticleHotFromPodPayload,
  [FrameType.ArticleSearch]: mapArticleSearchFromPodPayload,
  [FrameType.CommentArticleCursor]: mapCommentCursorFromPodPayload,
  [FrameType.CommentUserCursor]: mapUserCommentCursorFromPodPayload,
  [FrameType.CommentThreadReplyCursor]: mapThreadReplyCursorFromPodPayload,
  [FrameType.AdminStats]: mapSiteStatsFromPodPayload,
  [FrameType.UploadInit]: mapUploadInitFromPayload,
  [FrameType.UploadStatus]: mapUploadStatusFromPayload,
  [FrameType.UploadPartAck]: mapUploadPartAckFromPayload,
  [FrameType.UploadComplete]: mapUploadCompleteFromPayload,
  [FrameType.UploadPartMap]: mapUploadPartMapFromPayload
};

export function mapFramePayloadToViewModel(frameType: FrameType, payload: Uint8Array): unknown {
  const mapper = framePayloadMappers[frameType];
  if (!mapper) {
    throw createAppError(AppErrorCode.ProtocolFailure, `frame_type_unsupported:${frameType}`);
  }

  return mapper(payload);
}
