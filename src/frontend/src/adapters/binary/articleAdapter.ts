import type { ArticleDetailResponse, ArticleListItemResponse, ArticleRightsResponse, BinaryPageResponse as PageResponse, FeaturedArticleItem, PopularArticleSummaryResponse, RelatedReadingItemResponse, RelatedReadingResponse, TrashClearResponse } from '@/contracts/binaryApi';
import { AppErrorCode, createAppError } from '@/utils/appError';
import { BinaryReader, readBlobText, readCountChecked, readFixedUtf8, readInt32, readInt64Number, readInt64String, readIsoDate64, readSliceRef, readSliceText } from '@/codecs/binary/reader';
import { readCategoryPod, readFeaturedArticleItem, readTagList } from './podReaders';
import { readArrayEnvelope } from './envelopeReaders';
import { ARTICLE_LIST_ITEM_POD_SIZE, RELATED_READING_HEADER_POD_SIZE, RELATED_READING_ITEM_POD_SIZE } from './types';

const ARTICLE_PAGE_CURSOR_ENVELOPE_MAGIC = 0x41535046;
const ARTICLE_PAGE_CURSOR_ENVELOPE_VERSION = 2;
const ARTICLE_DETAIL_V3_MAGIC = 0x41524433;
const ARTICLE_DETAIL_V3_VERSION = 3;
const ARTICLE_DETAIL_V4_MAGIC = 0x41524434;
const ARTICLE_DETAIL_V4_VERSION = 4;
const ARTICLE_DETAIL_V5_MAGIC = 0x41524435;
const ARTICLE_DETAIL_V5_VERSION = 5;
const ARTICLE_DETAIL_V3_HEADER_SIZE = 44;
const ARTICLE_DETAIL_V3_RECORD_SIZE = 84;
const ARTICLE_DETAIL_V4_RECORD_SIZE = 92;
const ARTICLE_DETAIL_V5_RECORD_SIZE = 116;
const ARTICLE_SEARCH_V4_MAGIC = 0x34534146;
const ARTICLE_SEARCH_V4_VERSION = 4;
const ARTICLE_DETAIL_TAG_V3_RECORD_SIZE = 12;
const ARTICLE_RIGHTS_V3_RECORD_SIZE = 112;
const ARTICLE_DETAIL_RIGHTS_KNOWN_FLAGS = (1 << 11) - 1;
const ARTICLE_DETAIL_RIGHTS_FLAG_ENABLED = 1 << 0;
const ARTICLE_DETAIL_RIGHTS_FLAG_ALLOW_CODE_COPY = 1 << 1;
const ARTICLE_DETAIL_RIGHTS_FLAG_SHOW_PUBLIC_BADGE = 1 << 2;
const ARTICLE_DETAIL_RIGHTS_FLAG_PROOF_BINDING_ENABLED = 1 << 3;
const ARTICLE_DETAIL_RIGHTS_FLAG_HAS_COPYRIGHT_YEAR = 1 << 4;
const ARTICLE_DETAIL_RIGHTS_FLAG_HAS_COPYRIGHT_HOLDER = 1 << 5;
const ARTICLE_DETAIL_RIGHTS_FLAG_HAS_RIGHTS_STATEMENT = 1 << 6;
const ARTICLE_DETAIL_RIGHTS_FLAG_HAS_ATTRIBUTION_TEMPLATE = 1 << 7;
const ARTICLE_DETAIL_RIGHTS_FLAG_HAS_CANONICAL_URL = 1 << 8;
const ARTICLE_DETAIL_RIGHTS_FLAG_HAS_PROOF_URL = 1 << 9;
const ARTICLE_DETAIL_RIGHTS_FLAG_HAS_PROOF_STATUS = 1 << 10;

