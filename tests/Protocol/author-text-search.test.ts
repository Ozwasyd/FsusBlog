import { deepEqual, equal, throws } from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import {
  decodeAuthorTextFacetedPage, decodeAuthorTextFacetedQuery, encodeAuthorTextFacetedQuery,
  decodeAuthorTextQualifiedQuery, encodeAuthorTextQualifiedQuery, type AuthorTextQualifiedQuery,
  decodeAuthorTextRankedPage, decodeAuthorTextRankedQuery, decodeAuthorTextSearchPage,
  decodeAuthorTextSummaryPage, decodeAuthorTextSummaryQuery, encodeAuthorTextSummaryQuery,
  decodeAuthorTextHeadingPage, decodeAuthorTextHeadingQuery, encodeAuthorTextHeadingQuery,
  decodeAuthorTextPropertyFacetPage, decodeAuthorTextPropertyFacetQuery, encodeAuthorTextPropertyFacetQuery,
  type AuthorTextPropertyFacetQuery,
  decodeAuthorTextPropertySortPage, decodeAuthorTextPropertySortQuery, encodeAuthorTextPropertySortQuery,
  type AuthorTextPropertySortQuery,
  decodeAuthorTextPropertyTextPage, decodeAuthorTextPropertyTextQuery, encodeAuthorTextPropertyTextQuery,
  type AuthorTextPropertyTextQuery,
  encodeAuthorTextRankedPage, encodeAuthorTextRankedQuery, type AuthorTextSearchRow, type AuthorTextTaxonomyFacet,
} from '../../src/Contracts/author-text-search.ts';
import type { FilterField } from '../../src/Contracts/property-query.ts';
import { FrameType, WireHeader, WireLimits } from '../../src/Contracts/wire.generated.ts';

const row: AuthorTextSearchRow = {
  id: 4, revision: 23n, title: 'Harbor', field: 'body', snippet: 'a 🧭 b',
  highlightStart: 2, highlightEnd: 4, sourceStart: 12, sourceEnd: 14,
  sourceByteStart: 14, sourceByteEnd: 18, sourceDigest: new Uint8Array(32).fill(71),
};

test('ranked requests preserve exact query text and bound the cursor', () => {
  const query = { query: 'field.title:港 "blue orbit"', cursor: 'AZ_-09' };
  const payload = decodeFrame(encodeAuthorTextRankedQuery(query), FrameType.AuthorTextRankedQuery).payload;
  deepEqual(decodeAuthorTextRankedQuery(payload), query);
  equal(Buffer.from(payload).toString('hex'), '1c0000006669656c642e7469746c653ae6b8af2022626c7565206f726269742206000000415a5f2d3039');
  for (const cursor of ['bad\n', 'with=', '港', 'a'.repeat(WireLimits.AuthorTextRankedCursorChars + 1)])
    throws(() => encodeAuthorTextRankedQuery({ ...query, cursor }), ProtocolError);
});

test('ranked pages carry relevance order while the old page still requires decreasing IDs', () => {
  const page = { ready: true, nextCursor: '', rows: [row, { ...row, id: 17 }] };
  const bytes = decodeFrame(encodeAuthorTextRankedPage(page), FrameType.AuthorTextRankedPage).payload;
  deepEqual(decodeAuthorTextRankedPage(bytes), page);
  const legacy = Buffer.concat([Uint8Array.of(1, 0), bytes.subarray(5)]);
  throws(() => decodeAuthorTextSearchPage(legacy), ProtocolError);

  const firstRowOffset = 9;
  const rowLength = (bytes.length - firstRowOffset) / 2;
  const duplicate = Buffer.from(bytes);
  duplicate.writeInt32LE(row.id, firstRowOffset + rowLength);
  throws(() => decodeAuthorTextRankedPage(duplicate), ProtocolError);
  throws(() => encodeAuthorTextRankedPage({ ...page, nextCursor: 'cursor' }), ProtocolError);
  throws(() => encodeAuthorTextRankedPage({ ...page, ready: false }), ProtocolError);
});

test('faceted requests have the same payload as ranked requests and a distinct frame', () => {
  const query = { query: 'field.title:港 "blue orbit"', cursor: 'AZ_-09' };
  const ranked = decodeFrame(encodeAuthorTextRankedQuery(query), FrameType.AuthorTextRankedQuery).payload;
  const faceted = decodeFrame(encodeAuthorTextFacetedQuery(query), FrameType.AuthorTextFacetedQuery).payload;
  equal(FrameType.AuthorTextFacetedQuery, 33013);
  equal(FrameType.AuthorTextFacetedPage, 33014);
  deepEqual(faceted, ranked);
  deepEqual(decodeAuthorTextFacetedQuery(faceted), query);
  throws(() => decodeAuthorTextFacetedQuery(Buffer.concat([faceted, Uint8Array.of(0)])), ProtocolError);
  throws(() => encodeAuthorTextFacetedQuery({ ...query, cursor: 'a\r' }), ProtocolError);
});

