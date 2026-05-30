import { describe, it, expect } from 'vitest'
import {
  readCategoryPod,
  readTagList,
  readFeaturedArticleItem
} from '@/adapters/binary/podReaders'
import { BinaryReader } from '@/adapters/binary/reader'
import {
  TAG_POD_SIZE,
  FEATURED_ARTICLE_POD_SIZE,
  COMMENT_REPLY_ITEM_POD_SIZE,
  COMMENT_REPLY_PREVIEW_ITEM_POD_SIZE
} from '@/adapters/binary/types'

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function writeInt32(b: Uint8Array, off: number, v: number): void {
  b[off] = v & 0xff
  b[off + 1] = (v >>> 8) & 0xff
  b[off + 2] = (v >>> 16) & 0xff
  b[off + 3] = (v >>> 24) & 0xff
}

function writeInt64(b: Uint8Array, off: number, v: bigint): void {
  let r = v & 0xffffffffffffffffn
  for (let i = 0; i < 8; i++) { b[off + i] = Number(r & 0xffn); r >>= 8n }
}

function enc(text: string): Uint8Array { return new TextEncoder().encode(text) }

function writeUtf8(b: Uint8Array, off: number, text: string, _len: number): void {
  const bytes = enc(text)
  b.set(bytes.subarray(0, _len), off)
}

// ---------------------------------------------------------------------------
// readCategoryPod
// ---------------------------------------------------------------------------
describe('readCategoryPod', () => {
  it('reads id at given offset', () => {
    const pod = new Uint8Array(200)
    writeInt32(pod, 20, 99)
    writeUtf8(pod, 24, 'Technology', 128)
    const cat = readCategoryPod(pod, 20, 24, 128)
    expect(cat.id).toBe(99)
    expect(cat.name).toBe('Technology')
  })

  it('can read from different offsets (list vs detail)', () => {
    const pod = new Uint8Array(200)
    writeInt32(pod, 16, 5)   // list item offset
    writeInt32(pod, 20, 10)  // detail offset
    expect(readCategoryPod(pod, 16, 20, 128).id).toBe(5)
    expect(readCategoryPod(pod, 20, 24, 128).id).toBe(10)
  })
})

// ---------------------------------------------------------------------------
// readTagList
// ---------------------------------------------------------------------------
describe('readTagList', () => {
  it('returns empty array when count is 0', () => {
    const b = new Uint8Array(4) // count = 0
    const r = new BinaryReader(b)
    expect(readTagList(r)).toEqual([])
  })

  it('reads multiple tags', () => {
    const count = new Uint8Array(4)
    writeInt32(count, 0, 2)
    const tag1 = new Uint8Array(TAG_POD_SIZE)
    const tag2 = new Uint8Array(TAG_POD_SIZE)
    writeInt32(tag1, 0, 1); writeUtf8(tag1, 4, 'A', 128)
    writeInt32(tag2, 0, 2); writeUtf8(tag2, 4, 'B', 128)
    const merged = new Uint8Array(4 + TAG_POD_SIZE * 2)
    merged.set(count, 0)
    merged.set(tag1, 4)
    merged.set(tag2, 4 + TAG_POD_SIZE)
    const r = new BinaryReader(merged)
    const tags = readTagList(r)
    expect(tags).toHaveLength(2)
    expect(tags[0]).toEqual({ id: 1, name: 'A' })
    expect(tags[1]).toEqual({ id: 2, name: 'B' })
  })

  it('throws when tag count is negative', () => {
    const b = new Uint8Array(4)
    writeInt32(b, 0, -1)
    const r = new BinaryReader(b)
    expect(() => readTagList(r)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// readFeaturedArticleItem
// ---------------------------------------------------------------------------
describe('readFeaturedArticleItem', () => {
  it('reads id, views, title, cover, date, and category', () => {
    const pod = new Uint8Array(FEATURED_ARTICLE_POD_SIZE)
    const cover = '/uploads/featured.webp'
    const coverBytes = enc(cover)

    writeInt32(pod, 0, 12)
    writeInt32(pod, 4, 777)
    writeInt64(pod, 8, 1700000100000n)
    writeInt32(pod, 16, 9)
    writeUtf8(pod, 20, 'Featured', 128)
    writeUtf8(pod, 148, 'Featured Article', 256)
    writeInt32(pod, 404, 0)
    writeInt32(pod, 408, coverBytes.length)

    const blobLen = new Uint8Array(4)
    writeInt32(blobLen, 0, coverBytes.length)
    const merged = new Uint8Array(FEATURED_ARTICLE_POD_SIZE + 4 + coverBytes.length)
    merged.set(pod, 0)
    merged.set(blobLen, FEATURED_ARTICLE_POD_SIZE)
    merged.set(coverBytes, FEATURED_ARTICLE_POD_SIZE + 4)

    const item = readFeaturedArticleItem(new BinaryReader(merged))
    expect(item).toEqual({
      id: 12,
      title: 'Featured Article',
      coverImageUrl: cover,
      views: 777,
      createTime: new Date(1700000100000).toISOString(),
      category: { id: 9, name: 'Featured' }
    })
  })
})

// NOTE:
// Internal helpers like readTagPod/readCommentCore/readReplyItemFromReader/
// readReplyPreviewItemFromReader are intentionally not exported.
// Public behavior is covered via readTagList, readFeaturedArticleItem and higher adapters.
