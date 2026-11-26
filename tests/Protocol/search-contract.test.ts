import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decodeFrame, encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import {
  decodePublicSearchV2,
  sliceSnippetHighlights,
} from '../../src/Contracts/public-search-v2.ts';
import {
  encodePublicSearchResult,
  FrameType,
  PublicSearchMatchTier,
  PublicSearchSnippetField,
  PublicSearchTotalRelation,
  WireLimits,
  WireRoutes,
  type PublicSearchResult,
} from '../../src/Contracts/wire.generated.ts';
import { hexFixture } from './fixture-source.ts';
import { oneHitSearchResult } from './public-search-fixture.ts';

test('PublicSearchResult v2 golden AEDS vector matches C# encoder byte-for-byte', () => {
  assert.equal(WireRoutes.PublicSearchV2, '/api/v2/public/search.aeds');
  assert.equal(FrameType.PublicSearchResult, 33081);

  const wireBytes = Uint8Array.from(hexFixture('public-search-result-v2.hex', 'strip'));
  const frame = decodeFrame(wireBytes, FrameType.PublicSearchResult);
  const decoded = decodePublicSearchV2(frame.payload, '9876543210123');

  assert.equal(decoded.generation, '9876543210123');
  assert.equal(decoded.profileVersion, WireLimits.SearchFas4Profile);
  assert.equal(decoded.analyzerVersion, WireLimits.SearchAnalyzerVersion);
  assert.equal(decoded.total, 2);
  assert.equal(decoded.totalRelation, 'exact');
  assert.equal(decoded.primaryCount, 1);
  assert.equal(decoded.relaxedCount, 1);
  assert.equal(decoded.hasMore, true);
  assert.equal(decoded.nextCursor, 'AbCdEf0123456789_-');
  assert.equal(decoded.items.length, 2);

  const [first, second] = decoded.items;
  assert.equal(first.id, 42);
  assert.equal(first.matchTier, 'primary');
  assert.equal(first.snippetField, 'body');
  assert.equal(first.category.id, 4);
  assert.equal(first.category.name, '系统设计');
  assert.deepEqual(first.tags, [{ id: 10, name: '搜索' }, { id: 12, name: 'Rust' }]);
  assert.deepEqual(first.highlights, [{ start: 21, end: 23 }]);
  assert.equal(first.snippet.slice(first.highlights[0].start, first.highlights[0].end), '搜索');

  const segments = sliceSnippetHighlights(first.snippet, first.highlights);
  assert.deepEqual(segments, [
    { text: '🚀 使用 <script> 原始文本进行', highlight: false },
    { text: '搜索', highlight: true },
    { text: '测试', highlight: false },
  ]);

  assert.equal(second.id, 9);
  assert.equal(second.matchTier, 'relaxed');
  assert.equal(second.snippetField, 'none');
  assert.equal(second.snippet, '');
  assert.deepEqual(second.highlights, []);

  // Re-encode in TypeScript and prove byte-for-byte parity with the C# golden frame
  const roundTripPayload = encodePublicSearchResult({
    generation: 9876543210123n,
    profileVersion: WireLimits.SearchFas4Profile,
    analyzerVersion: WireLimits.SearchAnalyzerVersion,
    totalCount: 2,
    totalRelation: PublicSearchTotalRelation.Exact,
    primaryCount: 1,
    relaxedCount: 1,
    hasMore: true,
    nextCursor: 'AbCdEf0123456789_-',
    items: [
      {
        id: 42,
        revision: 7n,
        revisionNo: 7,
        publication: 7001n,
        publicationNo: 3,
        publishedAtUnixMs: 1770000000000n,
        createdAtUnixMs: 1769990000000n,
        views: 19,
        categoryId: 4,
        categoryName: '系统设计',
        tags: [{ id: 10, name: '搜索' }, { id: 12, name: 'Rust' }],
        title: '🚀 搜索契约与高亮',
        summary: '摘要文本',
        matchTier: PublicSearchMatchTier.Primary,
        snippetField: PublicSearchSnippetField.Body,
        snippet: '🚀 使用 <script> 原始文本进行搜索测试',
        highlights: [{ start: 21, end: 23 }],
      },
      {
        id: 9,
        revision: 2n,
        revisionNo: 2,
        publication: 2001n,
        publicationNo: 1,
        publishedAtUnixMs: 1769000000000n,
        createdAtUnixMs: 1768990000000n,
        views: 0,
        categoryId: 0,
        categoryName: '',
        tags: [],
        title: '部分匹配条目',
        summary: '回退摘要',
        matchTier: PublicSearchMatchTier.Relaxed,
        snippetField: PublicSearchSnippetField.None,
        snippet: '',
        highlights: [],
      },
    ],
  });
  assert.deepEqual(encodeFrame(FrameType.PublicSearchResult, roundTripPayload), wireBytes);
});

test('decodePublicSearchV2 rejects malformed counts, cursors, generations, and surrogate-splitting highlights', () => {
  const base = oneHitSearchResult({
    id: 1, publishedAtUnixMs: 1770000000000n, title: 'Test',
    snippetField: PublicSearchSnippetField.Body, snippet: '🚀 abc', highlights: [{ start: 3, end: 6 }],
  }, { generation: 100n });

  assert.throws(() => decodePublicSearchV2(encodePublicSearchResult(base), '999'), ProtocolError);

  const invalidCases: PublicSearchResult[] = [
    { ...base, hasMore: true, nextCursor: '' },
    { ...base, hasMore: false, nextCursor: 'abc' },
    { ...base, hasMore: true, nextCursor: 'bad+cursor=' },
    { ...base, totalCount: 3, totalRelation: PublicSearchTotalRelation.Exact },
    { ...base, totalCount: 0, totalRelation: PublicSearchTotalRelation.LowerBound },
    // Surrogate split on start=1 (low surrogate of 🚀)
    { ...base, items: [{ ...base.items[0], highlights: [{ start: 1, end: 3 }] }] },
    // Surrogate split on end=1 (high surrogate of 🚀)
    { ...base, items: [{ ...base.items[0], highlights: [{ start: 0, end: 1 }] }] },
    // Overlapping highlights
    { ...base, items: [{ ...base.items[0], highlights: [{ start: 3, end: 5 }, { start: 4, end: 6 }] }] },
    // SnippetField.None with snippet content
    { ...base, items: [{ ...base.items[0], snippetField: PublicSearchSnippetField.None }] },
  ];

  for (const invalid of invalidCases) {
    assert.throws(() => decodePublicSearchV2(encodePublicSearchResult(invalid), '100'), ProtocolError);
  }
});