export function mapArticlePageFromPodPayload(payload: Uint8Array): PageResponse<ArticleListItemResponse>
{
    let nextCursor: string | null = null;
    let hasMore = false;
    let total: number;
    let reader: BinaryReader;
    if (payload.byteLength < 8 || readInt32(payload, 0) !== ARTICLE_PAGE_CURSOR_ENVELOPE_MAGIC)
{
        throw createAppError(AppErrorCode.ProtocolFailure, 'article_page_cursor_envelope_missing');
    }

    const version = readInt32(payload, 4);
    if (version === ARTICLE_PAGE_CURSOR_ENVELOPE_VERSION)
{
            reader = new BinaryReader(payload.subarray(8));
            const hasMoreByte = reader.readByte();
            if (hasMoreByte > 1)
{
                throw createAppError(AppErrorCode.ProtocolFailure, 'article_page_cursor_has_more_invalid');
            }
            hasMore = hasMoreByte === 1;
            total = reader.readInt32();
            const cursorBytes = reader.readBlob();
            if (cursorBytes.byteLength > 512)
{
                throw createAppError(AppErrorCode.ProtocolFailure, 'article_page_cursor_length_invalid');
            }
            try
{
                nextCursor = cursorBytes.byteLength === 0 ? null : new TextDecoder('utf-8', { fatal: true }).decode(cursorBytes);
            }
 catch
{
                throw createAppError(AppErrorCode.ProtocolFailure, 'article_page_cursor_utf8_invalid');
            }
            if (nextCursor && !/^[A-Za-z0-9_-]+$/.test(nextCursor))
{
                throw createAppError(AppErrorCode.ProtocolFailure, 'article_page_cursor_format_invalid');
            }
            if (hasMore !== Boolean(nextCursor))
{
                throw createAppError(AppErrorCode.ProtocolFailure, 'article_page_cursor_state_invalid');
            }
        }
 else
{
            throw createAppError(AppErrorCode.ProtocolFailure, 'article_page_cursor_version_invalid');
        }
    const count = readCountChecked(reader, 'article_page_count_invalid');
    const tagRecordCount = readCountChecked(reader, 'article_page_tag_count_invalid');
    const blob = reader.readBlob();
  const itemRecordBytes = reader.remaining() - tagRecordCount * 12;
  const itemRecordSize = count === 0 ? 100 : itemRecordBytes / count;
  if (itemRecordBytes < 0 || (count > 0 && itemRecordBytes % count !== 0) || (itemRecordSize !== 56 && itemRecordSize !== 76 && itemRecordSize !== 100)) {
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
  const currentRevisionIds: string[] = new Array(count).fill('0');
  const revisionNos = new Int32Array(count);
  const currentPublicationIds: Array<string | null> = new Array(count).fill(null);
  const publicationNos: Array<number | null> = new Array(count).fill(null);
  const hasPublicationTail = itemRecordSize >= 76;
  const hasVersionCoordinates = itemRecordSize === 100;

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
    if (hasVersionCoordinates) {
      currentRevisionIds[i] = readInt64String(record, 76);
      revisionNos[i] = readInt32(record, 84);
      const publicationId = readInt64String(record, 88);
      const publicationNo = readInt32(record, 96);
      currentPublicationIds[i] = publicationId === '0' ? null : publicationId;
      publicationNos[i] = publicationNo > 0 ? publicationNo : null;
    }
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
      tags,
      currentRevisionId: currentRevisionIds[i] ?? '0',
      revisionNo: revisionNos[i] ?? 0,
      currentPublicationId: currentPublicationIds[i] ?? null,
      publicationNo: publicationNos[i] ?? null
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

    return {
        items,
        total,
        nextCursor,
        hasMore
    };
}

export function mapArticleSearchFromPodPayload(payload: Uint8Array): PageResponse<ArticleListItemResponse> {
  const magic = payload.byteLength >= 4 ? readInt32(payload, 0) : 0;
  if (payload.byteLength < 24 || (magic !== 0x33525346 && magic !== 0x34525346)) {
    return mapArticleSearchListPayload(payload);
  }

  const version = readInt32(payload, 4);
  if (version !== 3 && version !== 4) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'search_result_version_invalid');
  }

  const total = readInt32(payload, 8);
  const count = readCountChecked(new BinaryReader(payload.subarray(12, 16)), 'article_search_count_invalid');
  const tagOffset = readInt32(payload, 16);
  const blobOffset = readInt32(payload, 20);
  const hasVersionCoordinates = version === 4;
  const itemRecordSize = hasVersionCoordinates ? 76 : 52;
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
      tags,
      currentRevisionId: hasVersionCoordinates ? readInt64String(payload, offset + 52) : '0',
      revisionNo: hasVersionCoordinates ? readInt32(payload, offset + 60) : 0,
      currentPublicationId: hasVersionCoordinates && readInt64String(payload, offset + 64) !== '0'
        ? readInt64String(payload, offset + 64)
        : null,
      publicationNo: hasVersionCoordinates && readInt32(payload, offset + 72) > 0
        ? readInt32(payload, offset + 72)
        : null
    });
  }

  return { items, total };
}

