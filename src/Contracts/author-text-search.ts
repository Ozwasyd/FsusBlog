import { encodePod } from './aeds.ts';
import { decodePod, isValidUnixMs, PodReader, PodWriter, ProtocolError, ZERO_UUID } from './binary.ts';
import { sessionPost } from './internal/http.ts';
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

const utf8 = new TextEncoder();
const textFields = ['title', 'body', 'summary', 'heading', 'property-text'] as const;
const queryLimitError = () => new ProtocolError('Author text search query exceeds its frame limit');
const decodeQuery = <T>(payload: Uint8Array, frameLimit: number, read: (r: PodReader) => T): T =>
  decodePod(payload, read, frameLimit - WireHeader.HeaderSize, queryLimitError);

export function encodeAuthorTextSearchQuery(query: string): Uint8Array<ArrayBuffer> {
  validateQuery(query);
  return encodePod(FrameType.AuthorTextSearchQuery, writer => writer.text(query, WireLimits.AuthorTextSearchQueryBytes));
}

export function authorTextSearch(query: string, session: string, signal: AbortSignal): Promise<AuthorTextSearchPage> {
  return sessionPost(WireRoutes.AuthorTextSearch, FrameType.AuthorTextSearchPage, decodeAuthorTextSearchPage, signal,
    encodeAuthorTextSearchQuery(query), session);
}

export function decodeAuthorTextSearchPage(payload: Uint8Array): AuthorTextSearchPage {
  return decodePod(payload, reader => {
    const ready = reader.bool(), more = reader.bool(), count = reader.i32();
    validatePage(ready, more, count);
    const rows: AuthorTextSearchRow[] = [];
    for (let i = 0; i < count; i++) {
      const row = readRow(reader);
      if (i > 0 && row.id >= rows[i - 1].id) throw new ProtocolError('Invalid author text search row');
      rows.push(row);
    }
    return { ready, more, rows };
  });
}

export const encodeAuthorTextRankedQuery = (value: AuthorTextRankedQuery) => encodeCursorQuery(value, FrameType.AuthorTextRankedQuery);
export const encodeAuthorTextFacetedQuery = (value: AuthorTextRankedQuery) => encodeCursorQuery(value, FrameType.AuthorTextFacetedQuery);
export const encodeAuthorTextQualifiedQuery = (value: AuthorTextQualifiedQuery) => encodeQualifiedQuery(value, FrameType.AuthorTextQualifiedQuery);
export const encodeAuthorTextSummaryQuery = (value: AuthorTextQualifiedQuery) => encodeQualifiedQuery(value, FrameType.AuthorTextSummaryQuery);
export const encodeAuthorTextHeadingQuery = (value: AuthorTextQualifiedQuery) => encodeQualifiedQuery(value, FrameType.AuthorTextHeadingQuery);

function encodeQualifiedQuery(value: AuthorTextQualifiedQuery, type: FrameType): Uint8Array<ArrayBuffer> {
  return encodePod(type, writer => writeQualifiedQuery(writer, value, type === FrameType.AuthorTextQualifiedQuery));
}

function writeQualifiedQuery(writer: PodWriter, value: AuthorTextQualifiedQuery, requireQualifier: boolean, propertyFacet = false): void {
  validateQualifiedQuery(value, requireQualifier);
  writer.text(value.query, WireLimits.AuthorTextSearchQueryBytes).text(value.cursor, WireLimits.AuthorTextRankedCursorChars)
    .optional(value.updatedFromUnixMs, (w, v) => w.i64(v)).optional(value.updatedUntilUnixMs, (w, v) => w.i64(v)).i64(value.schema);
  writePropertyConditions(writer, value.schema, value.conditions, propertyFacet ? 'positive' : 'zero');
}

export const decodeAuthorTextQualifiedQuery = (payload: Uint8Array) => decodeQualifiedQuery(payload, true);
export const decodeAuthorTextSummaryQuery = (payload: Uint8Array) => decodeQualifiedQuery(payload, false);
export const decodeAuthorTextHeadingQuery = (payload: Uint8Array) => decodeQualifiedQuery(payload, false);