const dateProperty: FilterField = {
  id: '11111111-1111-4111-8111-111111111111', revision: 2n, machineKey: 'date', label: 'Date',
  kind: 'date', enabled: true, deprecated: false, options: [],
};
const numberProperty: FilterField = {
  ...dateProperty, id: '12345678-1234-4000-9000-123456789abc', revision: 3n, kind: 'number',
};
const qualified: AuthorTextQualifiedQuery = {
  query: '港', cursor: '_', updatedFromUnixMs: -1n, updatedUntilUnixMs: 0n, schema: 10n,
  conditions: [
    { field: dateProperty, comparison: 'at-most', value: { kind: 'date', value: '2024-02-29T14:12:06.015Z' } },
    { field: numberProperty, comparison: 'at-least', value: { kind: 'number', value: '-9007199254740993.000000000001' } },
  ],
};

test('qualified query keeps existing typed operand bytes and signed UTC milliseconds', () => {
  // Packed independently using network-order UUIDs and little-endian lengths and integers.
  const golden = Buffer.from(
    '03000000e6b8af010000005f01ffffffffffffffff0100000000000000000a0000000000000002000000' +
    '111111111111411181111111111111110200000000000000020000000300000018000000323032342d30322d32395431343a31323a30362e3031355a' +
    '12345678123440009000123456789abc030000000000000004000000010000001e0000002d393030373139393235343734303939332e303030303030303030303031',
    'hex');
  const { payload } = decodeFrame(encodeAuthorTextQualifiedQuery(qualified), FrameType.AuthorTextQualifiedQuery);
  equal(FrameType.AuthorTextQualifiedQuery, 33015);
  deepEqual(Buffer.from(payload), golden);
  deepEqual(decodeAuthorTextQualifiedQuery(golden), {
    ...qualified,
    conditions: qualified.conditions.map(({ field, ...value }) =>
      ({ definitionId: field.id, definitionRevision: field.revision, ...value })),
  });
  throws(() => decodeAuthorTextFacetedQuery(golden), ProtocolError);
  for (const [offset, value] of [[12, 2], [21, 2], [30, 0], [38, 5], [66, 9], [70, 253]]) {
    const changed = Buffer.from(golden);
    changed[offset] = value;
    if (offset === 70) changed.fill(255, 71, 74); // Unavailable is a response-only value.
    throws(() => decodeAuthorTextQualifiedQuery(changed), ProtocolError);
  }
  throws(() => decodeAuthorTextQualifiedQuery(golden.subarray(0, -1)), ProtocolError);
  throws(() => decodeAuthorTextQualifiedQuery(Buffer.concat([golden, Uint8Array.of(0)])), ProtocolError);
  throws(() => decodeAuthorTextQualifiedQuery(
    new Uint8Array(WireLimits.MaxAuthorTextQualifiedQueryFrameBytes - WireHeader.HeaderSize + 1)), ProtocolError);
});

test('qualified query requires bounded dates or properties and accepts open ends', () => {
  const min = -62_135_596_800_000n, max = 253_402_300_799_999n;
  const dateOnly = { ...qualified, updatedFromUnixMs: min, updatedUntilUnixMs: max, schema: 0n, conditions: [] };
  for (const value of [dateOnly, { ...dateOnly, updatedUntilUnixMs: null }, { ...dateOnly, updatedFromUnixMs: null }]) {
    const { payload } = decodeFrame(encodeAuthorTextQualifiedQuery(value), FrameType.AuthorTextQualifiedQuery);
    deepEqual(decodeAuthorTextQualifiedQuery(payload), value);
  }

  const condition = qualified.conditions[0];
  const propertyOnly = { ...qualified, updatedFromUnixMs: null, updatedUntilUnixMs: null, conditions: [condition] };
  equal(decodeAuthorTextQualifiedQuery(decodeFrame(encodeAuthorTextQualifiedQuery(propertyOnly)).payload).conditions.length, 1);
  for (const value of [
    { ...dateOnly, updatedFromUnixMs: min - 1n },
    { ...dateOnly, updatedUntilUnixMs: max + 1n },
    { ...dateOnly, updatedFromUnixMs: max },
    { ...dateOnly, updatedFromUnixMs: max, updatedUntilUnixMs: min },
    { ...dateOnly, schema: 1n }, { ...propertyOnly, schema: 0n }, { ...propertyOnly, schema: 1n },
    { ...propertyOnly, schema: 0n, conditions: [] },
    { ...qualified, conditions: [condition, condition] },
    { ...qualified, conditions: Array.from({ length: 5 }, () => condition) },
    { ...qualified, cursor: 'a=' },
  ]) throws(() => encodeAuthorTextQualifiedQuery(value), ProtocolError);
});