function mapArticleSearchListPayload(payload: Uint8Array): PageResponse<ArticleListItemResponse> {
  const hasVersionCoordinates = payload.byteLength >= 12 && readInt32(payload, 0) === ARTICLE_SEARCH_V4_MAGIC;
  if (hasVersionCoordinates && readInt32(payload, 4) !== ARTICLE_SEARCH_V4_VERSION) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'article_search_version_invalid');
  }
  const reader = new BinaryReader(hasVersionCoordinates ? payload.subarray(8) : payload);
  const count = readCountChecked(reader, 'article_search_count_invalid');
  const items: ArticleListItemResponse[] = [];
  for (let i = 0; i < count; i += 1) {
    const pod = reader.readSpan(ARTICLE_LIST_ITEM_POD_SIZE);
    const tags = readTagList(reader);
    const blob = reader.readBlob();
    const item: ArticleListItemResponse = {
      id: readInt32(pod, 0),
      views: readInt32(pod, 4),
      createTime: readIsoDate64(pod, 8),
      category: readCategoryPod(pod, 16, 20, 128),
      title: readFixedUtf8(pod, 148, 256),
      summary: readBlobText(pod, blob, 404),
      tags,
      currentRevisionId: '0',
      revisionNo: 0,
      currentPublicationId: null,
      publicationNo: null
    };
    if (hasVersionCoordinates) {
      item.currentRevisionId = readInt64String(reader.readSpan(8), 0);
      item.revisionNo = reader.readInt32();
      const publicationId = readInt64String(reader.readSpan(8), 0);
      const publicationNo = reader.readInt32();
      item.currentPublicationId = publicationId === '0' ? null : publicationId;
      item.publicationNo = publicationNo > 0 ? publicationNo : null;
    }
    items.push(item);
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

export function mapRelatedReadingFromPodPayload(payload: Uint8Array): RelatedReadingResponse {
  const reader = new BinaryReader(payload);
  const header = reader.readSpan(RELATED_READING_HEADER_POD_SIZE);
  const relatedCount = readInt32(header, 0);
  const hasPrevious = header[4] ?? 0;
  const hasNext = header[5] ?? 0;
  if (relatedCount < 0 || hasPrevious > 1 || hasNext > 1) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'related_reading_header_invalid');
  }

  const recordCount = relatedCount + hasPrevious + hasNext;
  const records: Uint8Array[] = [];
  for (let i = 0; i < recordCount; i += 1) {
    records.push(reader.readSpan(RELATED_READING_ITEM_POD_SIZE));
  }

  const blob = reader.readBlob();
  if (reader.remaining() !== 0) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'related_reading_trailing_payload_invalid');
  }

  const related: RelatedReadingItemResponse[] = [];
  for (let i = 0; i < relatedCount; i += 1) {
    related.push(readRelatedReadingItem(records[i], blob));
  }

  let optionalIndex = relatedCount;
  const previous = hasPrevious === 1 ? readRelatedReadingItem(records[optionalIndex++], blob) : null;
  const next = hasNext === 1 ? readRelatedReadingItem(records[optionalIndex], blob) : null;
  return { related, previous, next };
}

