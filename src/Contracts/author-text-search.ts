import { encodeFrame } from './aeds.ts';
import { PodReader, PodWriter, ProtocolError } from './binary.ts';
import { request, siteSessionHeader } from './client.ts';
import { FrameType, WireLimits, WireRoutes } from './wire.generated.ts';

export type AuthorTextSearchRow = Readonly<{
  id: number;
  revision: bigint;
  title: string;
  field: 'title' | 'body';
  snippet: string;
  highlightStart: number;
  highlightEnd: number;
  sourceStart: number;
  sourceEnd: number;
  sourceByteStart: number;
  sourceByteEnd: number;
  sourceDigest: Uint8Array;
}>;

export type AuthorTextSearchPage = Readonly<{ ready: boolean; more: boolean; rows: readonly AuthorTextSearchRow[] }>;
export type AuthorTextRankedQuery = Readonly<{ query: string; cursor: string }>;
export type AuthorTextRankedPage = Readonly<{ ready: boolean; nextCursor: string; rows: readonly AuthorTextSearchRow[] }>;
export type AuthorTextTaxonomyFacet = Readonly<{ id: number; name: string; count: number }>;
export type AuthorTextFacetedPage = Readonly<{
  ready: boolean;
  nextCursor: string;
  total: number;
  stateCounts: readonly [number, number, number, number];
  moreCategories: boolean;
  categories: readonly AuthorTextTaxonomyFacet[];
  moreTags: boolean;
  tags: readonly AuthorTextTaxonomyFacet[];
  rows: readonly AuthorTextSearchRow[];
}>;

const utf8 = new TextEncoder();

export function encodeAuthorTextSearchQuery(query: string): Uint8Array<ArrayBuffer> {
  validateQuery(query);
  const writer = new PodWriter();
  writer.text(query, WireLimits.AuthorTextSearchQueryBytes);
  return encodeFrame(FrameType.AuthorTextSearchQuery, writer.finish());
}

export function authorTextSearch(query: string, session: string, signal: AbortSignal): Promise<AuthorTextSearchPage> {
  return request(WireRoutes.AuthorTextSearch, FrameType.AuthorTextSearchPage, decodeAuthorTextSearchPage, signal, 'POST',
    encodeAuthorTextSearchQuery(query), siteSessionHeader(session));
}

export function decodeAuthorTextSearchPage(payload: Uint8Array): AuthorTextSearchPage {
  const reader = new PodReader(payload);
  const ready = reader.bool();
  const more = reader.bool();
  const count = reader.i32();
  validatePage(ready, more, count);

  const rows: AuthorTextSearchRow[] = [];
  for (let i = 0; i < count; i++) {
    const row = readRow(reader);
    if (i > 0 && row.id >= rows[i - 1].id) throw new ProtocolError('Invalid author text search row');
    rows.push(row);
  }
  reader.finish();
  return { ready, more, rows };
}

export function encodeAuthorTextRankedQuery(value: AuthorTextRankedQuery): Uint8Array<ArrayBuffer> {
  return encodeCursorQuery(value, FrameType.AuthorTextRankedQuery);
}

export function encodeAuthorTextFacetedQuery(value: AuthorTextRankedQuery): Uint8Array<ArrayBuffer> {
  return encodeCursorQuery(value, FrameType.AuthorTextFacetedQuery);
}

function encodeCursorQuery(value: AuthorTextRankedQuery, frameType: FrameType): Uint8Array<ArrayBuffer> {
  validateQuery(value.query);
  validateCursor(value.cursor);
  const writer = new PodWriter();
  writer.text(value.query, WireLimits.AuthorTextSearchQueryBytes);
  writer.text(value.cursor, WireLimits.AuthorTextRankedCursorChars);
  return encodeFrame(frameType, writer.finish());
}

export function decodeAuthorTextRankedQuery(payload: Uint8Array): AuthorTextRankedQuery {
  return decodeCursorQuery(payload);
}

export function decodeAuthorTextFacetedQuery(payload: Uint8Array): AuthorTextRankedQuery {
  return decodeCursorQuery(payload);
}