test('qualified conditions reuse all eight typed values and preserve alternatives and absence', () => {
  const items: AuthorTextQualifiedQuery['conditions'] = [
    { field: { ...dateProperty, kind: 'text' }, comparison: 'equal', value: { kind: 'text', value: '港口' } },
    qualified.conditions[1],
    { field: { ...dateProperty, kind: 'boolean' }, comparison: 'equal', value: { kind: 'boolean', value: false } },
    qualified.conditions[0],
    { field: { ...dateProperty, kind: 'single-select' }, comparison: 'equal', value: { kind: 'single-select', value: dateProperty.id } },
    { field: { ...dateProperty, kind: 'multi-select' }, comparison: 'multi-select-any-of', value: { kind: 'multi-select', value: [] } },
    { field: { ...dateProperty, kind: 'article-reference' }, comparison: 'reference-any-of',
      value: { kind: 'article-reference', value: [83, 14] } },
    { field: { ...dateProperty, kind: 'url' }, comparison: 'equal', value: { kind: 'url', value: 'https://example.com/' } },
    { field: dateProperty, comparison: 'equal', value: { kind: 'null' } },
    { field: numberProperty, comparison: 'is-present', value: { kind: 'missing' } },
  ];
  for (let offset = 0; offset < items.length; offset += 4) {
    const conditions = items.slice(offset, offset + 4).map(({ field, ...condition }, index) => ({
      ...condition, field: { ...field, id: `12345678-1234-4000-9000-123456789ab${index}` },
    }));
    const { payload } = decodeFrame(encodeAuthorTextQualifiedQuery({ ...qualified, conditions }));
    deepEqual(decodeAuthorTextQualifiedQuery(payload).conditions.map(({ value }) => value), conditions.map(({ value }) => value));
  }
});

test('summary search accepts omitted qualifiers under its own request discriminator', () => {
  const query = { query: 'harbor', cursor: '', updatedFromUnixMs: null, updatedUntilUnixMs: null, schema: 0n, conditions: [] };
  const frame = encodeAuthorTextSummaryQuery(query);
  const { payload } = decodeFrame(frame, FrameType.AuthorTextSummaryQuery);
  equal(FrameType.AuthorTextSummaryQuery, 33018);
  equal(Buffer.from(payload).toString('hex'), '06000000686172626f72' + '00000000' + '0000' + '0000000000000000' + '00000000');
  deepEqual(decodeAuthorTextSummaryQuery(payload), query);
  throws(() => decodeFrame(frame, FrameType.AuthorTextQualifiedQuery), ProtocolError);
  throws(() => decodeAuthorTextQualifiedQuery(payload), ProtocolError);
  throws(() => encodeAuthorTextSummaryQuery({ ...query, schema: 1n }), ProtocolError);
  throws(() => encodeAuthorTextSummaryQuery({ ...query, updatedFromUnixMs: 5n, updatedUntilUnixMs: 4n }), ProtocolError);
  const old = decodeFrame(encodeAuthorTextQualifiedQuery(qualified)).payload;
  deepEqual(decodeFrame(encodeAuthorTextSummaryQuery(qualified)).payload, old);
});

test('faceted pages decode independent wire bytes with exact state and taxonomy order', () => {
  // Independently packed with little-endian counters and UTF-8 lengths.
  const payload = Buffer.from(
    '0100000000040000000100000000000000030000000000000000020000000900000004000000426c756502000000' +
    '0d00000006000000486172626f720200000000010000000700000006000000e7a081e5a4b40300000001000000' +
    '04000000170000000000000006000000486172626f7202000000080000006120f09fa7ad20620200000004000000' +
    '0c0000000e0000000e000000120000004747474747474747474747474747474747474747474747474747474747474747',
    'hex');
  const page = decodeAuthorTextFacetedPage(payload);
  deepEqual({ ...page, rows: page.rows.map(match => ({ ...match, sourceDigest: Uint8Array.from(match.sourceDigest) })) }, {
    ready: true, nextCursor: '', total: 4, stateCounts: [1, 0, 3, 0], moreCategories: false,
    categories: [{ id: 9, name: 'Blue', count: 2 }, { id: 13, name: 'Harbor', count: 2 }],
    moreTags: false, tags: [{ id: 7, name: '码头', count: 3 }], rows: [row],
  });
  const invalidReady = Buffer.from(payload);
  invalidReady[0] = 2;
  throws(() => decodeAuthorTextFacetedPage(invalidReady), ProtocolError);
  throws(() => decodeAuthorTextFacetedPage(Buffer.concat([payload, Uint8Array.of(0)])), ProtocolError);
});

function facetedPayload({
  ready = true, nextCursor = '', total = 2, states = [2, 0, 0, 0],
  moreCategories = false, categories = [] as AuthorTextTaxonomyFacet[],
  moreTags = false, tags = [] as AuthorTextTaxonomyFacet[], rows = [row],
} = {}) {
  function i32(value: number) {
    const bytes = Buffer.alloc(4);
    bytes.writeInt32LE(value);
    return bytes;
  }
  function text(value: string) {
    const bytes = Buffer.from(value, 'utf8');
    return Buffer.concat([i32(bytes.length), bytes]);
  }
  function facets(more: boolean, items: AuthorTextTaxonomyFacet[]) {
    return [Uint8Array.of(Number(more)), i32(items.length),
      ...items.flatMap(item => [i32(item.id), text(item.name), i32(item.count)])];
  }
  // Reuse only the established ranked row bytes. Faceted framing and lists are packed independently.
  const ranked = decodeFrame(encodeAuthorTextRankedPage({ ready: true, nextCursor: '', rows }), FrameType.AuthorTextRankedPage).payload;
  return Buffer.concat([Uint8Array.of(Number(ready)), text(nextCursor), i32(total), ...states.map(i32),
    ...facets(moreCategories, categories), ...facets(moreTags, tags), ranked.subarray(5)]);
}

