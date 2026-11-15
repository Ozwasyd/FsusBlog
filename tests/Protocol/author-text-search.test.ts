import { deepEqual, equal, throws } from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import {
  decodeAuthorTextRankedPage, decodeAuthorTextRankedQuery, decodeAuthorTextSearchPage,
  encodeAuthorTextRankedPage, encodeAuthorTextRankedQuery, type AuthorTextSearchRow,
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