function readRelatedReadingItem(record: Uint8Array | undefined, blob: Uint8Array): RelatedReadingItemResponse {
  if (!record) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'related_reading_item_missing');
  }

  const hasSummary = record[12] ?? 0;
  if (hasSummary > 1) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'related_reading_summary_flag_invalid');
  }

  return {
    id: readInt32(record, 0),
    createTime: new Date(readInt64Number(record, 4)).toISOString(),
    title: readSliceText(blob, readSliceRef(record, 16)),
    summary: hasSummary === 1 ? readSliceText(blob, readSliceRef(record, 24)) : null,
    reason: readSliceText(blob, readSliceRef(record, 32))
  };
}

export function mapTrashClearResponseFromPodPayload(payload: Uint8Array): TrashClearResponse {
  if (payload.byteLength !== 4) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'trash_clear_payload_invalid');
  }

  return { count: readInt32(payload, 0) };
}

export function mapArticleDetailFromPodPayload(payload: Uint8Array): ArticleDetailResponse {
  if (payload.byteLength < ARTICLE_DETAIL_V3_HEADER_SIZE) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'article_detail_payload_too_short');
  }

  const magic = readInt32(payload, 0);
  const version = readInt32(payload, 4);
  const flags = readInt32(payload, 8);
  const articleRecordOffset = readInt32(payload, 12);
  const articleRecordLength = readInt32(payload, 16);
  const tagOffset = readInt32(payload, 20);
  const tagCount = readInt32(payload, 24);
  const rightsRecordOffset = readInt32(payload, 28);
  const rightsRecordLength = readInt32(payload, 32);
  const blobOffset = readInt32(payload, 36);
  const blobLength = readInt32(payload, 40);
  const isV4 = magic === ARTICLE_DETAIL_V4_MAGIC && version === ARTICLE_DETAIL_V4_VERSION;
  const isV5 = magic === ARTICLE_DETAIL_V5_MAGIC && version === ARTICLE_DETAIL_V5_VERSION;
  const isV3 = magic === ARTICLE_DETAIL_V3_MAGIC && version === ARTICLE_DETAIL_V3_VERSION;
  if (
    (!isV3 && !isV4 && !isV5) ||
    flags !== 0 ||
    tagCount < 0 ||
    articleRecordOffset !== ARTICLE_DETAIL_V3_HEADER_SIZE ||
    articleRecordLength !== (isV5 ? ARTICLE_DETAIL_V5_RECORD_SIZE : isV4 ? ARTICLE_DETAIL_V4_RECORD_SIZE : ARTICLE_DETAIL_V3_RECORD_SIZE) ||
    rightsRecordLength !== ARTICLE_RIGHTS_V3_RECORD_SIZE
  ) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'article_detail_header_invalid');
  }

  const tagBytes = tagCount * ARTICLE_DETAIL_TAG_V3_RECORD_SIZE;
  if (
    tagCount > Math.floor(payload.byteLength / ARTICLE_DETAIL_TAG_V3_RECORD_SIZE) ||
    tagOffset !== articleRecordOffset + articleRecordLength ||
    rightsRecordOffset !== tagOffset + tagBytes ||
    blobOffset !== rightsRecordOffset + rightsRecordLength ||
    blobOffset + blobLength !== payload.byteLength ||
    !isRangeWithin(articleRecordOffset, articleRecordLength, payload.byteLength) ||
    !isRangeWithin(tagOffset, tagBytes, payload.byteLength) ||
    !isRangeWithin(rightsRecordOffset, rightsRecordLength, payload.byteLength) ||
    !isRangeWithin(blobOffset, blobLength, payload.byteLength)
  ) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'article_detail_layout_invalid');
  }

  const article = payload.subarray(articleRecordOffset, articleRecordOffset + articleRecordLength);
  const rightsRecord = payload.subarray(rightsRecordOffset, rightsRecordOffset + rightsRecordLength);
  const blob = payload.subarray(blobOffset, blobOffset + blobLength);
  const sliceOffset = isV5 ? 76 : isV4 ? 52 : 44;
  const isDeletedFlag = article[isV5 ? 72 : isV4 ? 48 : 40] ?? 0;
  if (isDeletedFlag > 1 || !validateArticleDetailRecordSlices(article, blob, sliceOffset)) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'article_detail_record_invalid');
  }

  const tags: ArticleDetailResponse['tags'] = [];
  for (let i = 0; i < tagCount; i += 1) {
    const recordOffset = tagOffset + i * ARTICLE_DETAIL_TAG_V3_RECORD_SIZE;
    const tag = payload.subarray(recordOffset, recordOffset + ARTICLE_DETAIL_TAG_V3_RECORD_SIZE);
    const name = readStrictSliceText(blob, tag, 4, 'article_detail_tag_slice_invalid');
    tags.push({
      id: readInt32(tag, 0),
      name
    });
  }

  const rights = readArticleRightsV3(rightsRecord, blob);

  return {
    id: readInt32(article, 0),
    title: readStrictSliceText(blob, article, sliceOffset, 'article_detail_title_slice_invalid'),
    content: readStrictSliceText(blob, article, sliceOffset + 8, 'article_detail_content_slice_invalid'),
    summary: readStrictSliceText(blob, article, sliceOffset + 16, 'article_detail_summary_slice_invalid'),
    coverImageUrl: readStrictSliceText(blob, article, sliceOffset + 24, 'article_detail_cover_slice_invalid'),
    views: readInt32(article, 4),
    createTime: new Date(readInt64Number(article, 8)).toISOString(),
    category: {
      id: readInt32(article, 16),
      name: readStrictSliceText(blob, article, sliceOffset + 32, 'article_detail_category_slice_invalid')
    },
    tags,
    isDeleted: isDeletedFlag === 1,
    status: readInt32(article, 20) as ArticleDetailResponse['status'],
    scheduledPublishAt: unixMsToIsoOrNull(readInt64Number(article, 24)),
    publishedAt: unixMsToIsoOrNull(readInt64Number(article, 32)),
    updatedAt: isV4 || isV5 ? unixMsToIsoOrNull(readInt64Number(article, 40)) : null,
    currentRevisionId: isV5 ? readInt64String(article, 48) : '0',
    revisionNo: isV5 ? readInt32(article, 56) : 0,
    currentPublicationId: isV5 && readInt64String(article, 60) !== '0' ? readInt64String(article, 60) : null,
    publicationNo: isV5 && readInt32(article, 68) > 0 ? readInt32(article, 68) : null,
    rights
  };
}