test('faceted pages enforce totals, pending shape, taxonomy limits and continuation', () => {
  const facet = { id: 1, name: 'Blue', count: 1 };
  const pending = { ready: false, total: 0, states: [0, 0, 0, 0], rows: [] };
  equal(decodeAuthorTextFacetedPage(facetedPayload(pending)).ready, false);
  equal(decodeAuthorTextFacetedPage(facetedPayload({ ...pending, ready: true })).total, 0);

  const full = Array.from({ length: WireLimits.AuthorTextSearchRows }, (_, index) => ({ ...row, id: index + 1 }));
  const categories = Array.from({ length: WireLimits.AuthorTextSearchFacetRows }, (_, index) => ({ ...facet, id: index + 1 }));
  const continued = { nextCursor: 'AZ_09', total: 21, states: [4, 1, 15, 1], rows: full, moreCategories: true, categories };
  const valid = decodeAuthorTextFacetedPage(facetedPayload(continued));
  equal(valid.nextCursor, 'AZ_09');
  equal(valid.categories.length, WireLimits.AuthorTextSearchFacetRows);
  equal(valid.moreCategories, true);
  for (const value of [
    { total: -1, rows: [] },
    { total: 0, states: [0, 0, 0, 0] },
    { states: [3, -1, 0, 0] },
    { states: [2_147_483_647, 2_147_483_647, 4, 0] },
    { ...pending, total: 1, states: [1, 0, 0, 0] },
    { ...pending, moreTags: true },
    { ...continued, total: 20, states: [20, 0, 0, 0] },
    { ...continued, nextCursor: 'wrong=' },
    { ...continued, rows: full.slice(1) },
    { categories: [facet], moreCategories: true },
    { tags: [...categories, { ...facet, id: 13 }] },
    { categories: [{ ...facet, id: 0 }] },
    { categories: [{ ...facet, count: 0 }] },
    { categories: [{ ...facet, count: 3 }] },
    { categories: [{ ...facet, name: 'a\0b' }] },
    { categories: [{ ...facet, name: '港'.repeat(171) }] },
    { categories: [facet, { ...facet, id: 2, count: 2 }] },
    { tags: [{ ...facet, id: 2 }, facet] },
    { tags: [{ ...facet, count: 2 }, facet] },
  ]) throws(() => decodeAuthorTextFacetedPage(facetedPayload(value)), ProtocolError);
});


test('summary source coordinates are admitted only by the new page and use both dedicated caps', () => {
  const summaryBoundary = {
    ...row,
    sourceStart: WireLimits.ArticleSummaryReadChars - 2, sourceEnd: WireLimits.ArticleSummaryReadChars,
    sourceByteStart: WireLimits.ArticleSummaryReadBytes - 4, sourceByteEnd: WireLimits.ArticleSummaryReadBytes,
  };
  function withSummaryField(payload: Uint8Array, rowStart: number, match: AuthorTextSearchRow) {
    const changed = Buffer.from(payload);
    const fieldOffset = rowStart + 4 + 8 + 4 + Buffer.byteLength(match.title);
    changed.writeInt32LE(3, fieldOffset);
    return changed;
  }
  function summaryPayload(match: AuthorTextSearchRow) {
    const payload = facetedPayload({ rows: [match] });
    // Ready, cursor length, total, four states, two empty facet buckets, and row count.
    return withSummaryField(payload, 1 + 4 + 4 + 16 + 5 + 5 + 4, match);
  }
  const payload = summaryPayload(summaryBoundary);
  equal(FrameType.AuthorTextSummaryPage, 33019);
  const summaryPage = decodeAuthorTextSummaryPage(payload);
  deepEqual(decodeAuthorTextHeadingPage(payload), summaryPage);
  const match = summaryPage.rows[0];
  deepEqual({ ...match, sourceDigest: Uint8Array.from(match.sourceDigest) }, { ...summaryBoundary, field: 'summary' });
  throws(() => decodeAuthorTextFacetedPage(payload), ProtocolError);
  throws(() => encodeAuthorTextRankedPage({ ready: true, nextCursor: '', rows: [match] }), ProtocolError);
  const ranked = decodeFrame(encodeAuthorTextRankedPage({ ready: true, nextCursor: '', rows: [summaryBoundary] })).payload;
  const invalidRanked = withSummaryField(ranked, 9, summaryBoundary);
  throws(() => decodeAuthorTextRankedPage(invalidRanked), ProtocolError);
  throws(() => decodeAuthorTextSearchPage(Buffer.concat([Uint8Array.of(1, 0), invalidRanked.subarray(5)])), ProtocolError);
  for (const invalid of [
    { ...summaryBoundary, sourceStart: summaryBoundary.sourceStart + 1, sourceEnd: summaryBoundary.sourceEnd + 1 },
    { ...summaryBoundary, sourceByteStart: summaryBoundary.sourceByteStart + 1, sourceByteEnd: summaryBoundary.sourceByteEnd + 1 },
    { ...summaryBoundary, snippet: summaryBoundary.snippet.padEnd(WireLimits.ArticleSummaryReadChars + 1, 'a') },
  ]) throws(() => decodeAuthorTextSummaryPage(summaryPayload(invalid)), ProtocolError);
});


