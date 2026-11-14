import { decodeUtf8, ProtocolError } from './binary.ts';
import { request } from './client.ts';
import { FrameType, WireLayouts as layout, WireLimits, WireRoutes } from './wire.generated.ts';

export type RelatedItem = {
  id: number;
  createdAt: number;
  title: string;
  summary: string | null;
  reason: string;
};

export type RelatedReading = {
  related: RelatedItem[];
  previous: RelatedItem | null;
  next: RelatedItem | null;
};

function requireWire(valid: boolean, field: string): asserts valid {
  if (!valid) throw new ProtocolError(`Invalid related reading ${field}`);
}

export function decodeRelatedReading(payload: Uint8Array): RelatedReading {
  requireWire(payload.length >= layout.RelatedReadingHeaderSize + 4, 'header');
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  const int = (offset: number) => view.getInt32(offset, true);
  const relatedCount = int(0);
  const previous = view.getUint8(layout.RelatedReadingPreviousOffset);
  const next = view.getUint8(layout.RelatedReadingNextOffset);
  requireWire(relatedCount >= 0 && relatedCount <= WireLimits.RelatedReadingMaxItems &&
    previous <= 1 && next <= 1 && view.getUint16(6, true) === 0, 'header flags');
  const count = relatedCount + previous + next;
  const blobLengthAt = layout.RelatedReadingHeaderSize + count * layout.RelatedReadingItemSize;
  const blobAt = blobLengthAt + 4;
  requireWire(blobAt <= payload.length, 'item region');
  const blobLength = int(blobLengthAt);
  requireWire(blobLength >= 0 && blobLength === payload.length - blobAt, 'blob length');

  let consumed = 0;
  function text(field: number, limit: number) {
    const start = int(field);
    const length = int(field + 4);
    requireWire(start === consumed && length >= 0 && length <= limit && length <= blobLength - consumed, 'text range');
    consumed += length;
    return decodeUtf8(payload.subarray(blobAt + start, blobAt + consumed));
  }

  const items: RelatedItem[] = [];
  for (let index = 0; index < count; index++) {
    const row = layout.RelatedReadingHeaderSize + index * layout.RelatedReadingItemSize;
    const id = int(row);
    const time = view.getBigInt64(row + layout.RelatedReadingItemCreatedAtOffset, true);
    const flag = view.getUint8(row + layout.RelatedReadingItemHasSummaryOffset);
    const summaryAt = row + layout.RelatedReadingItemSummaryOffset;
    requireWire(id > 0 && time >= -62135596800000n && time <= 253402300799999n &&
      flag <= 1 && payload.subarray(row + layout.RelatedReadingItemHasSummaryOffset + 1, row + layout.RelatedReadingItemTitleOffset).every(byte => byte === 0) &&
      (flag === 1 || (int(summaryAt) === 0 && int(summaryAt + 4) === 0)), 'item header');
    const title = text(row + layout.RelatedReadingItemTitleOffset, WireLimits.TitleBytes);
    const summary = flag === 1 ? text(summaryAt, WireLimits.RelatedReadingMaxTextBytes) : null;
    const reason = text(row + layout.RelatedReadingItemReasonOffset, WireLimits.RelatedReadingMaxTextBytes);
    requireWire(title.length > 0 && reason.length > 0, 'item content');
    items.push({ id, createdAt: Number(time), title, summary, reason });
  }

  const related = items.slice(0, relatedCount);
  requireWire(consumed === blobLength && new Set(related.map(item => item.id)).size === related.length, 'trailing data or duplicate related item');
  const previousItem = previous ? items[relatedCount] : null;
  const nextItem = next ? items[relatedCount + previous] : null;
  requireWire(previousItem === null || nextItem === null || previousItem.id !== nextItem.id, 'previous and next identity');
  return { related, previous: previousItem, next: nextItem };
}

export function publicRelatedReading(articleId: number, publication: bigint, signal: AbortSignal) {
  requireWire(Number.isInteger(articleId) && articleId > 0 && articleId <= 0x7fffffff, 'article ID');
  requireWire(publication > 0n && BigInt.asIntN(64, publication) === publication, 'publication');
  const path = WireRoutes.PublicRelatedReading.replace('{articleId:int}', String(articleId)) + `?publication=${publication}`;
  return request(path, FrameType.ArticleRelatedReading, payload => {
    const reading = decodeRelatedReading(payload);
    requireWire(![...reading.related, reading.previous, reading.next].some(item => item?.id === articleId), 'source identity');
    return reading;
  }, signal);
}
