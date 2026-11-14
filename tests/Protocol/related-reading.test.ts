import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decodeFrame, encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import { decodeRelatedReading, publicRelatedReading } from '../../src/Contracts/related-reading.ts';
import { FrameType, WireLayouts as layout } from '../../src/Contracts/wire.generated.ts';

const path = new URL('fixtures/article-related-reading-v1.hex', import.meta.url);
const golden = Uint8Array.from(Buffer.from(readFileSync(path, 'utf8').replace(/\s/g, ''), 'hex'));
const bytes = decodeFrame(golden, FrameType.ArticleRelatedReading).payload;

test('related reading decodes the pinned v1 frame and distinguishes null and absent navigation', () => {
  const result = decodeRelatedReading(bytes);
  assert.deepEqual(result.related, [
    { id: 10, createdAt: 1779019200000, title: 'AEDS public reads', summary: 'Binary contract', reason: '同分类' },
    { id: 11, createdAt: 1779105600000, title: 'Hydration notes', summary: null, reason: '全文关键词' },
  ]);
  assert.equal(result.previous?.title, 'Previous article');
  assert.equal(result.next?.title, 'Next article');
  assert.deepEqual(decodeRelatedReading(new Uint8Array(12)), { related: [], previous: null, next: null });
});

test('related reading rejects malformed flags, ranges, identity and trailing bytes', async t => {
  for (const length of [0, 11, bytes.length - 1])
    assert.throws(() => decodeRelatedReading(bytes.subarray(0, length)), ProtocolError);
  function corrupt(at: number, value: number) {
    const altered = Uint8Array.from(bytes);
    altered[at] = value;
    assert.throws(() => decodeRelatedReading(altered), ProtocolError);
  }
  corrupt(0, 7);
  corrupt(layout.RelatedReadingPreviousOffset, 2);
  corrupt(6, 1);
  corrupt(layout.RelatedReadingHeaderSize + layout.RelatedReadingItemHasSummaryOffset, 0);
  corrupt(layout.RelatedReadingHeaderSize + layout.RelatedReadingItemTitleOffset, 12);
  corrupt(layout.RelatedReadingHeaderSize + layout.RelatedReadingItemSize, 10);
  assert.throws(() => decodeRelatedReading(Uint8Array.from([...bytes, 0])), ProtocolError);

  const response = encodeFrame(FrameType.ArticleRelatedReading, bytes);
  const fetch = t.mock.method(globalThis, 'fetch', (url: string) => {
    assert.equal(url, '/api/binary/article/10/related.aeds?publication=9007199254741001');
    return new Response(response, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
  });
  await assert.rejects(publicRelatedReading(10, 9007199254741001n, new AbortController().signal), ProtocolError);
  assert.equal(fetch.mock.callCount(), 1);
});