test('heading search keeps the qualified payload bytes under its own request discriminator', () => {
  const query = { ...qualified, query: 'field.heading:Orbit' };
  const frame = encodeAuthorTextHeadingQuery(query);
  const { payload } = decodeFrame(frame, FrameType.AuthorTextHeadingQuery);
  equal(FrameType.AuthorTextHeadingQuery, 33020);
  deepEqual(payload, decodeFrame(encodeAuthorTextSummaryQuery(query)).payload);
  deepEqual(decodeAuthorTextHeadingQuery(payload), decodeAuthorTextQualifiedQuery(payload));
  throws(() => decodeFrame(frame, FrameType.AuthorTextSummaryQuery), ProtocolError);
  const unqualified = { ...query, updatedFromUnixMs: null, updatedUntilUnixMs: null, schema: 0n, conditions: [] };
  deepEqual(decodeAuthorTextHeadingQuery(decodeFrame(encodeAuthorTextHeadingQuery(unqualified)).payload), unqualified);
  throws(() => encodeAuthorTextHeadingQuery({ ...unqualified, schema: 1n }), ProtocolError);
});

test('heading result uses raw body limits and is rejected by earlier faceted page codecs', () => {
  // Independently packed body range for "Orbit" ending at the wire body byte ceiling.
  const payload = Buffer.from(
    '0100000000010000000100000000000000000000000000000000000000000000000000010000000400000017' +
    '0000000000000006000000486172626f7204000000050000004f726269740000000005000000fbff0f000000' +
    '1000fbff0f0000001000dc796faa8258aeb80074c753df4a69c860f758c9b5d64007e984929dc046631a',
    'hex');
  equal(FrameType.AuthorTextHeadingPage, 33021);
  const page = decodeAuthorTextHeadingPage(payload);
  deepEqual(page.stateCounts, [1, 0, 0, 0]);
  deepEqual(page.rows.map(({ sourceDigest, ...match }) => ({
    ...match, digest: Buffer.from(sourceDigest).toString('hex'),
  })), [{
    id: 4, revision: 23n, title: 'Harbor', field: 'heading', snippet: 'Orbit', highlightStart: 0, highlightEnd: 5,
    sourceStart: WireLimits.BodyBytes - 5, sourceEnd: WireLimits.BodyBytes,
    sourceByteStart: WireLimits.BodyBytes - 5, sourceByteEnd: WireLimits.BodyBytes,
    digest: 'dc796faa8258aeb80074c753df4a69c860f758c9b5d64007e984929dc046631a',
  }]);
  throws(() => decodeAuthorTextSummaryPage(payload), ProtocolError);
  throws(() => decodeAuthorTextFacetedPage(payload), ProtocolError);
  throws(() => encodeAuthorTextRankedPage({ ready: true, nextCursor: '', rows: page.rows }), ProtocolError);
  const unknownField = Buffer.from(payload);
  unknownField.writeInt32LE(5, 61);
  throws(() => decodeAuthorTextHeadingPage(unknownField), ProtocolError);
  const overBound = Buffer.from(payload);
  overBound.writeInt32LE(WireLimits.BodyBytes - 4, 90);
  overBound.writeInt32LE(WireLimits.BodyBytes + 1, 94);
  throws(() => decodeAuthorTextHeadingPage(overBound), ProtocolError);
});


const propertyFacetQuery: AuthorTextPropertyFacetQuery = {
  search: { query: 'Orbit', cursor: '', schema: 10n, conditions: [], updatedFromUnixMs: null, updatedUntilUnixMs: null },
  includeHeading: false,
  definitionId: dateProperty.id,
  definitionRevision: 3n,
};