function decodeQualifiedQuery(payload: Uint8Array, requireQualifier: boolean): DecodedAuthorTextQualifiedQuery {
  return decodeQuery(payload, WireLimits.MaxAuthorTextQualifiedQueryFrameBytes, reader => readQualifiedQuery(reader, requireQualifier));
}

function readQualifiedQuery(reader: PodReader, requireQualifier: boolean, propertyFacet = false): DecodedAuthorTextQualifiedQuery {
  const query = reader.text(WireLimits.AuthorTextSearchQueryBytes);
  const cursor = reader.text(WireLimits.AuthorTextRankedCursorChars);
  const updatedFromUnixMs = reader.optional(r => r.i64());
  const updatedUntilUnixMs = reader.optional(r => r.i64());
  const schema = reader.i64();
  const value = { query, cursor, updatedFromUnixMs, updatedUntilUnixMs, schema,
    conditions: readPropertyConditions(reader, schema, propertyFacet ? 'positive' : 'zero') };
  validateQualifiedQuery(value, requireQualifier);
  return value;
}

function validateQualifiedQuery(
  value: AuthorTextQualifiedQuery | DecodedAuthorTextQualifiedQuery, requireQualifier: boolean,
): void {
  validateQuery(value.query);
  validateCursor(value.cursor);
  const { updatedFromUnixMs: from, updatedUntilUnixMs: until } = value;
  if ((from !== null && !isValidUnixMs(from)) || (until !== null && !isValidUnixMs(until)) ||
      (from !== null && until !== null && from >= until) ||
      (requireQualifier && from === null && until === null && value.conditions.length === 0))
    throw new ProtocolError('Invalid qualified author text search');
}

function encodeCursorQuery(value: AuthorTextRankedQuery, frameType: FrameType): Uint8Array<ArrayBuffer> {
  validateQuery(value.query);
  validateCursor(value.cursor);
  return encodePod(frameType, writer => writer.text(value.query, WireLimits.AuthorTextSearchQueryBytes)
    .text(value.cursor, WireLimits.AuthorTextRankedCursorChars));
}

export const decodeAuthorTextRankedQuery = (payload: Uint8Array) => decodeCursorQuery(payload);
export const decodeAuthorTextFacetedQuery = (payload: Uint8Array) => decodeCursorQuery(payload);

function decodeCursorQuery(payload: Uint8Array): AuthorTextRankedQuery {
  return decodePod(payload, reader => {
    const query = reader.text(WireLimits.AuthorTextSearchQueryBytes);
    const cursor = reader.text(WireLimits.AuthorTextRankedCursorChars);
    validateQuery(query);
    validateCursor(cursor);
    return { query, cursor };
  });
}

export function encodeAuthorTextRankedPage(value: AuthorTextRankedPage): Uint8Array<ArrayBuffer> {
  validateCursor(value.nextCursor);
  validatePage(value.ready, value.nextCursor.length !== 0, value.rows.length);
  return encodePod(FrameType.AuthorTextRankedPage, writer => {
    writer.bool(value.ready).text(value.nextCursor, WireLimits.AuthorTextRankedCursorChars).i32(value.rows.length);
    const ids = new Set<number>();
    for (const row of value.rows) {
      validateRow(row);
      recordRankedId(ids, row.id);
      writeRow(writer, row);
    }
  });
}

export function decodeAuthorTextRankedPage(payload: Uint8Array): AuthorTextRankedPage {
  return decodePod(payload, reader => {
    const ready = reader.bool(), nextCursor = reader.text(WireLimits.AuthorTextRankedCursorChars), count = reader.i32();
    validateCursor(nextCursor);
    validatePage(ready, nextCursor.length !== 0, count);
    return { ready, nextCursor, rows: readRankedRows(reader, count) };
  });
}