function readArticleRightsV3(record: Uint8Array, blob: Uint8Array): ArticleRightsResponse {
  const rightsFlags = readInt32(record, 20);
  const maxExcerptChars = readInt32(record, 28);
  if ((rightsFlags & ~ARTICLE_DETAIL_RIGHTS_KNOWN_FLAGS) !== 0 || maxExcerptChars < 0 || !validateArticleRightsV3RecordSlices(record, blob)) {
    throw createAppError(AppErrorCode.ProtocolFailure, 'article_detail_v3_rights_invalid');
  }

  const snapshotId = readInt64String(record, 0);
  const articleRevisionId = readInt64String(record, 8);
  const revisionNo = readInt32(record, 16);
  const licenseType = readStrictSliceText(blob, record, 32, 'article_detail_v3_rights_license_invalid') || 'all-rights-reserved';
  const copyPolicy = readStrictSliceText(blob, record, 64, 'article_detail_v3_rights_copy_policy_invalid') || 'append-attribution';
  const policyHash = readStrictSliceText(blob, record, 80, 'article_detail_v3_rights_policy_hash_invalid');
  const contentCanonicalHash = readStrictSliceText(blob, record, 88, 'article_detail_v3_rights_content_hash_invalid');

  return {
    snapshotId,
    articleRevisionId,
    revisionNo: Math.max(0, revisionNo),
    enabled: (rightsFlags & ARTICLE_DETAIL_RIGHTS_FLAG_ENABLED) !== 0,
    licenseType,
    copyrightHolder: readOptionalRightsSlice(blob, record, 40, rightsFlags, ARTICLE_DETAIL_RIGHTS_FLAG_HAS_COPYRIGHT_HOLDER, 'article_detail_v3_rights_holder_invalid'),
    copyrightYear: (rightsFlags & ARTICLE_DETAIL_RIGHTS_FLAG_HAS_COPYRIGHT_YEAR) !== 0 ? readInt32(record, 24) : null,
    rightsStatement: readOptionalRightsSlice(blob, record, 48, rightsFlags, ARTICLE_DETAIL_RIGHTS_FLAG_HAS_RIGHTS_STATEMENT, 'article_detail_v3_rights_statement_invalid'),
    attributionTemplate: readOptionalRightsSlice(blob, record, 56, rightsFlags, ARTICLE_DETAIL_RIGHTS_FLAG_HAS_ATTRIBUTION_TEMPLATE, 'article_detail_v3_rights_attribution_invalid'),
    copyPolicy,
    maxExcerptChars,
    allowCodeCopy: (rightsFlags & ARTICLE_DETAIL_RIGHTS_FLAG_ALLOW_CODE_COPY) !== 0,
    showPublicBadge: (rightsFlags & ARTICLE_DETAIL_RIGHTS_FLAG_SHOW_PUBLIC_BADGE) !== 0,
    proofBindingEnabled: (rightsFlags & ARTICLE_DETAIL_RIGHTS_FLAG_PROOF_BINDING_ENABLED) !== 0,
    canonicalUrl: readOptionalRightsSlice(blob, record, 72, rightsFlags, ARTICLE_DETAIL_RIGHTS_FLAG_HAS_CANONICAL_URL, 'article_detail_v3_rights_canonical_invalid'),
    policyHash,
    contentCanonicalHash,
    proofUrl: readOptionalRightsSlice(blob, record, 96, rightsFlags, ARTICLE_DETAIL_RIGHTS_FLAG_HAS_PROOF_URL, 'article_detail_v3_rights_proof_url_invalid'),
    proofStatus: readOptionalRightsSlice(blob, record, 104, rightsFlags, ARTICLE_DETAIL_RIGHTS_FLAG_HAS_PROOF_STATUS, 'article_detail_v3_rights_proof_status_invalid')
  };
}