test('property facet query independently binds one schema revision, selected definition, and heading mode', () => {
  const golden = Buffer.from(
    '050000004f726269740000000000000a000000000000000000000000111111111111411181111111111111110300000000000000',
    'hex');
  const frame = encodeAuthorTextPropertyFacetQuery(propertyFacetQuery);
  equal(FrameType.AuthorTextPropertyFacetQuery, 33022);
  const { payload } = decodeFrame(frame, FrameType.AuthorTextPropertyFacetQuery);
  deepEqual(Buffer.from(payload), golden);
  deepEqual(decodeAuthorTextPropertyFacetQuery(golden), propertyFacetQuery);
  throws(() => decodeFrame(frame, FrameType.AuthorTextHeadingQuery), ProtocolError);
  throws(() => decodeAuthorTextHeadingQuery(golden), ProtocolError);

  const withConditions = { ...propertyFacetQuery, search: qualified, includeHeading: true };
  const filtered = decodeFrame(encodeAuthorTextPropertyFacetQuery(withConditions)).payload;
  deepEqual(filtered.subarray(0, -25), decodeFrame(encodeAuthorTextQualifiedQuery(qualified)).payload);
  equal(decodeAuthorTextPropertyFacetQuery(filtered).includeHeading, true);

  const badBool = Buffer.from(golden);
  badBool[27] = 2;
  throws(() => decodeAuthorTextPropertyFacetQuery(badBool), ProtocolError);
  throws(() => decodeAuthorTextPropertyFacetQuery(golden.subarray(0, -1)), ProtocolError);
  for (const invalid of [
    { ...propertyFacetQuery, search: { ...propertyFacetQuery.search, schema: 0n } },
    { ...propertyFacetQuery, definitionRevision: 0n },
    { ...propertyFacetQuery, definitionRevision: propertyFacetQuery.search.schema + 1n },
    { ...propertyFacetQuery, definitionId: '00000000-0000-0000-0000-000000000000' },
  ]) throws(() => encodeAuthorTextPropertyFacetQuery(invalid), ProtocolError);
});

test('property facet response preserves false, zero true, missing and null separately', () => {
  const golden = Buffer.from(
    '010000000004000000040000000000000000000000000000000000000000000000000000000000' +
    '111111111111411181111111111111110300000000000000020000000100000002000000000000000200000000010000000100000000',
    'hex');
  equal(FrameType.AuthorTextPropertyFacetPage, 33023);
  const result = decodeAuthorTextPropertyFacetPage(golden);
  equal(result.search.total, 4);
  deepEqual(result.facet, {
    definitionId: propertyFacetQuery.definitionId, definitionRevision: 3n, kind: 'boolean', missing: 1, null: 2, empty: 0,
    buckets: [{ value: { kind: 'boolean', value: false }, count: 1 }, { value: { kind: 'boolean', value: true }, count: 0 }],
  });
  throws(() => decodeAuthorTextHeadingPage(golden), ProtocolError);
  // The known fixture offsets refer to kind, absent-state counters, bucket length, and Boolean values/counts.
  for (const [offset, value] of [[63, 6], [67, 3], [75, 1], [79, 1], [83, 1], [84, 0], [88, 0], [89, 2]]) {
    const invalid = Buffer.from(golden);
    invalid[offset] = value;
    throws(() => decodeAuthorTextPropertyFacetPage(invalid), ProtocolError);
  }
  const pending = facetedPayload({ ready: false, total: 0, states: [0, 0, 0, 0], rows: [] });
  equal(decodeAuthorTextPropertyFacetPage(pending).facet, null);
  throws(() => decodeAuthorTextPropertyFacetPage(golden.subarray(0, pending.length)), ProtocolError);
  throws(() => decodeAuthorTextPropertyFacetPage(Buffer.concat([pending, golden.subarray(pending.length)])), ProtocolError);
});

test('property facet response counts overlapping multi-select options under exact stable identities', () => {
  const uuid = (id: string) => Buffer.from(id.replaceAll('-', ''), 'hex');
  function integer(value: number) {
    const bytes = Buffer.alloc(4);
    bytes.writeInt32LE(value);
    return bytes;
  }
  function selectedPayload(kind: number, empty: number, counts: readonly number[], options: readonly string[]) {
    const revision = Buffer.alloc(8);
    revision.writeBigInt64LE(3n);
    return Buffer.concat([facetedPayload({ total: 5, states: [5, 0, 0, 0], rows: [] }),
      uuid(propertyFacetQuery.definitionId), revision, integer(kind), integer(1), integer(1), integer(empty), integer(counts.length),
      ...counts.flatMap((count, index) => [uuid(options[index]), integer(count)]),
    ]);
  }
  const optionIds = Array.from({ length: 33 }, (_, index) => `aaaaaaaa-aaaa-4aaa-8aaa-${(index + 1).toString(16).padStart(12, '0')}`);
  const result = decodeAuthorTextPropertyFacetPage(selectedPayload(5, 1, [2, 2, 0], optionIds));
  deepEqual(result.facet, {
    definitionId: propertyFacetQuery.definitionId, definitionRevision: 3n, kind: 'multi-select', missing: 1, null: 1, empty: 1,
    buckets: [2, 2, 0].map((count, index) => ({ value: { kind: 'single-select', value: optionIds[index] }, count })),
  });
  equal(decodeAuthorTextPropertyFacetPage(selectedPayload(4, 0, [2, 1, 0], optionIds)).facet?.kind, 'single-select');
  equal(decodeAuthorTextPropertyFacetPage(selectedPayload(5, 1, new Array(32).fill(0), optionIds)).facet?.buckets.length, 32);
  for (const payload of [
    selectedPayload(4, 0, [2, 2, 0], optionIds),
    selectedPayload(4, 1, [1, 1, 0], optionIds),
    selectedPayload(5, 1, [3, 2, 0], optionIds),
    selectedPayload(5, 1, [-1, 2, 0], optionIds),
    selectedPayload(5, 1, [0, 0], [optionIds[1], optionIds[0]]),
    selectedPayload(5, 1, [0, 0], [optionIds[0], optionIds[0]]),
    selectedPayload(5, 1, [0], ['00000000-0000-0000-0000-000000000000']),
    selectedPayload(5, 1, new Array(33).fill(0), optionIds),
  ]) throws(() => decodeAuthorTextPropertyFacetPage(payload), ProtocolError);
});


