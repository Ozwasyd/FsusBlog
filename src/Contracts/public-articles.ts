import { ByteView, decodeFixedText, decodeUtf8, ProtocolError } from './binary.ts';
import { WireLayouts as layout, WireLimits } from './wire.generated.ts';

type Taxonomy = { id: number; name: string };
type Coordinates = {
  revision: bigint;
  revisionNo: number;
  publication: bigint;
  publicationNo: number;
};

export type ArticleCard = Coordinates & {
  id: number;
  title: string;
  summary: string;
  createdAt: number;
  updatedAt: number | null;
  publishedAt: number | null;
  scheduledPublishAt: number | null;
  views: number;
  category: Taxonomy;
  tags: Taxonomy[];
};

export type Article = ArticleCard & {
  body: string;
  coverImageUrl: string;
  rights: ArticleRights | null;
};

export type ArticleRights = {
  snapshotId: bigint;
  enabled: boolean;
  allowCodeCopy: boolean;
  showPublicBadge: boolean;
  proofBindingEnabled: boolean;
  licenseType: string;
  copyrightHolder: string;
  copyrightYear: number | null;
  rightsStatement: string;
  attributionTemplate: string;
  copyPolicy: string;
  maxExcerptChars: number;
};

export type ArticlePage = {
  articles: ArticleCard[];
  total: number;
  nextCursor: string | null;
};

const failWire = (field: string): never => { throw new ProtocolError(`Invalid AEDS article ${field}`); };
function requireWire(valid: boolean, field: string): asserts valid {
  if (!valid) failWire(field);
}

function inRange(offset: number, length: number, size: number): boolean {
  return offset >= 0 && length >= 0 && offset <= size && length <= size - offset;
}

const openBytes = (data: Uint8Array) => new ByteView(data, failWire);

function sliceText(record: ByteView, slot: number, blob: ByteView, maxBytes: number = WireLimits.MaxPayloadBytes): string {
  const length = record.i32(slot + 4);
  requireWire(length <= maxBytes, 'text length');
  return decodeUtf8(blob.span(record.i32(slot), length));
}

function fixedText(record: ByteView, offset: number, length: number): string {
  return decodeFixedText(record.span(offset, length), () => new ProtocolError('Invalid AEDS article reserved bytes'));
}

function coordinates(record: ByteView, offset: number): Coordinates {
  const revision = record.i64(offset);
  const revisionNo = record.i32(offset + 8);
  const publication = record.i64(offset + 12);
  const publicationNo = record.i32(offset + 20);
  requireWire(revision > 0n && publication > 0n && revisionNo > 0 && publicationNo > 0, 'publication coordinates');
  return { revision, revisionNo, publication, publicationNo };
}

function card(
  record: ByteView,
  version: Coordinates,
  text: Pick<ArticleCard, 'title' | 'summary' | 'category'>,
  times: Pick<ArticleCard, 'updatedAt' | 'publishedAt' | 'scheduledPublishAt'>,
  tags: Taxonomy[],
): ArticleCard {
  const id = record.i32(layout.ArticleIdOffset);
  const views = record.i32(layout.ArticleViewsOffset);
  requireWire(id > 0 && views >= 0, 'ID or view count');
  requireWire(text.title.length > 0 && !text.title.includes('\0'), 'title');
  return { id, views, createdAt: record.timestamp(layout.ArticleCreatedAtOffset), ...version, ...text, ...times, tags };
}

function validatePublished(record: ByteView, statusOffset: number, publishedAt: number, scheduledAt: number): void {
  requireWire(record.i32(statusOffset) === layout.ArticlePublishedStatus && publishedAt !== 0 && scheduledAt === 0, 'published state');
}

function validateVisibility(record: ByteView, offset: number, reservedBytes: number): void {
  requireWire(record.u8(offset) === 0 && record.u8(offset + 1) <= 1, 'public visibility');
  record.zero(offset + 2, reservedBytes);
}

function tagRecords(payload: ByteView, start: number, count: number, blob: ByteView): Taxonomy[] {
  return Array.from({ length: count }, (_, i) => {
    const record = payload.record(start + i * layout.ArticleTagRecordSize, layout.ArticleTagRecordSize);
    return { id: record.i32(0), name: sliceText(record, 4, blob) };
  });
}