function decodeCursorQuery(payload: Uint8Array): AuthorTextRankedQuery {
  const reader = new PodReader(payload);
  const query = reader.text(WireLimits.AuthorTextSearchQueryBytes);
  const cursor = reader.text(WireLimits.AuthorTextRankedCursorChars);
  reader.finish();
  validateQuery(query);
  validateCursor(cursor);
  return { query, cursor };
}

export function encodeAuthorTextRankedPage(value: AuthorTextRankedPage): Uint8Array<ArrayBuffer> {
  validateCursor(value.nextCursor);
  validatePage(value.ready, value.nextCursor.length !== 0, value.rows.length);
  const writer = new PodWriter();
  writer.bool(value.ready);
  writer.text(value.nextCursor, WireLimits.AuthorTextRankedCursorChars);
  writer.i32(value.rows.length);
  const ids = new Set<number>();
  for (const row of value.rows) {
    validateRow(row);
    recordRankedId(ids, row.id);
    writeRow(writer, row);
  }
  return encodeFrame(FrameType.AuthorTextRankedPage, writer.finish());
}

export function decodeAuthorTextRankedPage(payload: Uint8Array): AuthorTextRankedPage {
  const reader = new PodReader(payload);
  const ready = reader.bool();
  const nextCursor = reader.text(WireLimits.AuthorTextRankedCursorChars);
  const count = reader.i32();
  validateCursor(nextCursor);
  validatePage(ready, nextCursor.length !== 0, count);
  const rows = readRankedRows(reader, count);
  reader.finish();
  return { ready, nextCursor, rows };
}

export function decodeAuthorTextFacetedPage(payload: Uint8Array): AuthorTextFacetedPage {
  const reader = new PodReader(payload);
  const ready = reader.bool();
  const nextCursor = reader.text(WireLimits.AuthorTextRankedCursorChars);
  const total = reader.i32();
  // Draft, scheduled, published, retracted.
  const stateCounts = [reader.i32(), reader.i32(), reader.i32(), reader.i32()] as const;
  const { more: moreCategories, facets: categories } = readFacets(reader, total);
  const { more: moreTags, facets: tags } = readFacets(reader, total);
  const count = reader.i32();
  validateCursor(nextCursor);
  validatePage(ready, nextCursor.length !== 0, count);
  if (total < count || (!ready && total !== 0) || (nextCursor && total <= WireLimits.AuthorTextSearchRows) ||
      stateCounts.some(value => value < 0) || stateCounts.reduce((sum, value) => sum + value, 0) !== total)
    throw new ProtocolError('Invalid faceted author text search page');
  const rows = readRankedRows(reader, count);
  reader.finish();
  return { ready, nextCursor, total, stateCounts, moreCategories, categories, moreTags, tags, rows };
}

function readFacets(reader: PodReader, total: number) {
  const more = reader.bool();
  const count = reader.i32();
  if (count < 0 || count > WireLimits.AuthorTextSearchFacetRows || (more && count !== WireLimits.AuthorTextSearchFacetRows))
    throw new ProtocolError('Invalid author text search facet count');
  const facets: AuthorTextTaxonomyFacet[] = [];
  const ids = new Set<number>();
  for (let i = 0; i < count; i++) {
    const facet = { id: reader.i32(), name: reader.text(WireLimits.TaxonomyNameBytes), count: reader.i32() };
    const previous = facets[i - 1];
    if (facet.id <= 0 || facet.count <= 0 || facet.count > total || ids.has(facet.id) ||
        !facet.name || facet.name.includes('\0') ||
        (previous && (facet.count > previous.count || (facet.count === previous.count && facet.id <= previous.id))))
      throw new ProtocolError('Invalid author text search facet');
    ids.add(facet.id);
    facets.push(facet);
  }
  return { more, facets };
}

function readRankedRows(reader: PodReader, count: number): AuthorTextSearchRow[] {
  const rows: AuthorTextSearchRow[] = [];
  const ids = new Set<number>();
  for (let i = 0; i < count; i++) {
    const row = readRow(reader);
    recordRankedId(ids, row.id);
    rows.push(row);
  }
  return rows;
}

