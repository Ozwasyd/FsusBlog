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

  const ids = new Int32Array(count);
  const views = new Int32Array(count);
  const createTimeUnixMs = new Float64Array(count);
  const categoryIds = new Int32Array(count);
  const categoryNameOffsets = new Int32Array(count);
  const categoryNameLengths = new Int32Array(count);
  const titleOffsets = new Int32Array(count);
  const titleLengths = new Int32Array(count);
  const summaryOffsets = new Int32Array(count);
  const summaryLengths = new Int32Array(count);
  const tagStarts = new Int32Array(count);
  const tagCounts = new Int32Array(count);
  const isDeletedFlags = new Uint8Array(count);
  const hasIsDeletedFlags = new Uint8Array(count);
  const statuses = new Int32Array(count);
  const scheduledPublishAtUnixMs = new Float64Array(count);
  const publishedAtUnixMs = new Float64Array(count);
  const hasPublicationTail = itemRecordSize === 76;

  for (let i = 0; i < count; i += 1) {
    const record = reader.readSpan(itemRecordSize);
    const categoryName = readSliceRef(record, 20);
    const title = readSliceRef(record, 28);
    const summary = readSliceRef(record, 36);
    ids[i] = readInt32(record, 0);
    views[i] = readInt32(record, 4);
    createTimeUnixMs[i] = readInt64Number(record, 8);
    categoryIds[i] = readInt32(record, 16);
    categoryNameOffsets[i] = categoryName.offset;
    categoryNameLengths[i] = categoryName.length;
    titleOffsets[i] = title.offset;
    titleLengths[i] = title.length;
    summaryOffsets[i] = summary.offset;
    summaryLengths[i] = summary.length;
    tagStarts[i] = readInt32(record, 44);
    tagCounts[i] = readInt32(record, 48);
    isDeletedFlags[i] = record[52] ?? 0;
    hasIsDeletedFlags[i] = record[53] ?? 0;
    statuses[i] = hasPublicationTail ? readInt32(record, 56) : 2;
    scheduledPublishAtUnixMs[i] = hasPublicationTail ? readInt64Number(record, 60) : 0;
    publishedAtUnixMs[i] = hasPublicationTail ? readInt64Number(record, 68) : 0;
  }

  const tagRecords: ArticleListItemResponse['tags'] = [];
  for (let i = 0; i < tagRecordCount; i += 1) {
    const record = reader.readSpan(12);
    tagRecords.push({
      id: readInt32(record, 0),
      name: readSliceText(blob, readSliceRef(record, 4))
    });
  }

  const items: ArticleListItemResponse[] = new Array(count);
  for (let i = 0; i < count; i += 1) {
    const tags: ArticleListItemResponse['tags'] = new Array(tagCounts[i] ?? 0);
    for (let tagIndex = 0; tagIndex < tags.length; tagIndex += 1) {
      tags[tagIndex] = tagRecords[(tagStarts[i] ?? 0) + tagIndex] ?? { id: 0, name: '' };
    }

    const item: ArticleListItemResponse = {
      id: ids[i] ?? 0,
      title: readSliceText(blob, { offset: titleOffsets[i] ?? 0, length: titleLengths[i] ?? 0 }),
      summary: readSliceText(blob, { offset: summaryOffsets[i] ?? 0, length: summaryLengths[i] ?? 0 }),
      views: views[i] ?? 0,
      createTime: new Date(createTimeUnixMs[i] ?? 0).toISOString(),
      category: {
        id: categoryIds[i] ?? 0,
        name: readSliceText(blob, { offset: categoryNameOffsets[i] ?? 0, length: categoryNameLengths[i] ?? 0 })
      },
      tags
    };
    if (hasPublicationTail && hasIsDeletedFlags[i] === 1) {
      item.isDeleted = isDeletedFlags[i] === 1;
    }
    if (hasPublicationTail) {
      item.status = (statuses[i] ?? 2) as ArticleListItemResponse['status'];
      item.scheduledPublishAt = unixMsToIsoOrNull(scheduledPublishAtUnixMs[i] ?? 0);
      item.publishedAt = unixMsToIsoOrNull(publishedAtUnixMs[i] ?? 0);
    }
    items[i] = item;
  }

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
