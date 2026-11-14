import { decodeUtf8, ProtocolError } from './binary.ts';
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

function requireWire(valid: boolean, field: string): asserts valid {
  if (!valid) throw new ProtocolError(`Invalid AEDS article ${field}`);
}

function inRange(offset: number, length: number, size: number): boolean {
  return offset >= 0 && length >= 0 && offset <= size && length <= size - offset;
}

class Bytes {
  private readonly view: DataView;

  private readonly data: Uint8Array;

  constructor(data: Uint8Array) {
    this.data = data;
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get length(): number { return this.data.byteLength; }

  at(offset: number): number {
    requireWire(inRange(offset, 1, this.length), 'byte offset');
    return this.view.getUint8(offset);
  }

  int(offset: number): number {
    requireWire(inRange(offset, 4, this.length), 'int32 offset');
    return this.view.getInt32(offset, true);
  }

  long(offset: number): bigint {
    requireWire(inRange(offset, 8, this.length), 'int64 offset');
    return this.view.getBigInt64(offset, true);
  }

  span(offset: number, length: number): Uint8Array {
    requireWire(inRange(offset, length, this.length), 'byte slice');
    return this.data.subarray(offset, offset + length);
  }

  record(offset: number, length: number): Bytes {
    return new Bytes(this.span(offset, length));
  }

  reserved(offset: number, length: number): void {
    requireWire(this.span(offset, length).every(byte => byte === 0), 'reserved bytes');
  }

  timestamp(offset: number): number {
    const value = this.long(offset);
    requireWire(value >= -62135596800000n && value <= 253402300799999n, 'timestamp');
    return Number(value);
  }
}

function sliceText(record: Bytes, slot: number, blob: Bytes, maxBytes: number = WireLimits.MaxPayloadBytes): string {
  const length = record.int(slot + 4);
  requireWire(length <= maxBytes, 'text length');
  return decodeUtf8(blob.span(record.int(slot), length));
}

function fixedText(record: Bytes, offset: number, length: number): string {
  const bytes = record.span(offset, length);
  const terminator = bytes.indexOf(0);
  if (terminator < 0) return decodeUtf8(bytes);
  record.reserved(offset + terminator, length - terminator);
  return decodeUtf8(bytes.subarray(0, terminator));
}

function coordinates(record: Bytes, offset: number): Coordinates {
  const revision = record.long(offset);
  const revisionNo = record.int(offset + 8);
  const publication = record.long(offset + 12);
  const publicationNo = record.int(offset + 20);
  requireWire(revision > 0n && publication > 0n && revisionNo > 0 && publicationNo > 0, 'publication coordinates');
  return { revision, revisionNo, publication, publicationNo };
}

function card(
  record: Bytes,
  version: Coordinates,
  text: Pick<ArticleCard, 'title' | 'summary' | 'category'>,
  times: Pick<ArticleCard, 'updatedAt' | 'publishedAt' | 'scheduledPublishAt'>,
  tags: Taxonomy[],
): ArticleCard {
  const id = record.int(layout.ArticleIdOffset);
  const views = record.int(layout.ArticleViewsOffset);
  requireWire(id > 0 && views >= 0, 'ID or view count');
  requireWire(text.title.length > 0 && !text.title.includes('\0'), 'title');
  return { id, views, createdAt: record.timestamp(layout.ArticleCreatedAtOffset), ...version, ...text, ...times, tags };
}

function validatePublished(record: Bytes, statusOffset: number, publishedAt: number, scheduledAt: number): void {
  requireWire(record.int(statusOffset) === layout.ArticlePublishedStatus && publishedAt !== 0 && scheduledAt === 0, 'published state');
}

function validateVisibility(record: Bytes, offset: number, reservedBytes: number): void {
  requireWire(record.at(offset) === 0 && record.at(offset + 1) <= 1, 'public visibility');
  record.reserved(offset + 2, reservedBytes);
}

function tagRecords(payload: Bytes, start: number, count: number, blob: Bytes): Taxonomy[] {
  const tags: Taxonomy[] = [];
  for (let i = 0; i < count; i += 1) {
    const record = payload.record(start + i * layout.ArticleTagRecordSize, layout.ArticleTagRecordSize);
    tags.push({ id: record.int(0), name: sliceText(record, 4, blob) });
  }
  return tags;
}

function readRights(record: Bytes, blob: Bytes, article: Coordinates): ArticleRights | null {
  const snapshotId = record.long(0);
  const flags = record.int(20);
  const year = record.int(24);
  const maxExcerptChars = record.int(28);
  requireWire((flags & ~layout.ArticleRightsKnownFlags) === 0 && maxExcerptChars >= 0, 'rights record');
  const fields: string[] = [];
  for (let field = 32; field < layout.ArticleRightsRecordSize; field += 8) {
    fields.push(sliceText(record, field, blob));
  }
  if (snapshotId === 0n) {
    requireWire(record.long(8) === 0n && record.int(16) === 0 && flags === 0 && year === 0 &&
      maxExcerptChars === 0 && fields.every(value => !value), 'empty legacy rights record');
    return null;
  }
  requireWire(snapshotId > 0n && record.long(8) === article.revision && record.int(16) === article.revisionNo &&
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
  const bytes = new Bytes(payload);
  requireWire(bytes.length <= WireLimits.MaxPayloadBytes, 'detail size');
  const recordOffset = bytes.int(12);
  const recordLength = bytes.int(16);
  const tagOffset = bytes.int(20);
  const tagCount = bytes.int(24);
  const rightsOffset = bytes.int(28);
  const rightsLength = bytes.int(32);
  const blobOffset = bytes.int(36);
  const blobLength = bytes.int(40);
  requireWire(
    bytes.int(0) === layout.ArticleDetailV5Magic && bytes.int(4) === layout.ArticleDetailV5Version &&
      bytes.int(8) === 0 && recordOffset === layout.ArticleDetailHeaderSize &&
      recordLength === layout.ArticleDetailV5RecordSize && tagCount >= 0 &&
      tagOffset === recordOffset + recordLength &&
      rightsOffset === tagOffset + tagCount * layout.ArticleTagRecordSize &&
      rightsLength === layout.ArticleRightsRecordSize && blobOffset === rightsOffset + rightsLength &&
      inRange(blobOffset, blobLength, bytes.length) && blobOffset + blobLength === bytes.length,
    'detail layout',
  );
  const record = bytes.record(recordOffset, recordLength);
  const blob = bytes.record(blobOffset, blobLength);
  requireWire(record.at(layout.ArticleDetailDeletedOffset) === 0, 'detail visibility');
  record.reserved(layout.ArticleDetailDeletedOffset + 1, 3);
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
        id: record.int(layout.ArticleCategoryIdOffset),
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
  const bytes = new Bytes(payload);
  requireWire(
    bytes.length <= WireLimits.MaxPayloadBytes && bytes.int(0) === layout.ArticleListCursorMagic &&
      bytes.int(4) === layout.ArticleListCursorVersion,
    'list envelope',
  );
  const cursorFlag = bytes.at(layout.ArticleListCursorFlagOffset);
  const total = bytes.int(layout.ArticleListTotalOffset);
  const cursorLength = bytes.int(layout.ArticleListCursorLengthOffset);
  requireWire(cursorFlag <= 1 && cursorLength <= layout.ArticleListCursorMaxBytes, 'list cursor');
  const cursor = decodeUtf8(bytes.span(layout.ArticleListCursorOffset, cursorLength));
  requireWire(cursorFlag ? /^[A-Za-z0-9_-]+$/.test(cursor) : cursor.length === 0, 'list cursor state');
  const meta = layout.ArticleListCursorOffset + cursorLength;
  const count = bytes.int(meta);
  const tagCount = bytes.int(meta + 4);
  const blobLength = bytes.int(meta + 8);
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
    const tagsStart = record.int(layout.ArticleListTagStartOffset);
    const tagsLength = record.int(layout.ArticleListTagCountOffset);
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
          id: record.int(layout.ArticleCategoryIdOffset),
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
  const bytes = new Bytes(payload);
  requireWire(
    bytes.length <= WireLimits.MaxPayloadBytes && bytes.int(0) === layout.ArticleSearchV4Magic &&
      bytes.int(4) === layout.ArticleSearchV4Version,
    'search layout',
  );
  const count = bytes.int(8);
  const minimumRecordBytes = layout.ArticleSearchItemPodSize + 8 + layout.ArticlePublicationCoordinateBytes;
  requireWire(count >= 0 && 12 + count * minimumRecordBytes <= bytes.length, 'search count');

  const articles: ArticleCard[] = [];
  let offset = 12;
  for (let i = 0; i < count; i += 1) {
    const record = bytes.record(offset, layout.ArticleSearchItemPodSize);
    offset += layout.ArticleSearchItemPodSize;
    validateVisibility(record, layout.ArticleSearchDeletedOffset, 6);
    const tagCount = bytes.int(offset);
    offset += 4;
    requireWire(inRange(offset, tagCount * layout.ArticleSearchTagPodSize, bytes.length), 'search tag range');
    const tags: Taxonomy[] = [];
    for (let j = 0; j < tagCount; j += 1) {
      const tag = bytes.record(offset, layout.ArticleSearchTagPodSize);
      tags.push({ id: tag.int(0), name: fixedText(tag, 4, layout.ArticleSearchCategoryBytes) });
      offset += layout.ArticleSearchTagPodSize;
    }
    const length = bytes.int(offset);
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
          id: record.int(layout.ArticleCategoryIdOffset),
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