function validateArticleDetailRecordSlices(record: Uint8Array, blob: Uint8Array, offset: number): boolean {
  return isSliceWithinBlob(blob, record, offset) &&
    isSliceWithinBlob(blob, record, offset + 8) &&
    isSliceWithinBlob(blob, record, offset + 16) &&
    isSliceWithinBlob(blob, record, offset + 24) &&
    isSliceWithinBlob(blob, record, offset + 32);
}

function validateArticleRightsV3RecordSlices(record: Uint8Array, blob: Uint8Array): boolean {
  return isSliceWithinBlob(blob, record, 32) &&
    isSliceWithinBlob(blob, record, 40) &&
    isSliceWithinBlob(blob, record, 48) &&
    isSliceWithinBlob(blob, record, 56) &&
    isSliceWithinBlob(blob, record, 64) &&
    isSliceWithinBlob(blob, record, 72) &&
    isSliceWithinBlob(blob, record, 80) &&
    isSliceWithinBlob(blob, record, 88) &&
    isSliceWithinBlob(blob, record, 96) &&
    isSliceWithinBlob(blob, record, 104);
}

function readOptionalRightsSlice(
  blob: Uint8Array,
  record: Uint8Array,
  offset: number,
  flags: number,
  flag: number,
  errorCode: string
): string | null {
  return (flags & flag) === 0 ? null : readStrictSliceText(blob, record, offset, errorCode);
}

function readStrictSliceText(blob: Uint8Array, record: Uint8Array, offset: number, errorCode: string): string {
  if (!isSliceWithinBlob(blob, record, offset)) {
    throw createAppError(AppErrorCode.ProtocolFailure, errorCode);
  }

  return readSliceText(blob, readSliceRef(record, offset));
}

function isSliceWithinBlob(blob: Uint8Array, record: Uint8Array, offset: number): boolean {
  const slice = readSliceRef(record, offset);
  return isRangeWithin(slice.offset, slice.length, blob.byteLength);
}

function isRangeWithin(offset: number, length: number, total: number): boolean {
  return offset >= 0 && length >= 0 && offset <= total && length <= total - offset;
}

function unixMsToIsoOrNull(value: number): string | null {
  return Number.isFinite(value) && value > 0 ? new Date(value).toISOString() : null;
}