export const decodeAuthorTextFacetedPage = (payload: Uint8Array) => decodeFacetedPage(payload, 2);
export const decodeAuthorTextSummaryPage = (payload: Uint8Array) => decodeFacetedPage(payload, 3);
export const decodeAuthorTextHeadingPage = (payload: Uint8Array) => decodeFacetedPage(payload, 4);

const decodeFacetedPage = (payload: Uint8Array, maxField: number) => decodePod(payload, r => readFacetedPage(r, maxField));

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
  return encodePod(FrameType.AuthorTextPropertyFacetQuery, writer => writePropertyFacetQuery(writer, value));
}

export function decodeAuthorTextPropertyFacetQuery(payload: Uint8Array): DecodedAuthorTextPropertyFacetQuery {
  const value = decodeQuery(payload, WireLimits.MaxAuthorTextPropertyFacetQueryFrameBytes, readPropertyFacetQuery);
  validatePropertySelector(value, value.search.schema);
  return value;
}

function readPropertyFacetQuery(reader: PodReader): DecodedAuthorTextPropertyFacetQuery {
  return { search: readQualifiedQuery(reader, false, true), includeHeading: reader.bool(), ...readPropertySelector(reader) };
}

function writePropertyFacetQuery(writer: PodWriter, value: AuthorTextPropertyFacetQuery): void {
  writeQualifiedQuery(writer, value.search, false, true);
  writer.bool(value.includeHeading);
  writePropertySelector(writer, value);
}

const readPropertySelector = (reader: PodReader): AuthorTextPropertyFacetSelector =>
  ({ definitionId: reader.uuid(), definitionRevision: reader.i64() });

const writePropertySelector = (writer: PodWriter, value: AuthorTextPropertyFacetSelector): void => {
  writer.uuid(value.definitionId).i64(value.definitionRevision);
};

function validatePropertySelector(value: AuthorTextPropertyFacetSelector, schema: bigint): void {
  if (value.definitionId === ZERO_UUID || value.definitionRevision <= 0n || value.definitionRevision > schema)
    throw new ProtocolError('Invalid author text property selector');
}

export function decodeAuthorTextPropertyFacetPage(payload: Uint8Array, includeHeading = true): AuthorTextPropertyFacetPage {
  return decodePod(payload, reader => {
    const search = readFacetedPage(reader, includeHeading ? 4 : 3);
    return { search, facet: search.ready ? readPropertyFacet(reader, search.total) : null };
  });
}

export function encodeAuthorTextPropertySortQuery(value: AuthorTextPropertySortQuery): Uint8Array<ArrayBuffer> {
  validatePropertySortQuery(value);
  return encodePod(FrameType.AuthorTextPropertySortQuery, writer => {
    writePropertyFacetQuery(writer, value);
    writer.bool(value.direction === 'descending').optional(value.facet, writePropertySelector);
  });
}

export function decodeAuthorTextPropertySortQuery(payload: Uint8Array): DecodedAuthorTextPropertySortQuery {
  const value = decodeQuery(payload, WireLimits.MaxAuthorTextPropertySortQueryFrameBytes, reader => ({
    ...readPropertyFacetQuery(reader),
    direction: (reader.bool() ? 'descending' : 'ascending') as AuthorTextPropertySortDirection,
    facet: reader.optional(readPropertySelector),
  }));
  validatePropertySortQuery(value);
  return value;
}

function validatePropertySortQuery(value: AuthorTextPropertySortQuery | DecodedAuthorTextPropertySortQuery): void {
  validatePropertySelector(value, value.search.schema);
  if (value.facet !== null) validatePropertySelector(value.facet, value.search.schema);
  if (typeof value.includeHeading !== 'boolean' || (value.direction !== 'ascending' && value.direction !== 'descending'))
    throw new ProtocolError('Invalid author text property sort');
}

export const decodeAuthorTextPropertySortPage = (payload: Uint8Array, includeHeading = true, expectFacet?: boolean) =>
  decodeOptionalPropertyFacetPage(payload, includeHeading ? 4 : 3, expectFacet);

