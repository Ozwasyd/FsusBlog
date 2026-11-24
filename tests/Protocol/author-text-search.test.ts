import { deepEqual, equal, throws } from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFrame, encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
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
  decodeAuthorTextPropertyTextQualifiedPage, decodeAuthorTextPropertyTextQualifiedQuery,
  encodeAuthorTextPropertyTextQualifiedQuery, type AuthorTextPropertyTextQualifiedQuery,
  decodeAuthorTextPropertyTextMixedPage, decodeAuthorTextPropertyTextMixedQuery,
  encodeAuthorTextPropertyTextMixedQuery, type AuthorTextPropertyTextMixedQuery,
  encodeAuthorTextRankedPage, encodeAuthorTextRankedQuery, type AuthorTextSearchRow, type AuthorTextTaxonomyFacet,
} from '../../src/Contracts/author-text-search.ts';
import type { FilterField } from '../../src/Contracts/property-query.ts';
import { FrameType, WireHeader, WireLimits } from '../../src/Contracts/wire.generated.ts';
import {
  appendByte, hexBytes, i32, i64, rejectBytes, rejectInputs, rejectPatches, rejectWrongLength,
  text, withByte, withI32, withI64,
} from './fixture-source.ts';

const payloadOf = (frame: Uint8Array, type?: FrameType) => decodeFrame(frame, type).payload;
const assertFramePayload = (frame: Uint8Array, type: FrameType, expected: Uint8Array) =>
  deepEqual(Buffer.from(payloadOf(frame, type)), expected);
const rejectFlags = (decode: (payload: Uint8Array) => unknown, payload: Uint8Array, offsets: number[]) =>
  rejectBytes(decode, payload, offsets.map(offset => [offset, 2] as const));
const rejectAll = (fns: Iterable<() => unknown>) => { for (const fn of fns) throws(fn, ProtocolError); };

function expectSingleRow(
  rows: readonly AuthorTextSearchRow[], field: AuthorTextSearchRow['field'],
  sourceStart: number, sourceEnd: number, sourceByteStart: number, sourceByteEnd: number, digest: string,
) {
  deepEqual(rows.map(({ sourceDigest, ...match }) => ({ ...match, digest: Buffer.from(sourceDigest).toString('hex') })), [{
    id: 4, revision: 23n, title: 'Harbor', field, snippet: 'Orbit', highlightStart: 0, highlightEnd: 5,
    sourceStart, sourceEnd, sourceByteStart, sourceByteEnd, digest,
  }]);
}

const booleanFacet = (definitionId: string, definitionRevision: bigint, missing: number, nullCount: number) => ({
  definitionId, definitionRevision, kind: 'boolean', missing, null: nullCount, empty: 0,
  buckets: [{ value: { kind: 'boolean', value: false }, count: 1 }, { value: { kind: 'boolean', value: true }, count: 0 }],
});

const row: AuthorTextSearchRow = {
  id: 4, revision: 23n, title: 'Harbor', field: 'body', snippet: 'a 🧭 b',
  highlightStart: 2, highlightEnd: 4, sourceStart: 12, sourceEnd: 14,
  sourceByteStart: 14, sourceByteEnd: 18, sourceDigest: new Uint8Array(32).fill(71),
};
const zeroUuid = '00000000-0000-0000-0000-000000000000';
const dateProperty: FilterField = {
  id: '11111111-1111-4111-8111-111111111111', revision: 2n, machineKey: 'date', label: 'Date',
  kind: 'date', enabled: true, deprecated: false, options: [],
};
const numberProperty: FilterField = { ...dateProperty, id: '12345678-1234-4000-9000-123456789abc', revision: 3n, kind: 'number' };
const qualified: AuthorTextQualifiedQuery = {
  query: '港', cursor: '_', updatedFromUnixMs: -1n, updatedUntilUnixMs: 0n, schema: 10n,
  conditions: [
    { field: dateProperty, comparison: 'at-most', value: { kind: 'date', value: '2024-02-29T14:12:06.015Z' } },
    { field: numberProperty, comparison: 'at-least', value: { kind: 'number', value: '-9007199254740993.000000000001' } },
  ],
};

function facetedPayload({
  ready = true, nextCursor = '', total = 2, states = [2, 0, 0, 0],
  moreCategories = false, categories = [] as AuthorTextTaxonomyFacet[],
  moreTags = false, tags = [] as AuthorTextTaxonomyFacet[], rows = [row],
} = {}) {
  const facets = (more: boolean, items: AuthorTextTaxonomyFacet[]) =>
    [Uint8Array.of(Number(more)), i32(items.length), ...items.flatMap(item => [i32(item.id), text(item.name), i32(item.count)])];
  const ranked = payloadOf(encodeAuthorTextRankedPage({ ready: true, nextCursor: '', rows }), FrameType.AuthorTextRankedPage);
  return Buffer.concat([Uint8Array.of(Number(ready)), text(nextCursor), i32(total), ...states.map(i32),
    ...facets(moreCategories, categories), ...facets(moreTags, tags), ranked.subarray(5)]);
}

