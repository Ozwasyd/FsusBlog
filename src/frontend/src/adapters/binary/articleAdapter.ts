import type { ArticleDetailResponse, ArticleListItemResponse, FeaturedArticleItem, PageResponse, PopularArticleSummaryResponse } from '@/api/article';
import type { TrashClearResponse } from '@/api/stats';
import { AppErrorCode, createAppError } from '@/utils/appError';
import { BinaryReader, readBlobText, readCountChecked, readFixedUtf8, readInt32, readInt64Number, readIsoDate64, readSliceRef, readSliceText } from './reader';
import { readCategoryPod, readFeaturedArticleItem, readTagList } from './podReaders';
import { readArrayEnvelope } from './envelopeReaders';
import { ARTICLE_DETAIL_POD_SIZE, ARTICLE_LIST_ITEM_POD_SIZE } from './types';

export function mapArticlePageFromPodPayload(payload: Uint8Array): PageResponse<ArticleListItemResponse> {
  const reader = new BinaryReader(payload);
  const total = reader.readInt32();
  const count = readCountChecked(reader, 'article_page_count_invalid');
  const tagRecordCount = readCountChecked(reader, 'article_page_tag_count_invalid');
  const blob = reader.readBlob();
  const itemRecordBytes = reader.remaining() - tagRecordCount * 12;
  const itemRecordSize = count === 0 ? 76 : itemRecordBytes / count;
  if (itemRecordBytes < 0 || (count > 0 && itemRecordBytes % count !== 0) || (itemRecordSize !== 56 && itemRecordSize !== 76)) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'article_page_record_layout_invalid');
  }

  const records: Array<{
    id: number;
    views: number;
    createTimeUnixMs: number;
    categoryId: number;
    categoryNameOffset: number;
    categoryNameLength: number;
    titleOffset: number;
    titleLength: number;
    summaryOffset: number;
    summaryLength: number;
    tagStart: number;
    tagCount: number;
    isDeleted: boolean | undefined;
    status: number;
    scheduledPublishAtUnixMs: number;
    publishedAtUnixMs: number;
    hasPublicationTail: boolean;
  }> = [];

  for (let i = 0; i < count; i += 1) {
    const record = reader.readSpan(itemRecordSize);
    const categoryName = readSliceRef(record, 20);
    const title = readSliceRef(record, 28);
    const summary = readSliceRef(record, 36);
    const isDeletedFlag = record[52] ?? 0;
    const hasIsDeleted = record[53] ?? 0;
    records.push({
      id: readInt32(record, 0),
      views: readInt32(record, 4),
      createTimeUnixMs: readInt64Number(record, 8),
      categoryId: readInt32(record, 16),
      categoryNameOffset: categoryName.offset,
      categoryNameLength: categoryName.length,
      titleOffset: title.offset,
      titleLength: title.length,
      summaryOffset: summary.offset,
      summaryLength: summary.length,
      tagStart: readInt32(record, 44),
      tagCount: readInt32(record, 48),
      isDeleted: hasIsDeleted === 1 ? isDeletedFlag === 1 : undefined,
      status: itemRecordSize === 76 ? readInt32(record, 56) : 2,
      scheduledPublishAtUnixMs: itemRecordSize === 76 ? readInt64Number(record, 60) : 0,
      publishedAtUnixMs: itemRecordSize === 76 ? readInt64Number(record, 68) : 0,
      hasPublicationTail: itemRecordSize === 76
    });
  }

  const tagRecords: ArticleListItemResponse['tags'] = [];
  for (let i = 0; i < tagRecordCount; i += 1) {
    const record = reader.readSpan(12);
    tagRecords.push({
      id: readInt32(record, 0),
      name: readSliceText(blob, readSliceRef(record, 4))
    });
  }

  const items = records.map((record) => {
    const item: ArticleListItemResponse = {
      id: record.id,
      title: readSliceText(blob, { offset: record.titleOffset, length: record.titleLength }),
      summary: readSliceText(blob, { offset: record.summaryOffset, length: record.summaryLength }),
      views: record.views,
      createTime: new Date(record.createTimeUnixMs).toISOString(),
      category: {
        id: record.categoryId,
        name: readSliceText(blob, { offset: record.categoryNameOffset, length: record.categoryNameLength })
      },
      tags: tagRecords.slice(record.tagStart, record.tagStart + record.tagCount)
    };
    if (record.hasPublicationTail && record.isDeleted !== undefined) {
      item.isDeleted = record.isDeleted;
    }
    if (record.hasPublicationTail) {
      item.status = record.status as ArticleListItemResponse['status'];
      item.scheduledPublishAt = unixMsToIsoOrNull(record.scheduledPublishAtUnixMs);
      item.publishedAt = unixMsToIsoOrNull(record.publishedAtUnixMs);
    }
    return item;
  });

  return { items, total };
}