function readRights(record: ByteView, blob: ByteView, article: Coordinates): ArticleRights | null {
  const snapshotId = record.i64(0);
  const flags = record.i32(20);
  const year = record.i32(24);
  const maxExcerptChars = record.i32(28);
  requireWire((flags & ~layout.ArticleRightsKnownFlags) === 0 && maxExcerptChars >= 0, 'rights record');
  const fields: string[] = [];
  for (let field = 32; field < layout.ArticleRightsRecordSize; field += 8) fields.push(sliceText(record, field, blob));
  if (snapshotId === 0n) {
    requireWire(record.i64(8) === 0n && record.i32(16) === 0 && flags === 0 && year === 0 &&
      maxExcerptChars === 0 && fields.every(value => !value), 'empty legacy rights record');
    return null;
  }
  requireWire(snapshotId > 0n && record.i64(8) === article.revision && record.i32(16) === article.revisionNo &&
    Boolean(fields[0]) && Boolean(fields[4]), 'rights snapshot coordinates');
  const has = (flag: number) => (flags & flag) !== 0;
  requireWire(has(16) === (year !== 0) && has(32) === Boolean(fields[1]) && has(64) === Boolean(fields[2]) &&
    has(128) === Boolean(fields[3]) && has(256) === Boolean(fields[5]) && has(512) === Boolean(fields[8]) &&
    has(1024) === Boolean(fields[9]), 'rights presence flags');
  return {
    snapshotId, enabled: has(1), allowCodeCopy: has(2), showPublicBadge: has(4), proofBindingEnabled: has(8),
    copyrightYear: year || null, maxExcerptChars, licenseType: fields[0], copyrightHolder: fields[1],
    rightsStatement: fields[2], attributionTemplate: fields[3], copyPolicy: fields[4],
  };
}

export function decodeArticle(payload: Uint8Array): Article {
  const bytes = openBytes(payload);
  requireWire(bytes.length <= WireLimits.MaxPayloadBytes, 'detail size');
  const recordOffset = bytes.i32(12);
  const recordLength = bytes.i32(16);
  const tagOffset = bytes.i32(20);
  const tagCount = bytes.i32(24);
  const rightsOffset = bytes.i32(28);
  const rightsLength = bytes.i32(32);
  const blobOffset = bytes.i32(36);
  const blobLength = bytes.i32(40);
  requireWire(
    bytes.i32(0) === layout.ArticleDetailV5Magic && bytes.i32(4) === layout.ArticleDetailV5Version &&
      bytes.i32(8) === 0 && recordOffset === layout.ArticleDetailHeaderSize &&
      recordLength === layout.ArticleDetailV5RecordSize && tagCount >= 0 &&
      tagOffset === recordOffset + recordLength &&
      rightsOffset === tagOffset + tagCount * layout.ArticleTagRecordSize &&
      rightsLength === layout.ArticleRightsRecordSize && blobOffset === rightsOffset + rightsLength &&
      inRange(blobOffset, blobLength, bytes.length) && blobOffset + blobLength === bytes.length,
    'detail layout',
  );
  const record = bytes.record(recordOffset, recordLength);
  const blob = bytes.record(blobOffset, blobLength);
  requireWire(record.u8(layout.ArticleDetailDeletedOffset) === 0, 'detail visibility');
  record.zero(layout.ArticleDetailDeletedOffset + 1, 3);
  const publishedAt = record.timestamp(layout.ArticleDetailPublishedAtOffset);
  validatePublished(record, layout.ArticleDetailStatusOffset, publishedAt, record.timestamp(layout.ArticleDetailScheduledAtOffset));
  const tags = tagRecords(bytes, tagOffset, tagCount, blob);
  const result = card(
    record,
    coordinates(record, layout.ArticleDetailCoordinatesOffset),
    {
      title: sliceText(record, layout.ArticleDetailTitleOffset, blob, layout.ArticleSearchTitleBytes),
      summary: sliceText(record, layout.ArticleDetailSummaryOffset, blob),
      category: {
        id: record.i32(layout.ArticleCategoryIdOffset),
        name: sliceText(record, layout.ArticleDetailCategoryOffset, blob),
      },
    },
    { updatedAt: record.timestamp(layout.ArticleDetailUpdatedAtOffset) || null, publishedAt, scheduledPublishAt: null },
    tags,
  );
  return {
    ...result,
    body: sliceText(record, layout.ArticleDetailBodyOffset, blob, WireLimits.BodyBytes),
    coverImageUrl: sliceText(record, layout.ArticleDetailCoverOffset, blob),
    rights: readRights(bytes.record(rightsOffset, rightsLength), blob, result),
  };
}

