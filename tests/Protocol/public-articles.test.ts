import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { decodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts';
import { decodeArticle, decodeArticleList, decodeSearch } from '../../src/Contracts/public-articles.ts';
import { FrameType, WireLayouts as layout } from '../../src/Contracts/wire.generated.ts';

function fixture(name: string, type: FrameType): Uint8Array {
  const hex = readFileSync(new URL(`fixtures/${name}.hex`, import.meta.url), 'utf8').trim();
  return decodeFrame(Buffer.from(hex, 'hex'), type).payload;
}

test('public HTTP article frames preserve their current layout and exact 64-bit coordinates', () => {
  const detail = decodeArticle(fixture('article-detail-ard5', FrameType.ArticleDetail));
  const list = decodeArticleList(fixture('article-list-cursor-v2', FrameType.ArticleList));
  const search = decodeSearch(fixture('article-search-fas4', FrameType.ArticleSearch));
  assert.equal(detail.body, '第一行\nsecond line\n');
  assert.equal(detail.updatedAt, 1700000001234);
  assert.equal(detail.publishedAt, 1700000002345);
  assert.equal(list.articles[0].publishedAt, detail.publishedAt);
  assert.equal(list.total, 2);
  assert.equal(list.nextCursor, 'v2_Ab-1');
  assert.equal(search.total, 1);
  for (const item of [detail, list.articles[0], search.articles[0]]) {
    assert.equal(item.id, 42);
    assert.equal(item.createdAt, 1700000000123);
    assert.equal(item.revision, 9007199254740993n);
    assert.equal(item.revisionNo, 4);
    assert.equal(item.publication, 9007199254741001n);
    assert.equal(item.publicationNo, 2);
    assert.equal(item.title, '雪原 🐈');
    assert.equal(item.summary, '摘要');
  }
});

test('historical public article payload variants are refused', () => {
  assert.throws(() => decodeArticle(fixture('article-detail-v1-wire', FrameType.ArticleDetail)), ProtocolError);
  assert.throws(() => decodeArticle(fixture('article-detail-v4-v1-wire', FrameType.ArticleDetail)), ProtocolError);
  assert.throws(() => decodeArticleList(fixture('article-list-v1-wire', FrameType.ArticleList)), ProtocolError);
  assert.throws(() => decodeSearch(fixture('article-search-v1-wire', FrameType.ArticleSearch)), ProtocolError);

  const list = fixture('article-list-cursor-v2', FrameType.ArticleList);
  // The reference envelope can carry either historical list record width.
  const recordStart = list.length - layout.ArticleListRecordSizeCurrent;
  for (const legacyWidth of [56, 76]) {
    assert.throws(() => decodeArticleList(list.subarray(0, recordStart + legacyWidth)), ProtocolError);
  }
  const oldCursorVersion = Uint8Array.from(list);
  new DataView(oldCursorVersion.buffer).setInt32(4, 1, true);
  assert.throws(() => decodeArticleList(oldCursorVersion), ProtocolError);
});

test('public article payloads reject truncation, contradictory coordinates and trailing bytes', () => {
  const detail = fixture('article-detail-ard5', FrameType.ArticleDetail);
  const list = fixture('article-list-cursor-v2', FrameType.ArticleList);
  const search = fixture('article-search-fas4', FrameType.ArticleSearch);
  for (const [decode, payload] of [
    [decodeArticle, detail],
    [decodeArticleList, list],
    [decodeSearch, search],
  ] as const) {
    assert.throws(() => decode(payload.subarray(0, payload.length - 1)), ProtocolError);
    assert.throws(() => decode(Uint8Array.from([...payload, 0])), ProtocolError);
  }

  const badDetail = Uint8Array.from(detail);
  const detailView = new DataView(badDetail.buffer);
  detailView.setBigInt64(layout.ArticleDetailHeaderSize + layout.ArticleDetailCoordinatesOffset, 0n, true);
  assert.throws(() => decodeArticle(badDetail), ProtocolError);

  const badList = Uint8Array.from(list);
  const recordStart = badList.length - layout.ArticleListRecordSizeCurrent;
  const listView = new DataView(badList.buffer);
  listView.setInt32(recordStart + layout.ArticleListTagCountOffset, 1, true);
  assert.throws(() => decodeArticleList(badList), ProtocolError);
  listView.setInt32(recordStart + layout.ArticleListTagCountOffset, 0, true);
  badList[recordStart + layout.ArticleListDeletedOffset + 2] = 1;
  assert.throws(() => decodeArticleList(badList), ProtocolError);

  const badSearch = Uint8Array.from(search);
  badSearch[12 + layout.ArticleSearchTitleOffset] = 0xff;
  assert.throws(() => decodeSearch(badSearch), ProtocolError);
});