export function mapArticleSearchFromPodPayload(payload: Uint8Array): PageResponse<ArticleListItemResponse> {
  if (payload.byteLength < 24 || readInt32(payload, 0) !== 0x33525346) {
    return mapArticleSearchListPayload(payload);
  }

  const version = readInt32(payload, 4);
  if (version !== 3) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'search_result_version_invalid');
  }

  const total = readInt32(payload, 8);
  const count = readCountChecked(new BinaryReader(payload.subarray(12, 16)), 'article_search_count_invalid');
  const tagOffset = readInt32(payload, 16);
  const blobOffset = readInt32(payload, 20);
  const itemRecordSize = 52;
  const tagRecordSize = 12;
  const itemStart = 24;
  const itemEnd = itemStart + count * itemRecordSize;
  if (count < 0 || total < 0 || tagOffset < itemEnd || blobOffset < tagOffset || blobOffset > payload.byteLength) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'search_result_layout_invalid');
  }

  const blob = payload.subarray(blobOffset);
  const items: ArticleListItemResponse[] = [];
  for (let i = 0; i < count; i++) {
    const offset = itemStart + i * itemRecordSize;
    const tagStart = readInt32(payload, offset + 44);
    const tagCount = readInt32(payload, offset + 48);
    if (tagStart < 0 || tagCount < 0 || tagOffset + (tagStart + tagCount) * tagRecordSize > blobOffset) {
      throw createAppError(AppErrorCode.ProtocolFailure, 'search_result_tag_layout_invalid');
    }

    const tags: ArticleListItemResponse['tags'] = [];
    for (let tagIndex = 0; tagIndex < tagCount; tagIndex++) {
      const tagRecordOffset = tagOffset + (tagStart + tagIndex) * tagRecordSize;
      tags.push({
        id: readInt32(payload, tagRecordOffset),
        name: readSliceText(blob, {
          offset: readInt32(payload, tagRecordOffset + 4),
          length: readInt32(payload, tagRecordOffset + 8)
        })
      });
    }

    items.push({
      id: readInt32(payload, offset),
      views: readInt32(payload, offset + 4),
      createTime: new Date(readInt64Number(payload, offset + 8)).toISOString(),
      category: {
        id: readInt32(payload, offset + 16),
        name: readSliceText(blob, {
          offset: readInt32(payload, offset + 20),
          length: readInt32(payload, offset + 24)
        })
      },
      title: readSliceText(blob, {
        offset: readInt32(payload, offset + 28),
        length: readInt32(payload, offset + 32)
      }),
      summary: readSliceText(blob, {
        offset: readInt32(payload, offset + 36),
        length: readInt32(payload, offset + 40)
      }),
      tags
    });
  }

  return { items, total };
}

