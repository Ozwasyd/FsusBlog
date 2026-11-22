import { encodeFrame } from './aeds.ts';
import { PodReader, PodWriter, ProtocolError } from './binary.ts';
import { postWithSession } from './internal/http-methods.ts';
import { readPropertyConditions, writePropertyConditions, type PropertyCondition, type PropertyQueryOperand } from './property-query.ts';
import { propertyKinds } from './property-values.ts';
import { FrameType, WireHeader, WireLimits, WireRoutes } from './wire.generated.ts';

export type AuthorTextSearchRow = Readonly<{
  id: number;
  revision: bigint;
  title: string;
  field: 'title' | 'body' | 'summary' | 'heading' | 'property-text';
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
export type AuthorTextQualifiedQuery = AuthorTextRankedQuery & Readonly<{
  updatedFromUnixMs: bigint | null;
  updatedUntilUnixMs: bigint | null;
  schema: bigint;
  conditions: readonly PropertyCondition[];
}>;
export type DecodedAuthorTextQualifiedQuery = Omit<AuthorTextQualifiedQuery, 'conditions'> & Readonly<{
  conditions: readonly PropertyQueryOperand[];
}>;
export type AuthorTextRankedPage = Readonly<{ ready: boolean; nextCursor: string; rows: readonly AuthorTextSearchRow[] }>;
export type AuthorTextTaxonomyFacet = Readonly<{ id: number; name: string; count: number }>;
export type AuthorTextFacetedPage = AuthorTextRankedPage & Readonly<{
  total: number;
  stateCounts: readonly [number, number, number, number];
  moreCategories: boolean;
  categories: readonly AuthorTextTaxonomyFacet[];
  moreTags: boolean;
  tags: readonly AuthorTextTaxonomyFacet[];
}>;

type DecodedPropertyQuery<Query> = Omit<Query, 'search'> & Readonly<{ search: DecodedAuthorTextQualifiedQuery }>;

export type AuthorTextPropertyFacetSelector = Readonly<{ definitionId: string; definitionRevision: bigint }>;
export type AuthorTextPropertyFacetQuery = AuthorTextPropertyFacetSelector & Readonly<{
  search: AuthorTextQualifiedQuery;
  includeHeading: boolean;
}>;
export type DecodedAuthorTextPropertyFacetQuery = DecodedPropertyQuery<AuthorTextPropertyFacetQuery>;
export type AuthorTextPropertyFacetPage = Readonly<{
  search: AuthorTextFacetedPage;
  facet: AuthorTextPropertyFacet | null;
}>;
export type AuthorTextPropertyFacet = Readonly<{
  definitionId: string;
  definitionRevision: bigint;
  kind: 'boolean' | 'single-select' | 'multi-select';
  missing: number;
  null: number;
  empty: number;
  buckets: readonly AuthorTextPropertyFacetBucket[];
}>;
export type AuthorTextPropertyFacetBucket = Readonly<{
  value: Readonly<{ kind: 'boolean'; value: boolean } | { kind: 'single-select'; value: string }>;
  count: number;
}>;

export type AuthorTextPropertySortDirection = 'ascending' | 'descending';
export type AuthorTextPropertySortSelector = AuthorTextPropertyFacetSelector & Readonly<{
  direction: AuthorTextPropertySortDirection;
}>;
export type AuthorTextPropertySortQuery = AuthorTextPropertyFacetQuery & Readonly<{
  direction: AuthorTextPropertySortDirection;
  facet: AuthorTextPropertyFacetSelector | null;
}>;
export type DecodedAuthorTextPropertySortQuery = DecodedPropertyQuery<AuthorTextPropertySortQuery>;
export type AuthorTextPropertySortPage = AuthorTextPropertyFacetPage;

export type AuthorTextPropertyTextQuery = AuthorTextPropertyFacetSelector & Readonly<{ search: AuthorTextQualifiedQuery }>;
export type DecodedAuthorTextPropertyTextQuery = DecodedPropertyQuery<AuthorTextPropertyTextQuery>;

export type AuthorTextPropertyTextQualifiedQuery = AuthorTextPropertyTextQuery & Readonly<{
  facet: AuthorTextPropertyFacetSelector | null;
  sort: AuthorTextPropertySortSelector | null;
}>;
export type DecodedAuthorTextPropertyTextQualifiedQuery = DecodedPropertyQuery<AuthorTextPropertyTextQualifiedQuery>;

export type AuthorTextPropertyTextMixedQuery = AuthorTextPropertyTextQualifiedQuery & Readonly<{ includeHeading: boolean }>;
export type DecodedAuthorTextPropertyTextMixedQuery = DecodedPropertyQuery<AuthorTextPropertyTextMixedQuery>;

const emptyUuid = '00000000-0000-0000-0000-000000000000';
const utf8 = new TextEncoder();
const textFields = ['title', 'body', 'summary', 'heading', 'property-text'] as const;

export function encodeAuthorTextSearchQuery(query: string): Uint8Array<ArrayBuffer> {
  validateQuery(query);
  const writer = new PodWriter();
  writer.text(query, WireLimits.AuthorTextSearchQueryBytes);
  return encodeFrame(FrameType.AuthorTextSearchQuery, writer.finish());
}

export function authorTextSearch(query: string, session: string, signal: AbortSignal): Promise<AuthorTextSearchPage> {
  return postWithSession(WireRoutes.AuthorTextSearch, FrameType.AuthorTextSearchPage, decodeAuthorTextSearchPage, signal,
    encodeAuthorTextSearchQuery(query), session);
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

export function encodeAuthorTextQualifiedQuery(value: AuthorTextQualifiedQuery): Uint8Array<ArrayBuffer> {
  return encodeQualifiedQuery(value, FrameType.AuthorTextQualifiedQuery);
}

export function encodeAuthorTextSummaryQuery(value: AuthorTextQualifiedQuery): Uint8Array<ArrayBuffer> {
  return encodeQualifiedQuery(value, FrameType.AuthorTextSummaryQuery);
}

export function encodeAuthorTextHeadingQuery(value: AuthorTextQualifiedQuery): Uint8Array<ArrayBuffer> {
  return encodeQualifiedQuery(value, FrameType.AuthorTextHeadingQuery);
}

function encodeQualifiedQuery(value: AuthorTextQualifiedQuery, type: FrameType): Uint8Array<ArrayBuffer> {
  const writer = new PodWriter();
  writeQualifiedQuery(writer, value, type === FrameType.AuthorTextQualifiedQuery);
  return encodeFrame(type, writer.finish());
}

function writeQualifiedQuery(writer: PodWriter, value: AuthorTextQualifiedQuery, requireQualifier: boolean, propertyFacet = false): void {
  validateQualifiedQuery(value, requireQualifier);
  writer.text(value.query, WireLimits.AuthorTextSearchQueryBytes);
  writer.text(value.cursor, WireLimits.AuthorTextRankedCursorChars);
  writer.bool(value.updatedFromUnixMs !== null);
  if (value.updatedFromUnixMs !== null) writer.i64(value.updatedFromUnixMs);
  writer.bool(value.updatedUntilUnixMs !== null);
  if (value.updatedUntilUnixMs !== null) writer.i64(value.updatedUntilUnixMs);
  writer.i64(value.schema);
  writePropertyConditions(writer, value.schema, value.conditions, propertyFacet ? 'positive' : 'zero');
}

export function decodeAuthorTextQualifiedQuery(payload: Uint8Array): DecodedAuthorTextQualifiedQuery {
  return decodeQualifiedQuery(payload, true);
}

export function decodeAuthorTextSummaryQuery(payload: Uint8Array): DecodedAuthorTextQualifiedQuery {
  return decodeQualifiedQuery(payload, false);
}

export function decodeAuthorTextHeadingQuery(payload: Uint8Array): DecodedAuthorTextQualifiedQuery {
  return decodeQualifiedQuery(payload, false);
}

function queryReader(payload: Uint8Array, frameLimit: number): PodReader {
  if (payload.length > frameLimit - WireHeader.HeaderSize)
    throw new ProtocolError('Author text search query exceeds its frame limit');
  return new PodReader(payload);
}

function decodeQualifiedQuery(payload: Uint8Array, requireQualifier: boolean): DecodedAuthorTextQualifiedQuery {
  const reader = queryReader(payload, WireLimits.MaxAuthorTextQualifiedQueryFrameBytes);
  const value = readQualifiedQuery(reader, requireQualifier);
  reader.finish();
  return value;
}

function readQualifiedQuery(reader: PodReader, requireQualifier: boolean, propertyFacet = false): DecodedAuthorTextQualifiedQuery {
  const query = reader.text(WireLimits.AuthorTextSearchQueryBytes);
  const cursor = reader.text(WireLimits.AuthorTextRankedCursorChars);
  const updatedFromUnixMs = reader.bool() ? reader.i64() : null;
  const updatedUntilUnixMs = reader.bool() ? reader.i64() : null;
  const schema = reader.i64();
  const conditions = readPropertyConditions(reader, schema, propertyFacet ? 'positive' : 'zero');
  const value = { query, cursor, updatedFromUnixMs, updatedUntilUnixMs, schema, conditions };
  validateQualifiedQuery(value, requireQualifier);
  return value;
}

function validateQualifiedQuery(
  value: AuthorTextQualifiedQuery | DecodedAuthorTextQualifiedQuery, requireQualifier: boolean,
): void {
  validateQuery(value.query);
  validateCursor(value.cursor);
  const { updatedFromUnixMs: from, updatedUntilUnixMs: until } = value;
  const minUnixMs = -62_135_596_800_000n, maxUnixMs = 253_402_300_799_999n;
  if ((from !== null && (from < minUnixMs || from > maxUnixMs)) ||
      (until !== null && (until < minUnixMs || until > maxUnixMs)) ||
      (from !== null && until !== null && from >= until) ||
      (requireQualifier && from === null && until === null && value.conditions.length === 0))
    throw new ProtocolError('Invalid qualified author text search');
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
  return decodeFacetedPage(payload, 2);
}

export function decodeAuthorTextSummaryPage(payload: Uint8Array): AuthorTextFacetedPage {
  return decodeFacetedPage(payload, 3);
}

export function decodeAuthorTextHeadingPage(payload: Uint8Array): AuthorTextFacetedPage {
  return decodeFacetedPage(payload, 4);
}

function decodeFacetedPage(payload: Uint8Array, maxField: number): AuthorTextFacetedPage {
  const reader = new PodReader(payload);
  const page = readFacetedPage(reader, maxField);
  reader.finish();
  return page;
}

function readFacetedPage(reader: PodReader, maxField: number): AuthorTextFacetedPage {
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
  const rows = readRankedRows(reader, count, maxField);
  return { ready, nextCursor, total, stateCounts, moreCategories, categories, moreTags, tags, rows };
}

export function encodeAuthorTextPropertyFacetQuery(value: AuthorTextPropertyFacetQuery): Uint8Array<ArrayBuffer> {
  validatePropertySelector(value, value.search.schema);
  if (typeof value.includeHeading !== 'boolean') throw new ProtocolError('Invalid author text property facet mode');
  const writer = writePropertyFacetQuery(value);
  return encodeFrame(FrameType.AuthorTextPropertyFacetQuery, writer.finish());
}

export function decodeAuthorTextPropertyFacetQuery(payload: Uint8Array): DecodedAuthorTextPropertyFacetQuery {
  const reader = queryReader(payload, WireLimits.MaxAuthorTextPropertyFacetQueryFrameBytes);
  const value = readPropertyFacetQuery(reader);
  reader.finish();
  validatePropertySelector(value, value.search.schema);
  return value;
}

function readPropertyFacetQuery(reader: PodReader): DecodedAuthorTextPropertyFacetQuery {
  const search = readQualifiedQuery(reader, false, true);
  return { search, includeHeading: reader.bool(), ...readPropertySelector(reader) };
}

function writePropertyFacetQuery(value: AuthorTextPropertyFacetQuery): PodWriter {
  const writer = new PodWriter();
  writeQualifiedQuery(writer, value.search, false, true);
  writer.bool(value.includeHeading);
  writePropertySelector(writer, value);
  return writer;
}

function readPropertySelector(reader: PodReader): AuthorTextPropertyFacetSelector {
  return { definitionId: reader.uuid(), definitionRevision: reader.i64() };
}

function writePropertySelector(writer: PodWriter, value: AuthorTextPropertyFacetSelector): void {
  writer.uuid(value.definitionId);
  writer.i64(value.definitionRevision);
}

function validatePropertySelector(value: AuthorTextPropertyFacetSelector, schema: bigint): void {
  if (value.definitionId === emptyUuid || value.definitionRevision <= 0n || value.definitionRevision > schema)
    throw new ProtocolError('Invalid author text property selector');
}

export function decodeAuthorTextPropertyFacetPage(payload: Uint8Array, includeHeading = true): AuthorTextPropertyFacetPage {
  const reader = new PodReader(payload);
  const search = readFacetedPage(reader, includeHeading ? 4 : 3);
  const facet = search.ready ? readPropertyFacet(reader, search.total) : null;
  reader.finish();
  return { search, facet };
}

export function encodeAuthorTextPropertySortQuery(value: AuthorTextPropertySortQuery): Uint8Array<ArrayBuffer> {
  validatePropertySortQuery(value);
  const writer = writePropertyFacetQuery(value);
  writer.bool(value.direction === 'descending');
  writer.bool(value.facet !== null);
  if (value.facet !== null) {
    writer.uuid(value.facet.definitionId);
    writer.i64(value.facet.definitionRevision);
  }
  return encodeFrame(FrameType.AuthorTextPropertySortQuery, writer.finish());
}

export function decodeAuthorTextPropertySortQuery(payload: Uint8Array): DecodedAuthorTextPropertySortQuery {
  const reader = queryReader(payload, WireLimits.MaxAuthorTextPropertySortQueryFrameBytes);
  const fields = readPropertyFacetQuery(reader);
  const direction: AuthorTextPropertySortDirection = reader.bool() ? 'descending' : 'ascending';
  const facet = reader.bool() ? readPropertySelector(reader) : null;
  reader.finish();
  const value = { ...fields, direction, facet };
  validatePropertySortQuery(value);
  return value;
}

function validatePropertySortQuery(value: AuthorTextPropertySortQuery | DecodedAuthorTextPropertySortQuery): void {
  validatePropertySelector(value, value.search.schema);
  if (value.facet !== null) validatePropertySelector(value.facet, value.search.schema);
  if (typeof value.includeHeading !== 'boolean' || (value.direction !== 'ascending' && value.direction !== 'descending'))
    throw new ProtocolError('Invalid author text property sort');
}

export function decodeAuthorTextPropertySortPage(
  payload: Uint8Array, includeHeading = true, expectFacet?: boolean,
): AuthorTextPropertySortPage {
  return decodeOptionalPropertyFacetPage(payload, includeHeading ? 4 : 3, expectFacet);
}

function decodeOptionalPropertyFacetPage(payload: Uint8Array, maxField: number, expectFacet?: boolean): AuthorTextPropertySortPage {
  const reader = new PodReader(payload);
  const search = readFacetedPage(reader, maxField);
  const facet = search.ready && reader.bool() ? readPropertyFacet(reader, search.total) : null;
  reader.finish();
  if (search.ready && expectFacet !== undefined && expectFacet !== (facet !== null))
    throw new ProtocolError('Invalid author text property sort facet');
  return { search, facet };
}

export function encodeAuthorTextPropertyTextQuery(value: AuthorTextPropertyTextQuery): Uint8Array<ArrayBuffer> {
  validatePropertySelector(value, value.search.schema);
  const writer = new PodWriter();
  writePropertyTextSelection(writer, value);
  return encodeFrame(FrameType.AuthorTextPropertyTextQuery, writer.finish());
}

export function decodeAuthorTextPropertyTextQuery(payload: Uint8Array): DecodedAuthorTextPropertyTextQuery {
  const reader = queryReader(payload, WireLimits.MaxAuthorTextPropertyTextQueryFrameBytes);
  const value = readPropertyTextSelection(reader);
  reader.finish();
  validatePropertySelector(value, value.search.schema);
  return value;
}

export function decodeAuthorTextPropertyTextPage(payload: Uint8Array): AuthorTextFacetedPage {
  const page = decodeFacetedPage(payload, 5);
  validatePropertyTextRows(page);
  return page;
}

export function encodeAuthorTextPropertyTextQualifiedQuery(value: AuthorTextPropertyTextQualifiedQuery): Uint8Array<ArrayBuffer> {
  validatePropertyTextQualifiedQuery(value);
  const writer = new PodWriter();
  writePropertyTextSelection(writer, value);
  writePropertySelectors(writer, value.facet, value.sort);
  return encodeFrame(FrameType.AuthorTextPropertyTextQualifiedQuery, writer.finish());
}

export function decodeAuthorTextPropertyTextQualifiedQuery(payload: Uint8Array): DecodedAuthorTextPropertyTextQualifiedQuery {
  const reader = queryReader(payload, WireLimits.MaxAuthorTextPropertyTextQualifiedQueryFrameBytes);
  const value = { ...readPropertyTextSelection(reader), ...readPropertySelectors(reader) };
  reader.finish();
  validatePropertyTextQualifiedQuery(value);
  return value;
}

export function decodeAuthorTextPropertyTextQualifiedPage(payload: Uint8Array, expectFacet: boolean): AuthorTextPropertySortPage {
  const page = decodeOptionalPropertyFacetPage(payload, 5, expectFacet);
  validatePropertyTextRows(page.search);
  return page;
}

export function encodeAuthorTextPropertyTextMixedQuery(value: AuthorTextPropertyTextMixedQuery): Uint8Array<ArrayBuffer> {
  if (typeof value.includeHeading !== 'boolean') throw new ProtocolError('Invalid author text heading mode');
  validatePropertySelector(value, value.search.schema);
  validatePropertySelectors(value.search.schema, value.facet, value.sort);
  const writer = new PodWriter();
  writePropertyTextSelection(writer, value);
  writer.bool(value.includeHeading);
  writePropertySelectors(writer, value.facet, value.sort);
  return encodeFrame(FrameType.AuthorTextPropertyTextMixedQuery, writer.finish());
}

export function decodeAuthorTextPropertyTextMixedQuery(payload: Uint8Array): DecodedAuthorTextPropertyTextMixedQuery {
  const reader = queryReader(payload, WireLimits.MaxAuthorTextPropertyTextMixedQueryFrameBytes);
  const value = { ...readPropertyTextSelection(reader), includeHeading: reader.bool(), ...readPropertySelectors(reader) };
  reader.finish();
  validatePropertySelector(value, value.search.schema);
  validatePropertySelectors(value.search.schema, value.facet, value.sort);
  return value;
}

export function decodeAuthorTextPropertyTextMixedPage(payload: Uint8Array, includeHeading: boolean, expectFacet: boolean): AuthorTextPropertySortPage {
  const page = decodeOptionalPropertyFacetPage(payload, 5, expectFacet);
  if (!includeHeading && page.search.rows.some(row => row.field === 'heading'))
    throw new ProtocolError('Invalid author text heading mode');
  return page;
}

function readPropertyTextSelection(reader: PodReader): DecodedAuthorTextPropertyTextQuery {
  return { search: readQualifiedQuery(reader, false, true), ...readPropertySelector(reader) };
}

function writePropertyTextSelection(writer: PodWriter, value: AuthorTextPropertyTextQuery): void {
  writeQualifiedQuery(writer, value.search, false, true);
  writePropertySelector(writer, value);
}

function writePropertySelectors(writer: PodWriter, facet: AuthorTextPropertyFacetSelector | null, sort: AuthorTextPropertySortSelector | null): void {
  writer.bool(facet !== null);
  if (facet !== null) writePropertySelector(writer, facet);
  writer.bool(sort !== null);
  if (sort !== null) {
    writePropertySelector(writer, sort);
    writer.bool(sort.direction === 'descending');
  }
}

function readPropertySelectors(reader: PodReader): Pick<AuthorTextPropertyTextQualifiedQuery, 'facet' | 'sort'> {
  const facet = reader.bool() ? readPropertySelector(reader) : null;
  const sort: AuthorTextPropertySortSelector | null = reader.bool() ? {
    ...readPropertySelector(reader), direction: reader.bool() ? 'descending' : 'ascending',
  } : null;
  return { facet, sort };
}

function validatePropertyTextQualifiedQuery(value: AuthorTextPropertyTextQualifiedQuery | DecodedAuthorTextPropertyTextQualifiedQuery): void {
  const schema = value.search.schema;
  validatePropertySelector(value, schema);
  if (value.facet === null && value.sort === null) throw new ProtocolError('A property facet or sort is required');
  validatePropertySelectors(schema, value.facet, value.sort);
}

function validatePropertySelectors(schema: bigint, facet: AuthorTextPropertyFacetSelector | null, sort: AuthorTextPropertySortSelector | null): void {
  if (facet !== null) validatePropertySelector(facet, schema);
  if (sort !== null) {
    validatePropertySelector(sort, schema);
    if (sort.direction !== 'ascending' && sort.direction !== 'descending')
      throw new ProtocolError('Invalid author text property sort direction');
  }
}

function validatePropertyTextRows(page: AuthorTextFacetedPage): void {
  if (page.rows.some(row => row.field !== 'property-text'))
    throw new ProtocolError('Invalid author text property search row');
}

function readPropertyFacet(reader: PodReader, total: number): AuthorTextPropertyFacet {
  const definitionId = reader.uuid(), definitionRevision = reader.i64(), kind = propertyKinds[reader.i32()];
  const missing = reader.i32(), nil = reader.i32(), empty = reader.i32(), count = reader.i32();
  const remaining = total - missing - nil - empty;
  if (definitionId === emptyUuid || definitionRevision <= 0n || missing < 0 || nil < 0 || empty < 0 || remaining < 0 ||
      (kind !== 'boolean' && kind !== 'single-select' && kind !== 'multi-select') ||
      (kind !== 'multi-select' && empty !== 0) ||
      (kind === 'boolean' ? count !== 2 : count < 0 || count > WireLimits.PropertyOptionCount))
    throw new ProtocolError('Invalid author text property facet');

  const buckets: AuthorTextPropertyFacetBucket[] = [];
  let previous = emptyUuid;
  let sum = 0;
  for (let index = 0; index < count; index++) {
    let value: AuthorTextPropertyFacetBucket['value'];
    if (kind === 'boolean') {
      const flag = reader.bool();
      if (flag !== (index === 1)) throw new ProtocolError('Invalid author text property facet boolean bucket');
      value = { kind: 'boolean', value: flag };
    } else {
      const option = reader.uuid();
      if (option <= previous) throw new ProtocolError('Invalid author text property facet option bucket');
      previous = option;
      value = { kind: 'single-select', value: option };
    }
    const hits = reader.i32();
    if (hits < 0 || hits > remaining) throw new ProtocolError('Invalid author text property facet count');
    buckets.push({ value, count: hits });
    sum += hits;
  }

  if ((kind === 'boolean' && sum !== remaining) || (kind === 'single-select' && sum > remaining))
    throw new ProtocolError('Invalid author text property facet count');
  return { definitionId, definitionRevision, kind, missing, null: nil, empty, buckets };
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

function readRankedRows(reader: PodReader, count: number, maxField = 2): AuthorTextSearchRow[] {
  const rows: AuthorTextSearchRow[] = [];
  const ids = new Set<number>();
  for (let i = 0; i < count; i++) {
    const row = readRow(reader, maxField);
    recordRankedId(ids, row.id);
    rows.push(row);
  }
  return rows;
}

function readRow(reader: PodReader, maxField = 2): AuthorTextSearchRow {
  const id = reader.i32();
  const revision = reader.i64();
  const title = reader.text(WireLimits.TitleBytes);
  const field = textFields[reader.i32() - 1];
  if (!field) throw new ProtocolError('Invalid author text search row');
  const row: AuthorTextSearchRow = {
    id, revision, title, field, snippet: reader.text(WireLimits.AuthorTextSearchSnippetBytes),
    highlightStart: reader.i32(), highlightEnd: reader.i32(),
    sourceStart: reader.i32(), sourceEnd: reader.i32(),
    sourceByteStart: reader.i32(), sourceByteEnd: reader.i32(),
    sourceDigest: reader.fixedBytes(WireLimits.AuthorTextSearchSourceDigestBytes),
  };
  validateRow(row, maxField);
  return row;
}

function writeRow(writer: PodWriter, row: AuthorTextSearchRow) {
  writer.i32(row.id);
  writer.i64(row.revision);
  writer.text(row.title, WireLimits.TitleBytes);
  writer.i32(textFields.indexOf(row.field) + 1);
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

function validateRow(row: AuthorTextSearchRow, maxField = 2) {
  const { id, revision, field, snippet, highlightStart, highlightEnd, sourceStart, sourceEnd, sourceByteStart, sourceByteEnd } = row;
  const sourceBytes = field === 'property-text' ? WireLimits.PropertyValueBytes :
    field === 'summary' ? WireLimits.ArticleSummaryReadBytes : field === 'title' ? WireLimits.TitleBytes : WireLimits.BodyBytes;
  const sourceChars = field === 'property-text' ? WireLimits.AuthorTextPropertyTextSourceChars :
    field === 'summary' ? WireLimits.ArticleSummaryReadChars : sourceBytes;
  const fieldIndex = textFields.indexOf(field);
  if (id <= 0 || revision <= 0n || fieldIndex < 0 || fieldIndex >= maxField ||
      (field === 'summary' && snippet.length > sourceChars) ||
      highlightStart < 0 || highlightEnd <= highlightStart || highlightEnd > snippet.length ||
      !isRuneBoundary(snippet, highlightStart) || !isRuneBoundary(snippet, highlightEnd) ||
      sourceStart < 0 || sourceEnd <= sourceStart || sourceEnd > sourceChars ||
      sourceByteStart < sourceStart || sourceByteEnd <= sourceByteStart || sourceByteEnd > sourceBytes ||
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
