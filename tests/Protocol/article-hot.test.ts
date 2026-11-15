import { deepStrictEqual, equal, throws } from 'node:assert/strict'
import { hexFixture } from './fixture-source.ts'
import { test } from 'node:test'
import { decodeFrame, encodeFrame, ProtocolError } from '../../src/Contracts/aeds.ts'
import { decodeArticleHot, encodeArticleHot, type PopularArticle } from '../../src/Contracts/article-hot.ts'
import { FrameType, WireRoutes } from '../../src/Contracts/wire.generated.ts'

function fixture(name: string): Buffer {
  return hexFixture(name)
}

test('ArticleHot matches independently encoded fixed v1 AEDS bytes', () => {
  equal(FrameType.ArticleHot, 3)
  equal(WireRoutes.PublicArticleHot, '/api/binary/article/hot/{size}.aeds')
  const frame = fixture('article-hot-v1.hex')
  const items: PopularArticle[] = [
    { id: 42, views: 0, title: '雪 🐈' },
    { id: 7, views: 0x7fffffff, title: '' },
    { id: 19, views: 9, title: '\uFEFFCafe\u0301' },
  ]
  deepStrictEqual(Buffer.from(encodeFrame(FrameType.ArticleHot, encodeArticleHot(items))), frame)
  deepStrictEqual(decodeArticleHot(decodeFrame(frame, FrameType.ArticleHot).payload), items)
  const empty = fixture('article-hot-empty-v1.hex')
  deepStrictEqual(Buffer.from(encodeFrame(FrameType.ArticleHot, encodeArticleHot([]))), empty)
  deepStrictEqual(decodeArticleHot(decodeFrame(empty, FrameType.ArticleHot).payload), [])
})

test('ArticleHot enforces count, identities, signed int32 views and UTF-8 byte limits', () => {
  const title = '界'.repeat(84) + '🐈'
  const maximum = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, views: 0, title }))
  deepStrictEqual(decodeArticleHot(encodeArticleHot(maximum)), maximum)
  for (const rows of [
    [...maximum, { id: 101, views: 0, title }],
    [{ id: 1, views: 0, title: title + 'a' }],
    [{ id: 1, views: 0, title: '\uD800' }],
    [{ id: 1, views: -1, title }],
    [{ id: 1, views: 0x80000000, title }],
    [{ id: 1, views: NaN, title }],
    [{ id: 0, views: 0, title }],
    [{ id: 0x80000000, views: 0, title }],
    [{ id: 1, views: 0, title }, { id: 1, views: 0, title }],
  ]) throws(() => encodeArticleHot(rows), ProtocolError)
})

test('ArticleHot rejects invalid rows, unclaimed blob bytes, and truncated or trailing payload', () => {
  const frame = fixture('article-hot-v1.hex')
  const { payload } = decodeFrame(frame, FrameType.ArticleHot)
  const recordsAt = 8 + 17
  for (const [position, value] of [
    [0, -1], [0, 101], [4, -1], [4, 0x7fffffff], [recordsAt, 0], [recordsAt + 4, -1],
    [recordsAt + 8, 1], [recordsAt + 12, 257], [recordsAt + 16, 42], [recordsAt + 32 + 12, 0],
  ]) {
    const malformed = Uint8Array.from(payload)
    new DataView(malformed.buffer).setInt32(position, value, true)
    throws(() => decodeArticleHot(decodeFrame(encodeFrame(FrameType.ArticleHot, malformed), FrameType.ArticleHot).payload), ProtocolError)
  }
  throws(() => decodeFrame(encodeFrame(FrameType.ArticleList, payload), FrameType.ArticleHot), ProtocolError)
  throws(() => decodeArticleHot(payload.subarray(0, -1)), ProtocolError)
  throws(() => decodeArticleHot(Uint8Array.of(...payload, 0)), ProtocolError)
  const malformed = Uint8Array.from(payload)
  malformed[8] = 0xff
  throws(() => decodeArticleHot(malformed), ProtocolError)
})