function mapArticleSearchListPayload(payload: Uint8Array): PageResponse<ArticleListItemResponse> {
  const reader = new BinaryReader(payload);
  const count = readCountChecked(reader, 'article_search_count_invalid');
  const items: ArticleListItemResponse[] = [];
  for (let i = 0; i < count; i += 1) {
    const pod = reader.readSpan(ARTICLE_LIST_ITEM_POD_SIZE);
    const tags = readTagList(reader);
    const blob = reader.readBlob();
    items.push({
      id: readInt32(pod, 0),
      views: readInt32(pod, 4),
      createTime: readIsoDate64(pod, 8),
      category: readCategoryPod(pod, 16, 20, 128),
      title: readFixedUtf8(pod, 148, 256),
      summary: readBlobText(pod, blob, 404),
      tags
    });
  }

  if (reader.remaining() !== 0) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'article_search_trailing_payload_invalid');
  }

  return { items, total: count };
}

export function mapArticleHotFromPodPayload(payload: Uint8Array): PopularArticleSummaryResponse[] {
  const reader = new BinaryReader(payload);
  const count = readCountChecked(reader, 'article_hot_count_invalid');
  const blob = reader.readBlob();
  const items: PopularArticleSummaryResponse[] = [];
  for (let i = 0; i < count; i += 1) {
    const record = reader.readSpan(16);
    items.push({
      id: readInt32(record, 0),
      views: readInt32(record, 4),
      title: readSliceText(blob, readSliceRef(record, 8))
    });
  }
  return items;
}

export function mapArticleFeaturedFromPodPayload(payload: Uint8Array): FeaturedArticleItem[] {
  const reader = new BinaryReader(payload);
  return readArrayEnvelope(reader, () => readFeaturedArticleItem(reader), 'article_featured_count_invalid', 'article_featured_trailing_payload_invalid');
}

export function mapTrashClearResponseFromPodPayload(payload: Uint8Array): TrashClearResponse {
  if (payload.byteLength !== 4) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'trash_clear_payload_invalid');
  }

  return { count: readInt32(payload, 0) };
}

export function mapArticleDetailFromPodPayload(payload: Uint8Array): ArticleDetailResponse {
  if (payload.byteLength < ARTICLE_DETAIL_POD_SIZE + 4 + 4 + 1) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'article_detail_payload_too_short');
  }

  const reader = new BinaryReader(payload);
  const pod = reader.readSpan(ARTICLE_DETAIL_POD_SIZE);
  const tags = readTagList(reader);
  const textBlob = reader.readBlob();
  let coverImageUrl = '';
  if (reader.remaining() > 1) {
    const coverBlob = reader.readBlob();
    coverImageUrl = new TextDecoder().decode(coverBlob);
  }
  const isDeleted = reader.readByte() === 1;
  if (reader.remaining() !== 0 && reader.remaining() !== 20) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'article_detail_publication_tail_invalid');
  }

  const hasPublicationTail = reader.remaining() === 20;
  const status = hasPublicationTail ? reader.readInt32() : 2;
  const scheduledPublishAtUnixMs = reader.remaining() >= 16 ? reader.readInt64() : 0;
  const publishedAtUnixMs = reader.remaining() >= 8 ? reader.readInt64() : 0;

  const detail: ArticleDetailResponse = {
    id: readInt32(pod, 0),
    title: readFixedUtf8(pod, 152, 256),
    content: readBlobText(pod, textBlob, 416),
    summary: readBlobText(pod, textBlob, 408),
    views: readInt32(pod, 4),
    createTime: readIsoDate64(pod, 8),
    category: readCategoryPod(pod, 20, 24, 128),
    coverImageUrl,
    tags
  };
  if (hasPublicationTail) {
    detail.isDeleted = isDeleted;
    detail.status = status as ArticleDetailResponse['status'];
    detail.scheduledPublishAt = unixMsToIsoOrNull(scheduledPublishAtUnixMs);
    detail.publishedAt = unixMsToIsoOrNull(publishedAtUnixMs);
  }
  return detail;
}

function unixMsToIsoOrNull(value: number): string | null {
  return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null;
}
