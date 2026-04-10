import { FrameType } from '@wasm/protocol/frame';
import { mapArticleDetailFromPodPayload, mapArticleHotFromPodPayload, mapArticlePageFromPodPayload, mapArticleSearchFromPodPayload } from './articleAdapter';
import { mapCommentCursorFromPodPayload, mapUserCommentCursorFromPodPayload } from './commentAdapter';
import { mapSiteStatsFromPodPayload } from './statsAdapter';

export function mapFramePayloadToViewModel(frameType: FrameType, payload: Uint8Array): unknown {
  switch (frameType) {
    case FrameType.ArticleList:
      return mapArticlePageFromPodPayload(payload);
    case FrameType.ArticleDetail:
      return mapArticleDetailFromPodPayload(payload);
    case FrameType.ArticleHot:
      return mapArticleHotFromPodPayload(payload);
    case FrameType.ArticleSearch:
      return mapArticleSearchFromPodPayload(payload);
    case FrameType.CommentArticleCursor:
      return mapCommentCursorFromPodPayload(payload);
    case FrameType.CommentUserCursor:
      return mapUserCommentCursorFromPodPayload(payload);
    case FrameType.AdminStats:
      return mapSiteStatsFromPodPayload(payload);
    default:
      throw new Error(`frame_type_unsupported:${frameType}`);
  }
}
