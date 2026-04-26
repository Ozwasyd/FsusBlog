import type { ArticleDetailResponse, ArticleListItemResponse, PageResponse, PopularArticleSummaryResponse } from '@/api/article';
import { AppErrorCode, createAppError } from '@/utils/appError';
import { readPageEnvelope, readArrayEnvelope } from './envelopeReaders';
import { BinaryReader, readBlobText, readCountChecked, readFixedUtf8, readInt32, readIsoDate64 } from './reader';
import { readArticleListItemCore, readCategoryPod, readPopularArticleItem, readTagList } from './podReaders';
import { ARTICLE_DETAIL_POD_SIZE } from './types';

export function mapArticlePageFromPodPayload(payload: Uint8Array): PageResponse<ArticleListItemResponse> {
  const reader = new BinaryReader(payload);
  return readPageEnvelope(reader, () => readArticleListItemCore(reader), 'article_page_count_invalid');
}

export function mapArticleSearchFromPodPayload(payload: Uint8Array): PageResponse<ArticleListItemResponse> {
  return mapArticlePageFromPodPayload(payload);
}

export function mapArticleHotFromPodPayload(payload: Uint8Array): PopularArticleSummaryResponse[] {
  const reader = new BinaryReader(payload);
  return readArrayEnvelope(reader, () => readPopularArticleItem(reader), 'article_hot_count_invalid');
}

export function mapArticleDetailFromPodPayload(payload: Uint8Array): ArticleDetailResponse {
  if (payload.byteLength < ARTICLE_DETAIL_POD_SIZE + 4 + 4 + 1) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'article_detail_payload_too_short');
  }

  const reader = new BinaryReader(payload);
  const pod = reader.readSpan(ARTICLE_DETAIL_POD_SIZE);
  const tags = readTagList(reader);
  const textBlob = reader.readBlob();
  reader.readByte();

  return {
    id: readInt32(pod, 0),
    title: readFixedUtf8(pod, 152, 256),
    content: readBlobText(pod, textBlob, 416),
    summary: readBlobText(pod, textBlob, 408),
    views: readInt32(pod, 4),
    createTime: readIsoDate64(pod, 8),
    category: readCategoryPod(pod, 16, 20, 128),
    tags
  };
}