const propertySortQuery: AuthorTextPropertySortQuery = {
  ...propertyFacetQuery,
  includeHeading: true,
  direction: 'descending',
  facet: { definitionId: numberProperty.id, definitionRevision: 4n },
};

test('property sort binds both selected revisions, direction and heading mode in one schema', () => {
  const golden = Buffer.from(
    '050000004f726269740000000000000a000000000000000000000001111111111111411181111111111111110300000000000000' +
    '010112345678123440009000123456789abc0400000000000000',
    'hex');
  const frame = encodeAuthorTextPropertySortQuery(propertySortQuery);
  equal(FrameType.AuthorTextPropertySortQuery, 33026);
  const { payload } = decodeFrame(frame, FrameType.AuthorTextPropertySortQuery);
  deepEqual(Buffer.from(payload), golden);
  deepEqual(decodeAuthorTextPropertySortQuery(golden), propertySortQuery);
  throws(() => decodeFrame(frame, FrameType.AuthorTextPropertyFacetQuery), ProtocolError);

  const ascending = { ...propertySortQuery, direction: 'ascending', facet: null } as const;
  const noFacet = decodeFrame(encodeAuthorTextPropertySortQuery(ascending)).payload;
  deepEqual(decodeAuthorTextPropertySortQuery(noFacet), ascending);
  deepEqual(noFacet.subarray(-2), Uint8Array.of(0, 0));

  const filtered = decodeFrame(encodeAuthorTextPropertySortQuery({ ...propertySortQuery, search: qualified })).payload;
  deepEqual(filtered.subarray(0, -51), decodeFrame(encodeAuthorTextQualifiedQuery(qualified)).payload);
  for (const offset of [27, 52, 53]) {
    const invalid = Buffer.from(golden);
    invalid[offset] = 2;
    throws(() => decodeAuthorTextPropertySortQuery(invalid), ProtocolError);
  }
  throws(() => decodeAuthorTextPropertySortQuery(golden.subarray(0, -1)), ProtocolError);
  for (const invalid of [
    { ...propertySortQuery, search: { ...propertySortQuery.search, schema: 0n } },
    { ...propertySortQuery, definitionRevision: 11n },
    { ...propertySortQuery, facet: { ...propertySortQuery.facet!, definitionRevision: 11n } },
    { ...propertySortQuery, facet: { ...propertySortQuery.facet!, definitionId: '00000000-0000-0000-0000-000000000000' } },
  ]) throws(() => encodeAuthorTextPropertySortQuery(invalid), ProtocolError);
});

test('property sort page retains existing row bytes and exposes only the optional property facet', () => {
  // Independently packed optional facet bytes: definition, revision, Boolean kind, then missing/null/empty and both buckets.
  const facetBytes = Buffer.from(
    '111111111111411181111111111111110300000000000000020000000100000002000000000000000200000000010000000100000000',
    'hex');
  const base = facetedPayload({ total: 4, states: [4, 0, 0, 0], rows: [row, { ...row, id: 17 }] });
  equal(FrameType.AuthorTextPropertySortPage, 33027);
  const absent = Buffer.concat([base, Uint8Array.of(0)]);
  const present = Buffer.concat([base, Uint8Array.of(1), facetBytes]);
  const expected = decodeAuthorTextFacetedPage(base);
  deepEqual(decodeAuthorTextPropertySortPage(absent, false, false), { search: expected, facet: null });
  deepEqual(decodeAuthorTextPropertySortPage(present, false, true),
    decodeAuthorTextPropertyFacetPage(Buffer.concat([base, facetBytes]), false));
  deepEqual(decodeAuthorTextPropertySortPage(absent).search.rows.map(match => match.id), [4, 17]);
  throws(() => decodeAuthorTextPropertySortPage(present, false, false), ProtocolError);
  throws(() => decodeAuthorTextPropertySortPage(absent, false, true), ProtocolError);
  throws(() => decodeAuthorTextPropertyFacetPage(present), ProtocolError);
  throws(() => decodeAuthorTextPropertySortPage(Buffer.concat([base, Uint8Array.of(2)])), ProtocolError);
  throws(() => decodeAuthorTextPropertySortPage(base), ProtocolError);

  const pending = facetedPayload({ ready: false, total: 0, states: [0, 0, 0, 0], rows: [] });
  equal(decodeAuthorTextPropertySortPage(pending, false, true).facet, null);
  throws(() => decodeAuthorTextPropertySortPage(Buffer.concat([pending, Uint8Array.of(0)])), ProtocolError);

  const heading = Buffer.from(absent);
  heading.writeInt32LE(4, 61); // First row field code follows the six-byte title.
  equal(decodeAuthorTextPropertySortPage(heading, true).search.rows[0].field, 'heading');
  throws(() => decodeAuthorTextPropertySortPage(heading, false), ProtocolError);
});