function readRow(reader: PodReader): AuthorTextSearchRow {
  const id = reader.i32();
  const revision = reader.i64();
  const title = reader.text(WireLimits.TitleBytes);
  const field = reader.i32();
  if (field !== 1 && field !== 2) throw new ProtocolError('Invalid author text search row');
  const snippet = reader.text(WireLimits.AuthorTextSearchSnippetBytes);
  const highlightStart = reader.i32(), highlightEnd = reader.i32();
  const sourceStart = reader.i32(), sourceEnd = reader.i32();
  const sourceByteStart = reader.i32(), sourceByteEnd = reader.i32();
  const sourceDigest = reader.fixedBytes(WireLimits.AuthorTextSearchSourceDigestBytes);
  const row: AuthorTextSearchRow = { id, revision, title, field: field === 1 ? 'title' : 'body', snippet, highlightStart, highlightEnd,
    sourceStart, sourceEnd, sourceByteStart, sourceByteEnd, sourceDigest };
  validateRow(row);
  return row;
}

function writeRow(writer: PodWriter, row: AuthorTextSearchRow) {
  writer.i32(row.id);
  writer.i64(row.revision);
  writer.text(row.title, WireLimits.TitleBytes);
  writer.i32(row.field === 'title' ? 1 : 2);
  writer.text(row.snippet, WireLimits.AuthorTextSearchSnippetBytes);
  writer.i32(row.highlightStart);
  writer.i32(row.highlightEnd);
  writer.i32(row.sourceStart);
  writer.i32(row.sourceEnd);
  writer.i32(row.sourceByteStart);
  writer.i32(row.sourceByteEnd);
  writer.fixedBytes(row.sourceDigest);
}

function validateQuery(query: string) {
  if (query.length > WireLimits.AuthorTextSearchQueryChars)
    throw new ProtocolError('Author text search query exceeds its text limit');
}

function validateCursor(cursor: string) {
  if (cursor.length > WireLimits.AuthorTextRankedCursorChars || /[^A-Za-z0-9_-]/.test(cursor))
    throw new ProtocolError('Invalid author text search cursor');
}

function validatePage(ready: boolean, more: boolean, count: number) {
  if (count < 0 || count > WireLimits.AuthorTextSearchRows || (!ready && (more || count !== 0)) ||
      (more && count !== WireLimits.AuthorTextSearchRows)) throw new ProtocolError('Invalid author text search page');
}

function validateRow(row: AuthorTextSearchRow) {
  const { id, revision, field, snippet, highlightStart, highlightEnd, sourceStart, sourceEnd, sourceByteStart, sourceByteEnd } = row;
  const sourceLimit = field === 'title' ? WireLimits.TitleBytes : WireLimits.BodyBytes;
  if (id <= 0 || revision <= 0n || (field !== 'title' && field !== 'body') ||
      highlightStart < 0 || highlightEnd <= highlightStart || highlightEnd > snippet.length ||
      !isRuneBoundary(snippet, highlightStart) || !isRuneBoundary(snippet, highlightEnd) ||
      sourceStart < 0 || sourceEnd <= sourceStart || sourceEnd > sourceLimit ||
      sourceByteStart < sourceStart || sourceByteEnd <= sourceByteStart || sourceByteEnd > sourceLimit ||
      sourceEnd - sourceStart !== highlightEnd - highlightStart ||
      sourceByteEnd - sourceByteStart !== utf8.encode(snippet.slice(highlightStart, highlightEnd)).length ||
      row.sourceDigest.length !== WireLimits.AuthorTextSearchSourceDigestBytes)
    throw new ProtocolError('Invalid author text search row');
}

function recordRankedId(ids: Set<number>, id: number) {
  if (ids.has(id)) throw new ProtocolError('Invalid author text search row');
  ids.add(id);
}

function isRuneBoundary(text: string, offset: number): boolean {
  if (offset === text.length) return true;
  const value = text.charCodeAt(offset);
  return value < 0xdc00 || value > 0xdfff;
}
