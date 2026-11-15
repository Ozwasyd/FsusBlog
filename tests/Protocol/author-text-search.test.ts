import { deepEqual, equal, throws } from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import {
  decodeAuthorTextFacetedPage, decodeAuthorTextFacetedQuery, encodeAuthorTextFacetedQuery,
  decodeAuthorTextQualifiedQuery, encodeAuthorTextQualifiedQuery, type AuthorTextQualifiedQuery,
  decodeAuthorTextRankedPage, decodeAuthorTextRankedQuery, decodeAuthorTextSearchPage,
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