function decodeOptionalPropertyFacetPage(payload: Uint8Array, maxField: number, expectFacet?: boolean): AuthorTextPropertySortPage {
  return decodePod(payload, reader => {
    const search = readFacetedPage(reader, maxField);
    const facet = search.ready && reader.bool() ? readPropertyFacet(reader, search.total) : null;
    if (search.ready && expectFacet !== undefined && expectFacet !== (facet !== null))
      throw new ProtocolError('Invalid author text property sort facet');
    return { search, facet };
  });
}

export function encodeAuthorTextPropertyTextQuery(value: AuthorTextPropertyTextQuery): Uint8Array<ArrayBuffer> {
  validatePropertySelector(value, value.search.schema);
  return encodePod(FrameType.AuthorTextPropertyTextQuery, writer => writePropertyTextSelection(writer, value));
}

export function decodeAuthorTextPropertyTextQuery(payload: Uint8Array): DecodedAuthorTextPropertyTextQuery {
  const value = decodeQuery(payload, WireLimits.MaxAuthorTextPropertyTextQueryFrameBytes, readPropertyTextSelection);
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
  return encodePod(FrameType.AuthorTextPropertyTextQualifiedQuery, writer => {
    writePropertyTextSelection(writer, value);
    writePropertySelectors(writer, value.facet, value.sort);
  });
}

export function decodeAuthorTextPropertyTextQualifiedQuery(payload: Uint8Array): DecodedAuthorTextPropertyTextQualifiedQuery {
  const value = decodeQuery(payload, WireLimits.MaxAuthorTextPropertyTextQualifiedQueryFrameBytes,
    reader => ({ ...readPropertyTextSelection(reader), ...readPropertySelectors(reader) }));
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
  return encodePod(FrameType.AuthorTextPropertyTextMixedQuery, writer => {
    writePropertyTextSelection(writer, value);
    writer.bool(value.includeHeading);
    writePropertySelectors(writer, value.facet, value.sort);
  });
}

export function decodeAuthorTextPropertyTextMixedQuery(payload: Uint8Array): DecodedAuthorTextPropertyTextMixedQuery {
  const value = decodeQuery(payload, WireLimits.MaxAuthorTextPropertyTextMixedQueryFrameBytes,
    reader => ({ ...readPropertyTextSelection(reader), includeHeading: reader.bool(), ...readPropertySelectors(reader) }));
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

const readPropertyTextSelection = (reader: PodReader): DecodedAuthorTextPropertyTextQuery =>
  ({ search: readQualifiedQuery(reader, false, true), ...readPropertySelector(reader) });

function writePropertyTextSelection(writer: PodWriter, value: AuthorTextPropertyTextQuery): void {
  writeQualifiedQuery(writer, value.search, false, true);
  writePropertySelector(writer, value);
}

function writePropertySelectors(writer: PodWriter, facet: AuthorTextPropertyFacetSelector | null, sort: AuthorTextPropertySortSelector | null): void {
  writer.optional(facet, writePropertySelector).optional(sort, (w, s) => {
    writePropertySelector(w, s);
    w.bool(s.direction === 'descending');
  });
}

function readPropertySelectors(reader: PodReader): Pick<AuthorTextPropertyTextQualifiedQuery, 'facet' | 'sort'> {
  return {
    facet: reader.optional(readPropertySelector),
    sort: reader.optional(r => ({ ...readPropertySelector(r), direction: r.bool() ? 'descending' : 'ascending' })),
  };
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
  if (definitionId === ZERO_UUID || definitionRevision <= 0n || missing < 0 || nil < 0 || empty < 0 || remaining < 0 ||
      (kind !== 'boolean' && kind !== 'single-select' && kind !== 'multi-select') ||
      (kind !== 'multi-select' && empty !== 0) ||
      (kind === 'boolean' ? count !== 2 : count < 0 || count > WireLimits.PropertyOptionCount))
    throw new ProtocolError('Invalid author text property facet');

  const buckets: AuthorTextPropertyFacetBucket[] = [];
  let previous = ZERO_UUID;
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
