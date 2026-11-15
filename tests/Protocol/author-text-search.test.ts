import { deepEqual, equal, throws } from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import {
  decodeAuthorTextFacetedPage, decodeAuthorTextFacetedQuery, encodeAuthorTextFacetedQuery,
  decodeAuthorTextRankedPage, decodeAuthorTextRankedQuery, decodeAuthorTextSearchPage,
  encodeAuthorTextRankedPage, encodeAuthorTextRankedQuery, type AuthorTextSearchRow, type AuthorTextTaxonomyFacet,
} from '../../src/Contracts/author-text-search.ts';
import { FrameType, WireLimits } from '../../src/Contracts/wire.generated.ts';

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