const pendingPagePayload = () => facetedPayload({ ready: false, total: 0, states: [0, 0, 0, 0], rows: [] });
const propertyTextLexical = hexBytes('050000004f726269740000000000000a0000000000000000000000111111111111411181111111111111110300000000000000');
const propertyTextPagePayload = hexBytes(
  '0100000000010000000100000000000000000000000000000000000000000000000000010000000400000017' +
  '0000000000000006000000486172626f7205000000050000004f726269740000000005000000fb3f00000040' +
  '0000f1bf0000f6bf000088c0ad4bb018b4f9fa932dff490c9616d779ca27e05d87a6288d37483d5a0ddd',
);
const propertyFacetQuery: AuthorTextPropertyFacetQuery = {
  search: { query: 'Orbit', cursor: '', schema: 10n, conditions: [], updatedFromUnixMs: null, updatedUntilUnixMs: null },
  includeHeading: false, definitionId: dateProperty.id, definitionRevision: 3n,
};
const propertySortQuery: AuthorTextPropertySortQuery = {
  ...propertyFacetQuery, includeHeading: true, direction: 'descending',
  facet: { definitionId: numberProperty.id, definitionRevision: 4n },
};
const propertyTextQualifiedQuery: AuthorTextPropertyTextQualifiedQuery = {
  search: propertyFacetQuery.search, definitionId: dateProperty.id, definitionRevision: 3n,
  facet: { definitionId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000007', definitionRevision: 4n },
  sort: { definitionId: numberProperty.id, definitionRevision: 5n, direction: 'descending' },
};
const propFacetSelectorBytes = hexBytes('01aaaaaaaaaaaa4aaa8aaa0000000000070400000000000000');
const propSortSelectorBytes = hexBytes('0112345678123440009000123456789abc050000000000000001');

function checkPropertyQueryRoundTrip<T extends { search: AuthorTextQualifiedQuery }>(
  frameType: FrameType, code: number, rejectFrame: FrameType,
  encode: (value: T) => Uint8Array, decode: (payload: Uint8Array) => T,
  query: T, golden: Uint8Array, tailBytes: number,
) {
  equal(frameType, code);
  const frame = encode(query);
  assertFramePayload(frame, frameType, golden);
  deepEqual(decode(golden), query);
  throws(() => decodeFrame(frame, rejectFrame), ProtocolError);
  deepEqual(payloadOf(encode({ ...query, search: qualified })).subarray(0, -tailBytes), payloadOf(encodeAuthorTextQualifiedQuery(qualified)));
}

test('ranked and faceted requests and pages preserve order, cursor bounds, and frame separation', () => {
  const query = { query: 'field.title:港 "blue orbit"', cursor: 'AZ_-09' };
  const ranked = payloadOf(encodeAuthorTextRankedQuery(query), FrameType.AuthorTextRankedQuery);
  deepEqual(decodeAuthorTextRankedQuery(ranked), query);
  equal(Buffer.from(ranked).toString('hex'), '1c0000006669656c642e7469746c653ae6b8af2022626c7565206f726269742206000000415a5f2d3039');
  rejectInputs(cursor => encodeAuthorTextRankedQuery({ ...query, cursor }),
    ['bad\n', 'with=', '港', 'a'.repeat(WireLimits.AuthorTextRankedCursorChars + 1)]);

  const page = { ready: true, nextCursor: '', rows: [row, { ...row, id: 17 }] };
  const bytes = payloadOf(encodeAuthorTextRankedPage(page), FrameType.AuthorTextRankedPage);
  deepEqual(decodeAuthorTextRankedPage(bytes), page);
  throws(() => decodeAuthorTextSearchPage(Buffer.concat([Uint8Array.of(1, 0), bytes.subarray(5)])), ProtocolError);
  throws(() => decodeAuthorTextRankedPage(withI32(bytes, 9 + (bytes.length - 9) / 2, row.id)), ProtocolError);
  rejectPatches(encodeAuthorTextRankedPage, page, [{ nextCursor: 'cursor' }, { ready: false }]);

  const faceted = payloadOf(encodeAuthorTextFacetedQuery(query), FrameType.AuthorTextFacetedQuery);
  equal(FrameType.AuthorTextFacetedQuery, 33013);
  equal(FrameType.AuthorTextFacetedPage, 33014);
  deepEqual(faceted, ranked);
  deepEqual(decodeAuthorTextFacetedQuery(faceted), query);
  throws(() => decodeAuthorTextFacetedQuery(appendByte(faceted)), ProtocolError);
  throws(() => encodeAuthorTextFacetedQuery({ ...query, cursor: 'a\r' }), ProtocolError);
});

test('qualified query keeps typed operand bytes, open bounds, and all eight value kinds', () => {
  const golden = hexBytes(
    '03000000e6b8af010000005f01ffffffffffffffff0100000000000000000a0000000000000002000000' +
    '111111111111411181111111111111110200000000000000020000000300000018000000323032342d30322d32395431343a31323a30362e3031355a' +
    '12345678123440009000123456789abc030000000000000004000000010000001e0000002d393030373139393235343734303939332e303030303030303030303031',
  );
  equal(FrameType.AuthorTextQualifiedQuery, 33015);
  assertFramePayload(encodeAuthorTextQualifiedQuery(qualified), FrameType.AuthorTextQualifiedQuery, golden);
  deepEqual(decodeAuthorTextQualifiedQuery(golden), {
    ...qualified,
    conditions: qualified.conditions.map(({ field, ...value }) => ({ definitionId: field.id, definitionRevision: field.revision, ...value })),
  });
  throws(() => decodeAuthorTextFacetedQuery(golden), ProtocolError);
  rejectBytes(decodeAuthorTextQualifiedQuery, golden, [[12, 2], [21, 2], [30, 0], [38, 5], [66, 9]]);
  rejectInputs(decodeAuthorTextQualifiedQuery, [
    withI32(golden, 70, -3),
    new Uint8Array(WireLimits.MaxAuthorTextQualifiedQueryFrameBytes - WireHeader.HeaderSize + 1),
  ]);
  rejectWrongLength(decodeAuthorTextQualifiedQuery, golden);

  const [min, max] = [-62_135_596_800_000n, 253_402_300_799_999n];
  const dateOnly = { ...qualified, updatedFromUnixMs: min, updatedUntilUnixMs: max, schema: 0n, conditions: [] };
  for (const value of [dateOnly, { ...dateOnly, updatedUntilUnixMs: null }, { ...dateOnly, updatedFromUnixMs: null }])
    deepEqual(decodeAuthorTextQualifiedQuery(payloadOf(encodeAuthorTextQualifiedQuery(value), FrameType.AuthorTextQualifiedQuery)), value);
  const condition = qualified.conditions[0];
  const propertyOnly = { ...qualified, updatedFromUnixMs: null, updatedUntilUnixMs: null, conditions: [condition] };
  equal(decodeAuthorTextQualifiedQuery(payloadOf(encodeAuthorTextQualifiedQuery(propertyOnly))).conditions.length, 1);
  rejectPatches(encodeAuthorTextQualifiedQuery, dateOnly, [
    { updatedFromUnixMs: min - 1n }, { updatedUntilUnixMs: max + 1n },
    { updatedFromUnixMs: max }, { updatedFromUnixMs: max, updatedUntilUnixMs: min }, { schema: 1n },
  ]);
  rejectPatches(encodeAuthorTextQualifiedQuery, propertyOnly, [{ schema: 0n }, { schema: 1n }, { schema: 0n, conditions: [] }]);
  rejectPatches(encodeAuthorTextQualifiedQuery, qualified, [
    { conditions: [condition, condition] }, { conditions: Array.from({ length: 5 }, () => condition) }, { cursor: 'a=' },
  ]);

  const cond = (kind: FilterField['kind'], value: unknown, comparison = 'equal') =>
    ({ field: { ...dateProperty, kind }, comparison, value: { kind, value } }) as AuthorTextQualifiedQuery['conditions'][number];
  const items: AuthorTextQualifiedQuery['conditions'] = [
    cond('text', '港口'), qualified.conditions[1], cond('boolean', false), qualified.conditions[0],
    cond('single-select', dateProperty.id), cond('multi-select', [], 'multi-select-any-of'),
    cond('article-reference', [83, 14], 'reference-any-of'), cond('url', 'https://example.com/'),
    { field: dateProperty, comparison: 'equal', value: { kind: 'null' } },
    { field: numberProperty, comparison: 'is-present', value: { kind: 'missing' } },
  ];
  for (let offset = 0; offset < items.length; offset += 4) {
    const conditions = items.slice(offset, offset + 4).map(({ field, ...cond }, index) => ({
      ...cond, field: { ...field, id: `12345678-1234-4000-9000-123456789ab${index}` },
    }));
    const payload = payloadOf(encodeAuthorTextQualifiedQuery({ ...qualified, conditions }));
    deepEqual(decodeAuthorTextQualifiedQuery(payload).conditions.map(({ value }) => value), conditions.map(({ value }) => value));
  }
});

test('faceted pages decode independent bytes and enforce totals, pending shape, taxonomy limits, and continuation', () => {
  const payload = hexBytes(
    '0100000000040000000100000000000000030000000000000000020000000900000004000000426c756502000000' +
    '0d00000006000000486172626f720200000000010000000700000006000000e7a081e5a4b40300000001000000' +
    '04000000170000000000000006000000486172626f7202000000080000006120f09fa7ad20620200000004000000' +
    '0c0000000e0000000e000000120000004747474747474747474747474747474747474747474747474747474747474747',
  );
  const page = decodeAuthorTextFacetedPage(payload);
  deepEqual({ ...page, rows: page.rows.map(match => ({ ...match, sourceDigest: Uint8Array.from(match.sourceDigest) })) }, {
    ready: true, nextCursor: '', total: 4, stateCounts: [1, 0, 3, 0], moreCategories: false,
    categories: [{ id: 9, name: 'Blue', count: 2 }, { id: 13, name: 'Harbor', count: 2 }],
    moreTags: false, tags: [{ id: 7, name: '码头', count: 3 }], rows: [row],
  });
  rejectFlags(decodeAuthorTextFacetedPage, payload, [0]);
  throws(() => decodeAuthorTextFacetedPage(appendByte(payload)), ProtocolError);

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
  const cat = (patch: Partial<AuthorTextTaxonomyFacet>) => ({ categories: [{ ...facet, ...patch }] });
  rejectInputs(value => decodeAuthorTextFacetedPage(facetedPayload(value)), [
    { total: -1, rows: [] }, { total: 0, states: [0, 0, 0, 0] }, { states: [3, -1, 0, 0] },
    { states: [2_147_483_647, 2_147_483_647, 4, 0] }, { ...pending, total: 1, states: [1, 0, 0, 0] },
    { ...pending, moreTags: true }, { ...continued, total: 20, states: [20, 0, 0, 0] },
    { ...continued, nextCursor: 'wrong=' }, { ...continued, rows: full.slice(1) },
    { categories: [facet], moreCategories: true }, { tags: [...categories, { ...facet, id: 13 }] },
    cat({ id: 0 }), cat({ count: 0 }), cat({ count: 3 }), cat({ name: 'a\0b' }), cat({ name: '港'.repeat(171) }),
    { categories: [facet, { ...facet, id: 2, count: 2 }] },
    { tags: [{ ...facet, id: 2 }, facet] }, { tags: [{ ...facet, count: 2 }, facet] },
  ]);
});

test('summary and heading queries and pages enforce field caps and frame separation', () => {
  const unqualified = { query: 'harbor', cursor: '', updatedFromUnixMs: null, updatedUntilUnixMs: null, schema: 0n, conditions: [] };
  const summaryFrame = encodeAuthorTextSummaryQuery(unqualified);
  const summaryPayloadBytes = payloadOf(summaryFrame, FrameType.AuthorTextSummaryQuery);
  equal(FrameType.AuthorTextSummaryQuery, 33018);
  equal(Buffer.from(summaryPayloadBytes).toString('hex'), '06000000686172626f72000000000000000000000000000000000000');
  deepEqual(decodeAuthorTextSummaryQuery(summaryPayloadBytes), unqualified);
  deepEqual(payloadOf(encodeAuthorTextSummaryQuery(qualified)), payloadOf(encodeAuthorTextQualifiedQuery(qualified)));
  rejectAll([() => decodeFrame(summaryFrame, FrameType.AuthorTextQualifiedQuery), () => decodeAuthorTextQualifiedQuery(summaryPayloadBytes)]);
  rejectPatches(encodeAuthorTextSummaryQuery, unqualified, [{ schema: 1n }, { updatedFromUnixMs: 5n, updatedUntilUnixMs: 4n }]);

  const summaryBoundary = {
    ...row,
    sourceStart: WireLimits.ArticleSummaryReadChars - 2, sourceEnd: WireLimits.ArticleSummaryReadChars,
    sourceByteStart: WireLimits.ArticleSummaryReadBytes - 4, sourceByteEnd: WireLimits.ArticleSummaryReadBytes,
  };
  const withSummaryField = (payload: Uint8Array, rowStart: number, match: AuthorTextSearchRow) =>
    withI32(payload, rowStart + 16 + Buffer.byteLength(match.title), 3);
  const summaryPageOf = (match: AuthorTextSearchRow) => withSummaryField(facetedPayload({ rows: [match] }), 39, match);
  const payload = summaryPageOf(summaryBoundary);
  equal(FrameType.AuthorTextSummaryPage, 33019);
  const summaryPage = decodeAuthorTextSummaryPage(payload);
  deepEqual(decodeAuthorTextHeadingPage(payload), summaryPage);
  const match = summaryPage.rows[0];
  deepEqual({ ...match, sourceDigest: Uint8Array.from(match.sourceDigest) }, { ...summaryBoundary, field: 'summary' });
  const invalidRanked = withSummaryField(payloadOf(encodeAuthorTextRankedPage({ ready: true, nextCursor: '', rows: [summaryBoundary] })), 9, summaryBoundary);
  rejectAll([
    () => decodeAuthorTextFacetedPage(payload), () => encodeAuthorTextRankedPage({ ready: true, nextCursor: '', rows: [match] }),
    () => decodeAuthorTextRankedPage(invalidRanked), () => decodeAuthorTextSearchPage(Buffer.concat([Uint8Array.of(1, 0), invalidRanked.subarray(5)])),
  ]);
  rejectPatches(invalid => decodeAuthorTextSummaryPage(summaryPageOf(invalid)), summaryBoundary, [
    { sourceStart: summaryBoundary.sourceStart + 1, sourceEnd: summaryBoundary.sourceEnd + 1 },
    { sourceByteStart: summaryBoundary.sourceByteStart + 1, sourceByteEnd: summaryBoundary.sourceByteEnd + 1 },
    { snippet: summaryBoundary.snippet.padEnd(WireLimits.ArticleSummaryReadChars + 1, 'a') },
  ]);

  const headingQuery = { ...qualified, query: 'field.heading:Orbit' };
  const headingFrame = encodeAuthorTextHeadingQuery(headingQuery);
  const headingQueryBytes = payloadOf(headingFrame, FrameType.AuthorTextHeadingQuery);
  equal(FrameType.AuthorTextHeadingQuery, 33020);
  deepEqual(headingQueryBytes, payloadOf(encodeAuthorTextSummaryQuery(headingQuery)));
  deepEqual(decodeAuthorTextHeadingQuery(headingQueryBytes), decodeAuthorTextQualifiedQuery(headingQueryBytes));
  const unqualifiedHeading = { ...unqualified, query: headingQuery.query };
  deepEqual(decodeAuthorTextHeadingQuery(payloadOf(encodeAuthorTextHeadingQuery(unqualifiedHeading))), unqualifiedHeading);
  rejectAll([() => decodeFrame(headingFrame, FrameType.AuthorTextSummaryQuery), () => encodeAuthorTextHeadingQuery({ ...unqualifiedHeading, schema: 1n })]);

  const headingPayload = hexBytes(
    '0100000000010000000100000000000000000000000000000000000000000000000000010000000400000017' +
    '0000000000000006000000486172626f7204000000050000004f726269740000000005000000fbff0f000000' +
    '1000fbff0f0000001000dc796faa8258aeb80074c753df4a69c860f758c9b5d64007e984929dc046631a',
  );
  equal(FrameType.AuthorTextHeadingPage, 33021);
  const headingPage = decodeAuthorTextHeadingPage(headingPayload);
  deepEqual(headingPage.stateCounts, [1, 0, 0, 0]);
  expectSingleRow(headingPage.rows, 'heading', WireLimits.BodyBytes - 5, WireLimits.BodyBytes,
    WireLimits.BodyBytes - 5, WireLimits.BodyBytes, 'dc796faa8258aeb80074c753df4a69c860f758c9b5d64007e984929dc046631a');
  rejectAll([
    () => decodeAuthorTextSummaryPage(headingPayload), () => decodeAuthorTextFacetedPage(headingPayload),
    () => encodeAuthorTextRankedPage({ ready: true, nextCursor: '', rows: headingPage.rows }),
  ]);
  rejectInputs(decodeAuthorTextHeadingPage, [
    withI32(headingPayload, 61, 5),
    withI32(withI32(headingPayload, 90, WireLimits.BodyBytes - 4), 94, WireLimits.BodyBytes + 1),
  ]);
});

test('property facet and sort queries and pages bind revisions, boolean/select facets, and heading mode', () => {
  const facetGolden = Buffer.concat([propertyTextLexical.subarray(0, 27), Uint8Array.of(0), propertyTextLexical.subarray(27)]);
  checkPropertyQueryRoundTrip(FrameType.AuthorTextPropertyFacetQuery, 33022, FrameType.AuthorTextHeadingQuery,
    encodeAuthorTextPropertyFacetQuery, decodeAuthorTextPropertyFacetQuery, propertyFacetQuery, facetGolden, 25);
  equal(decodeAuthorTextPropertyFacetQuery(payloadOf(encodeAuthorTextPropertyFacetQuery({ ...propertyFacetQuery, search: qualified, includeHeading: true }))).includeHeading, true);
  rejectFlags(decodeAuthorTextPropertyFacetQuery, facetGolden, [27]);
  rejectAll([() => decodeAuthorTextHeadingQuery(facetGolden), () => decodeAuthorTextPropertyFacetQuery(facetGolden.subarray(0, -1))]);
  rejectPatches(encodeAuthorTextPropertyFacetQuery, propertyFacetQuery, [
    { search: { ...propertyFacetQuery.search, schema: 0n } }, { definitionRevision: 0n },
    { definitionRevision: 11n }, { definitionId: zeroUuid },
  ]);

  const boolFacetTail = hexBytes('111111111111411181111111111111110300000000000000020000000100000002000000000000000200000000010000000100000000');
  const facetPageGolden = Buffer.concat([facetedPayload({ total: 4, states: [4, 0, 0, 0], rows: [] }), boolFacetTail]);
  equal(FrameType.AuthorTextPropertyFacetPage, 33023);
  const facetResult = decodeAuthorTextPropertyFacetPage(facetPageGolden);
  equal(facetResult.search.total, 4);
  deepEqual(facetResult.facet, booleanFacet(propertyFacetQuery.definitionId, 3n, 1, 2));
  throws(() => decodeAuthorTextHeadingPage(facetPageGolden), ProtocolError);
  rejectBytes(decodeAuthorTextPropertyFacetPage, facetPageGolden, [[63, 6], [67, 3], [75, 1], [79, 1], [83, 1], [84, 0], [88, 0], [89, 2]]);
  const pending = pendingPagePayload();
  equal(decodeAuthorTextPropertyFacetPage(pending).facet, null);
  rejectInputs(decodeAuthorTextPropertyFacetPage, [facetPageGolden.subarray(0, pending.length), Buffer.concat([pending, boolFacetTail])]);

  const uuid = (id: string) => hexBytes(id.replaceAll('-', ''));
  const selectedPayload = (kind: number, empty: number, counts: readonly number[], options: readonly string[]) =>
    Buffer.concat([facetedPayload({ total: 5, states: [5, 0, 0, 0], rows: [] }),
      uuid(propertyFacetQuery.definitionId), i64(3n), i32(kind), i32(1), i32(1), i32(empty), i32(counts.length),
      ...counts.flatMap((count, index) => [uuid(options[index]), i32(count)])]);
  const optionIds = Array.from({ length: 33 }, (_, index) => `aaaaaaaa-aaaa-4aaa-8aaa-${(index + 1).toString(16).padStart(12, '0')}`);
  deepEqual(decodeAuthorTextPropertyFacetPage(selectedPayload(5, 1, [2, 2, 0], optionIds)).facet, {
    definitionId: propertyFacetQuery.definitionId, definitionRevision: 3n, kind: 'multi-select', missing: 1, null: 1, empty: 1,
    buckets: [2, 2, 0].map((count, index) => ({ value: { kind: 'single-select', value: optionIds[index] }, count })),
  });
  equal(decodeAuthorTextPropertyFacetPage(selectedPayload(4, 0, [2, 1, 0], optionIds)).facet?.kind, 'single-select');
  equal(decodeAuthorTextPropertyFacetPage(selectedPayload(5, 1, new Array(32).fill(0), optionIds)).facet?.buckets.length, 32);
  rejectInputs(decodeAuthorTextPropertyFacetPage, [
    selectedPayload(4, 0, [2, 2, 0], optionIds), selectedPayload(4, 1, [1, 1, 0], optionIds),
    selectedPayload(5, 1, [3, 2, 0], optionIds), selectedPayload(5, 1, [-1, 2, 0], optionIds),
    selectedPayload(5, 1, [0, 0], [optionIds[1], optionIds[0]]), selectedPayload(5, 1, [0, 0], [optionIds[0], optionIds[0]]),
    selectedPayload(5, 1, [0], [zeroUuid]), selectedPayload(5, 1, new Array(33).fill(0), optionIds),
  ]);

  const sortGolden = hexBytes(
    '050000004f726269740000000000000a000000000000000000000001111111111111411181111111111111110300000000000000' +
    '010112345678123440009000123456789abc0400000000000000',
  );
  checkPropertyQueryRoundTrip(FrameType.AuthorTextPropertySortQuery, 33026, FrameType.AuthorTextPropertyFacetQuery,
    encodeAuthorTextPropertySortQuery, decodeAuthorTextPropertySortQuery, propertySortQuery, sortGolden, 51);
  const ascending = { ...propertySortQuery, direction: 'ascending', facet: null } as const;
  const noFacet = payloadOf(encodeAuthorTextPropertySortQuery(ascending));
  deepEqual(decodeAuthorTextPropertySortQuery(noFacet), ascending);
  deepEqual(noFacet.subarray(-2), Uint8Array.of(0, 0));
  rejectFlags(decodeAuthorTextPropertySortQuery, sortGolden, [27, 52, 53]);
  throws(() => decodeAuthorTextPropertySortQuery(sortGolden.subarray(0, -1)), ProtocolError);
  rejectPatches(encodeAuthorTextPropertySortQuery, propertySortQuery, [
    { search: { ...propertySortQuery.search, schema: 0n } }, { definitionRevision: 11n },
    { facet: { ...propertySortQuery.facet!, definitionRevision: 11n } }, { facet: { ...propertySortQuery.facet!, definitionId: zeroUuid } },
  ]);

  const base = facetedPayload({ total: 4, states: [4, 0, 0, 0], rows: [row, { ...row, id: 17 }] });
  equal(FrameType.AuthorTextPropertySortPage, 33027);
  const absent = Buffer.from(appendByte(base, 0));
  const present = Buffer.concat([base, Uint8Array.of(1), boolFacetTail]);
  deepEqual(decodeAuthorTextPropertySortPage(absent, false, false), { search: decodeAuthorTextFacetedPage(base), facet: null });
  deepEqual(decodeAuthorTextPropertySortPage(present, false, true), decodeAuthorTextPropertyFacetPage(Buffer.concat([base, boolFacetTail]), false));
  deepEqual(decodeAuthorTextPropertySortPage(absent).search.rows.map(match => match.id), [4, 17]);
  equal(decodeAuthorTextPropertySortPage(pending, false, true).facet, null);
  const heading = withI32(absent, 61, 4);
  equal(decodeAuthorTextPropertySortPage(heading, true).search.rows[0].field, 'heading');
  throws(() => decodeAuthorTextPropertyFacetPage(present), ProtocolError);
  rejectInputs(p => decodeAuthorTextPropertySortPage(p, false, false), [present, appendByte(base, 2), base, heading]);
  rejectInputs(p => decodeAuthorTextPropertySortPage(p, false, true), [absent, appendByte(pending)]);
});

test('property text, qualified property text, and mixed property text codecs preserve field 5, selectors, and heading mode', () => {
  const lexicalQuery: AuthorTextPropertyTextQuery = {
    search: propertyFacetQuery.search, definitionId: propertyFacetQuery.definitionId, definitionRevision: 3n,
  };
  checkPropertyQueryRoundTrip(FrameType.AuthorTextPropertyTextQuery, 33029, FrameType.AuthorTextPropertySortQuery,
    encodeAuthorTextPropertyTextQuery, decodeAuthorTextPropertyTextQuery, lexicalQuery, propertyTextLexical, 24);
  rejectWrongLength(decodeAuthorTextPropertyTextQuery, propertyTextLexical);
  rejectPatches(encodeAuthorTextPropertyTextQuery, lexicalQuery, [
    { search: { ...lexicalQuery.search, schema: 0n } }, { definitionRevision: 0n }, { definitionRevision: 11n }, { definitionId: zeroUuid },
  ]);

  equal(FrameType.AuthorTextPropertyTextPage, 33030);
  const propPage = decodeAuthorTextPropertyTextPage(propertyTextPagePayload);
  expectSingleRow(propPage.rows, 'property-text', 16_379, 16_384, 49_137, 49_142,
    '88c0ad4bb018b4f9fa932dff490c9616d779ca27e05d87a6288d37483d5a0ddd');
  const bodyRow = withI32(propertyTextPagePayload, 61, 2);
  equal(decodeAuthorTextHeadingPage(bodyRow).rows[0].field, 'body');
  const pending = pendingPagePayload();
  equal(decodeAuthorTextPropertyTextPage(pending).ready, false);
  rejectAll([
    () => decodeAuthorTextHeadingPage(propertyTextPagePayload), () => decodeAuthorTextPropertyFacetPage(propertyTextPagePayload),
    () => decodeAuthorTextPropertySortPage(appendByte(propertyTextPagePayload)),
    () => encodeAuthorTextRankedPage({ ready: true, nextCursor: '', rows: propPage.rows }),
  ]);
  rejectInputs(decodeAuthorTextPropertyTextPage, [
    bodyRow,
    withI32(withI32(propertyTextPagePayload, 82, WireLimits.AuthorTextPropertyTextSourceChars - 4), 86, WireLimits.AuthorTextPropertyTextSourceChars + 1),
    withI32(withI32(propertyTextPagePayload, 90, WireLimits.PropertyValueBytes - 4), 94, WireLimits.PropertyValueBytes + 1),
  ]);

  const selectors = Buffer.concat([propFacetSelectorBytes, propSortSelectorBytes]);
  const withBoth = Buffer.concat([propertyTextLexical, selectors]);
  const facetOnly = { ...propertyTextQualifiedQuery, sort: null };
  const sortOnly = { ...propertyTextQualifiedQuery, facet: null, sort: { ...propertyTextQualifiedQuery.sort!, direction: 'ascending' } } as const;
  equal(FrameType.AuthorTextPropertyTextQualifiedQuery, 33035);
  for (const [query, bytes] of [
    [propertyTextQualifiedQuery, withBoth],
    [facetOnly, Buffer.concat([propertyTextLexical, propFacetSelectorBytes, Uint8Array.of(0)])],
    [sortOnly, Buffer.concat([propertyTextLexical, Uint8Array.of(0), withByte(propSortSelectorBytes, 25, 0)])],
  ] as const) {
    assertFramePayload(encodeAuthorTextPropertyTextQualifiedQuery(query), FrameType.AuthorTextPropertyTextQualifiedQuery, bytes);
    deepEqual(decodeAuthorTextPropertyTextQualifiedQuery(bytes), query);
  }
  const oldFrame = encodeAuthorTextPropertyTextQuery(lexicalQuery);
  assertFramePayload(oldFrame, FrameType.AuthorTextPropertyTextQuery, propertyTextLexical);
  const filtered = Buffer.concat([payloadOf(encodeAuthorTextPropertyTextQuery({ ...lexicalQuery, search: qualified })), selectors]);
  assertFramePayload(encodeAuthorTextPropertyTextQualifiedQuery({ ...propertyTextQualifiedQuery, search: qualified }),
    FrameType.AuthorTextPropertyTextQualifiedQuery, filtered);
  deepEqual(decodeAuthorTextPropertyTextQualifiedQuery(filtered).search, decodeAuthorTextQualifiedQuery(payloadOf(encodeAuthorTextQualifiedQuery(qualified))));
  rejectFlags(decodeAuthorTextPropertyTextQualifiedQuery, withBoth, [51, 76, 101]);
  rejectAll([
    () => decodeFrame(oldFrame, FrameType.AuthorTextPropertyTextQualifiedQuery),
    () => decodeFrame(encodeAuthorTextPropertyTextQualifiedQuery(propertyTextQualifiedQuery), FrameType.AuthorTextPropertyTextQuery),
    () => decodeAuthorTextPropertyTextQuery(withBoth),
  ]);
  rejectInputs(decodeAuthorTextPropertyTextQualifiedQuery, [
    propertyTextLexical, withBoth.subarray(0, -1), appendByte(withBoth), Buffer.concat([propertyTextLexical, Uint8Array.of(0, 0)]),
    ...[43, 68, 93].map(offset => withI64(withBoth, offset, 11n)),
  ]);
  rejectPatches(encodeAuthorTextPropertyTextQualifiedQuery, propertyTextQualifiedQuery, [
    { facet: null, sort: null }, { search: { ...propertyTextQualifiedQuery.search, schema: 2n } },
  ]);
  rejectInputs(encodeAuthorTextPropertyTextQualifiedQuery, [
    { ...facetOnly, facet: { ...facetOnly.facet!, definitionRevision: 0n } },
    { ...sortOnly, sort: { ...sortOnly.sort, definitionId: zeroUuid } },
    { ...sortOnly, sort: { ...sortOnly.sort, direction: 'ascending ' } } as unknown as AuthorTextPropertyTextQualifiedQuery,
    { ...sortOnly, sort: { ...sortOnly.sort, definitionRevision: 11n } },
  ]);

  const qualifiedFacet = hexBytes('aaaaaaaaaaaa4aaa8aaa0000000000070400000000000000020000000000000000000000000000000200000000010000000100000000');
  const absent = Buffer.from(appendByte(propertyTextPagePayload, 0));
  const present = Buffer.concat([propertyTextPagePayload, Uint8Array.of(1), qualifiedFacet]);
  const expectedSearch = decodeAuthorTextPropertyTextPage(new Uint8Array(propertyTextPagePayload));
  equal(FrameType.AuthorTextPropertyTextQualifiedPage, 33036);
  const qualifiedPageFrame = encodeFrame(FrameType.AuthorTextPropertyTextQualifiedPage, present);
  deepEqual(decodeAuthorTextPropertyTextQualifiedPage(payloadOf(qualifiedPageFrame, FrameType.AuthorTextPropertyTextQualifiedPage), true), {
    search: expectedSearch, facet: booleanFacet(propertyTextQualifiedQuery.facet!.definitionId, 4n, 0, 0),
  });
  deepEqual(decodeAuthorTextPropertyTextQualifiedPage(new Uint8Array(absent), false), { search: expectedSearch, facet: null });
  const bodyAbsent = withI32(absent, 61, 2);
  equal(decodeAuthorTextPropertySortPage(bodyAbsent, false, false).search.rows[0].field, 'body');
  for (const expectFacet of [false, true]) {
    deepEqual(decodeAuthorTextPropertyTextQualifiedPage(pending, expectFacet), { search: decodeAuthorTextPropertyTextPage(pending), facet: null });
    rejectInputs(p => decodeAuthorTextPropertyTextQualifiedPage(p, expectFacet), [appendByte(pending), Buffer.concat([pending, Uint8Array.of(1), qualifiedFacet])]);
  }
  rejectAll([
    () => decodeFrame(qualifiedPageFrame, FrameType.AuthorTextPropertySortPage),
    () => decodeFrame(qualifiedPageFrame, FrameType.AuthorTextPropertyTextPage),
    () => decodeAuthorTextPropertySortPage(present, false, true),
    () => decodeAuthorTextPropertyTextPage(present),
  ]);
  rejectInputs(p => decodeAuthorTextPropertyTextQualifiedPage(p, false), [present, propertyTextPagePayload, appendByte(propertyTextPagePayload, 2), bodyAbsent]);
  rejectInputs(p => decodeAuthorTextPropertyTextQualifiedPage(p, true), [absent, present.subarray(0, -1), appendByte(present)]);

  const both: AuthorTextPropertyTextMixedQuery = { ...propertyTextQualifiedQuery, includeHeading: true };
  const neither: AuthorTextPropertyTextMixedQuery = { ...both, includeHeading: false, facet: null, sort: null };
  const mixedGolden = Buffer.concat([propertyTextLexical, Uint8Array.of(1), selectors]);
  equal(FrameType.AuthorTextPropertyTextMixedQuery, 33040);
  for (const [query, bytes] of [[both, mixedGolden], [neither, Buffer.concat([propertyTextLexical, Uint8Array.of(0, 0, 0)])]] as const) {
    const frame = encodeAuthorTextPropertyTextMixedQuery(query);
    assertFramePayload(frame, FrameType.AuthorTextPropertyTextMixedQuery, bytes);
    deepEqual(decodeAuthorTextPropertyTextMixedQuery(bytes), query);
    throws(() => decodeFrame(frame, FrameType.AuthorTextPropertyTextQualifiedQuery), ProtocolError);
  }
  const oldQualified = encodeAuthorTextPropertyTextQualifiedQuery(propertyTextQualifiedQuery);
  deepEqual(Buffer.from(payloadOf(oldQualified)), withBoth);
  rejectFlags(decodeAuthorTextPropertyTextMixedQuery, mixedGolden, [51, 52, 77, 102]);
  rejectWrongLength(decodeAuthorTextPropertyTextMixedQuery, mixedGolden);
  rejectAll([
    () => decodeFrame(oldQualified, FrameType.AuthorTextPropertyTextMixedQuery),
    () => decodeAuthorTextPropertyTextMixedQuery(propertyTextLexical),
    () => decodeAuthorTextPropertyTextQualifiedQuery(mixedGolden),
  ]);

  const mixedPage = (fields: readonly number[], suffix: Uint8Array = Uint8Array.of(0)) => {
    const header = Buffer.from(propertyTextPagePayload.subarray(0, 39));
    for (const offset of [5, 9, 35]) header.writeInt32LE(fields.length, offset);
    const rows = fields.map((field, index) => {
      const m = Buffer.from(propertyTextPagePayload.subarray(39));
      m.writeInt32LE(index + 1, 0);
      m.writeInt32LE(field, 22);
      for (const offset of [43, 51]) { m.writeInt32LE(0, offset); m.writeInt32LE(5, offset + 4); }
      return m;
    });
    return Buffer.concat([header, ...rows, suffix]);
  };
  const fields = [1, 2, 3, 5];
  const fieldNames = ['title', 'body', 'summary', 'property-text'];
  const withoutHeading = mixedPage(fields);
  const withHeading = mixedPage([...fields, 4]);
  const mixedFacet = Buffer.concat([Uint8Array.of(1), withI32(qualifiedFacet, 28, 3)]);
  const mixedPresent = mixedPage(fields, mixedFacet);
  equal(FrameType.AuthorTextPropertyTextMixedPage, 33041);
  const mixedFrame = encodeFrame(FrameType.AuthorTextPropertyTextMixedPage, mixedPresent);
  const ready = decodeAuthorTextPropertyTextMixedPage(payloadOf(mixedFrame, FrameType.AuthorTextPropertyTextMixedPage), false, true);
  deepEqual(ready.search.rows.map(m => m.field), fieldNames);
  equal(ready.facet?.definitionId, propertyTextQualifiedQuery.facet?.definitionId);
  deepEqual(decodeAuthorTextPropertyTextMixedPage(withoutHeading, false, false).search.rows.map(m => m.field), fieldNames);
  deepEqual(decodeAuthorTextPropertyTextMixedPage(withHeading, true, false).search.rows.map(m => m.field), [...fieldNames, 'heading']);
  equal(decodeAuthorTextPropertyTextMixedPage(pending, true, true).search.ready, false);
  rejectInputs(p => decodeAuthorTextPropertyTextMixedPage(p, false, false), [withHeading, mixedPage(fields, Uint8Array.of(2)), mixedPresent]);
  rejectAll([
    () => decodeAuthorTextPropertyTextMixedPage(mixedPage([6]), true, false),
    () => decodeAuthorTextPropertyTextMixedPage(withoutHeading, false, true),
    () => decodeAuthorTextPropertyTextQualifiedPage(withoutHeading, false),
    () => decodeFrame(mixedFrame, FrameType.AuthorTextPropertyTextQualifiedPage),
    () => decodeAuthorTextPropertyTextMixedPage(appendByte(pending), true, true),
  ]);
});