test('property text query carries its exact definition coordinates under the existing qualified schema', () => {
  const golden = Buffer.from(
    '050000004f726269740000000000000a0000000000000000000000111111111111411181111111111111110300000000000000',
    'hex');
  const query: AuthorTextPropertyTextQuery = {
    search: propertyFacetQuery.search, definitionId: propertyFacetQuery.definitionId, definitionRevision: 3n,
  };
  const frame = encodeAuthorTextPropertyTextQuery(query);
  equal(FrameType.AuthorTextPropertyTextQuery, 33029);
  deepEqual(Buffer.from(decodeFrame(frame, FrameType.AuthorTextPropertyTextQuery).payload), golden);
  deepEqual(decodeAuthorTextPropertyTextQuery(golden), query);
  throws(() => decodeFrame(frame, FrameType.AuthorTextPropertySortQuery), ProtocolError);
  throws(() => decodeAuthorTextPropertyTextQuery(golden.subarray(0, -1)), ProtocolError);
  throws(() => decodeAuthorTextPropertyTextQuery(Buffer.concat([golden, Uint8Array.of(0)])), ProtocolError);

  const filtered = decodeFrame(encodeAuthorTextPropertyTextQuery({ ...query, search: qualified })).payload;
  deepEqual(filtered.subarray(0, -24), decodeFrame(encodeAuthorTextQualifiedQuery(qualified)).payload);
  for (const invalid of [
    { ...query, search: { ...query.search, schema: 0n } },
    { ...query, definitionRevision: 0n },
    { ...query, definitionRevision: 11n },
    { ...query, definitionId: '00000000-0000-0000-0000-000000000000' },
  ]) throws(() => encodeAuthorTextPropertyTextQuery(invalid), ProtocolError);
});

test('property text page uses closed field 5 with independent UTF-16 and UTF-8 source limits', () => {
  // Packed independently from a source of 16,379 copies of 北 followed by Orbit.
  const payload = Buffer.from(
    '0100000000010000000100000000000000000000000000000000000000000000000000010000000400000017' +
    '0000000000000006000000486172626f7205000000050000004f726269740000000005000000fb3f00000040' +
    '0000f1bf0000f6bf000088c0ad4bb018b4f9fa932dff490c9616d779ca27e05d87a6288d37483d5a0ddd',
    'hex');
  equal(FrameType.AuthorTextPropertyTextPage, 33030);
  const page = decodeAuthorTextPropertyTextPage(payload);
  deepEqual(page.rows.map(({ sourceDigest, ...match }) => ({ ...match, digest: Buffer.from(sourceDigest).toString('hex') })), [{
    id: 4, revision: 23n, title: 'Harbor', field: 'property-text', snippet: 'Orbit', highlightStart: 0, highlightEnd: 5,
    sourceStart: 16_379, sourceEnd: 16_384, sourceByteStart: 49_137, sourceByteEnd: 49_142,
    digest: '88c0ad4bb018b4f9fa932dff490c9616d779ca27e05d87a6288d37483d5a0ddd',
  }]);
  throws(() => decodeAuthorTextHeadingPage(payload), ProtocolError);
  throws(() => decodeAuthorTextPropertyFacetPage(payload), ProtocolError);
  throws(() => decodeAuthorTextPropertySortPage(Buffer.concat([payload, Uint8Array.of(0)])), ProtocolError);
  throws(() => encodeAuthorTextRankedPage({ ready: true, nextCursor: '', rows: page.rows }), ProtocolError);
  const body = Buffer.from(payload);
  body.writeInt32LE(2, 61);
  equal(decodeAuthorTextHeadingPage(body).rows[0].field, 'body');
  throws(() => decodeAuthorTextPropertyTextPage(body), ProtocolError);
  for (const [start, limit] of [[82, WireLimits.AuthorTextPropertyTextSourceChars], [90, WireLimits.PropertyValueBytes]]) {
    const invalid = Buffer.from(payload);
    invalid.writeInt32LE(limit - 4, start);
    invalid.writeInt32LE(limit + 1, start + 4);
    throws(() => decodeAuthorTextPropertyTextPage(invalid), ProtocolError);
  }
  const pending = facetedPayload({ ready: false, total: 0, states: [0, 0, 0, 0], rows: [] });
  equal(decodeAuthorTextPropertyTextPage(pending).ready, false);
});