export function decodeArticleList(payload: Uint8Array): ArticlePage {
  const bytes = openBytes(payload);
  requireWire(
    bytes.length <= WireLimits.MaxPayloadBytes && bytes.i32(0) === layout.ArticleListCursorMagic &&
      bytes.i32(4) === layout.ArticleListCursorVersion,
    'list envelope',
  );
  const cursorFlag = bytes.u8(layout.ArticleListCursorFlagOffset);
  const total = bytes.i32(layout.ArticleListTotalOffset);
  const cursorLength = bytes.i32(layout.ArticleListCursorLengthOffset);
  requireWire(cursorFlag <= 1 && cursorLength <= layout.ArticleListCursorMaxBytes, 'list cursor');
  const cursor = decodeUtf8(bytes.span(layout.ArticleListCursorOffset, cursorLength));
  requireWire(cursorFlag ? /^[A-Za-z0-9_-]+$/.test(cursor) : cursor.length === 0, 'list cursor state');
  const meta = layout.ArticleListCursorOffset + cursorLength;
  const count = bytes.i32(meta);
  const tagCount = bytes.i32(meta + 4);
  const blobLength = bytes.i32(meta + 8);
  const blobOffset = meta + 12;
  const recordsOffset = blobOffset + blobLength;
  const tagOffset = recordsOffset + count * layout.ArticleListRecordSizeCurrent;
  requireWire(
    count >= 0 && total >= count && tagCount >= 0 && inRange(blobOffset, blobLength, bytes.length) &&
      tagOffset + tagCount * layout.ArticleTagRecordSize === bytes.length,
    'list record layout',
  );
  const blob = bytes.record(blobOffset, blobLength);
  const tags = tagRecords(bytes, tagOffset, tagCount, blob);
  const articles: ArticleCard[] = [];
  let consumedTags = 0;
  for (let i = 0; i < count; i += 1) {
    const record = bytes.record(recordsOffset + i * layout.ArticleListRecordSizeCurrent, layout.ArticleListRecordSizeCurrent);
    const tagsStart = record.i32(layout.ArticleListTagStartOffset);
    const tagsLength = record.i32(layout.ArticleListTagCountOffset);
    requireWire(tagsStart === consumedTags && inRange(tagsStart, tagsLength, tagCount), 'list tag range');
    consumedTags += tagsLength;
    validateVisibility(record, layout.ArticleListDeletedOffset, 2);
    const publishedAt = record.timestamp(layout.ArticleListPublishedAtOffset);
    validatePublished(record, layout.ArticleListStatusOffset, publishedAt, record.timestamp(layout.ArticleListScheduledAtOffset));
    articles.push(card(
      record,
      coordinates(record, layout.ArticleListCoordinatesOffset),
      {
        title: sliceText(record, layout.ArticleListTitleOffset, blob, layout.ArticleSearchTitleBytes),
        summary: sliceText(record, layout.ArticleListSummaryOffset, blob),
        category: {
          id: record.i32(layout.ArticleCategoryIdOffset),
          name: sliceText(record, layout.ArticleListCategoryOffset, blob),
        },
      },
      { updatedAt: null, publishedAt, scheduledPublishAt: null },
      tags.slice(tagsStart, consumedTags),
    ));
  }
  requireWire(consumedTags === tagCount, 'unclaimed list tags');
  return { articles, total, nextCursor: cursor || null };
}

export function decodeSearch(payload: Uint8Array): ArticlePage {
  const bytes = openBytes(payload);
  requireWire(
    bytes.length <= WireLimits.MaxPayloadBytes && bytes.i32(0) === layout.ArticleSearchV4Magic &&
      bytes.i32(4) === layout.ArticleSearchV4Version,
    'search layout',
  );
  const count = bytes.i32(8);
  const minimumRecordBytes = layout.ArticleSearchItemPodSize + 8 + layout.ArticlePublicationCoordinateBytes;
  requireWire(count >= 0 && 12 + count * minimumRecordBytes <= bytes.length, 'search count');

  const articles: ArticleCard[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const record = bytes.record(offset, layout.ArticleSearchItemPodSize);
    offset += layout.ArticleSearchItemPodSize;
    validateVisibility(record, layout.ArticleSearchDeletedOffset, 6);
    const tagCount = bytes.i32(offset);
    offset += 4;
    requireWire(inRange(offset, tagCount * layout.ArticleSearchTagPodSize, bytes.length), 'search tag range');
    const tags: Taxonomy[] = [];
    for (let j = 0; j < tagCount; j += 1) {
      const tag = bytes.record(offset, layout.ArticleSearchTagPodSize);
      tags.push({ id: tag.i32(0), name: fixedText(tag, 4, layout.ArticleSearchCategoryBytes) });
      offset += layout.ArticleSearchTagPodSize;
    }
    const length = bytes.i32(offset);
    offset += 4;
    const blob = bytes.record(offset, length);
    offset += length;
    const version = coordinates(bytes, offset);
    offset += layout.ArticlePublicationCoordinateBytes;
    articles.push(card(
      record,
      version,
      {
        title: fixedText(record, layout.ArticleSearchTitleOffset, layout.ArticleSearchTitleBytes),
        summary: sliceText(record, layout.ArticleSearchSummaryOffset, blob),
        category: {
          id: record.i32(layout.ArticleCategoryIdOffset),
          name: fixedText(record, layout.ArticleSearchCategoryOffset, layout.ArticleSearchCategoryBytes),
        },
      },
      { updatedAt: null, publishedAt: null, scheduledPublishAt: null },
      tags,
    ));
  }
  requireWire(offset === bytes.length, 'trailing search data');
  return { articles, total: count, nextCursor: null };
}
