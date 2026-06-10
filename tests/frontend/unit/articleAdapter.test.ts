import { describe, expect, it } from 'vitest'
import {
  mapArticleDetailFromPodPayload,
  mapArticlePageFromPodPayload,
  mapRelatedReadingFromPodPayload,
  mapArticleSearchFromPodPayload
} from '@/adapters/binary/articleAdapter'

// ---------------------------------------------------------------------------
// Payload builder helpers — mirror the ArticleDetailPod / ArticleListItemPod
// memory layouts defined in src/shared/Contracts/Models/ArticlePods.cs
// ---------------------------------------------------------------------------

const enc = new TextEncoder()

function writeStr(buf: Uint8Array, offset: number, text: string): void {
  buf.set(enc.encode(text), offset)
}

type RelatedReadingFixtureItem = {
  id: number
  title: string
  summary?: string | null
  createTimeMs: bigint
  reason: string
}

function buildRelatedReadingPayload(opts: {
  related: RelatedReadingFixtureItem[]
  previous?: RelatedReadingFixtureItem | null
  next?: RelatedReadingFixtureItem | null
}): Uint8Array {
  const entries = [
    ...opts.related,
    ...(opts.previous ? [opts.previous] : []),
    ...(opts.next ? [opts.next] : [])
  ]
  const blobChunks: Uint8Array[] = []
  let blobLength = 0
  const appendText = (text: string) => {
    const bytes = enc.encode(text)
    const slice = { offset: blobLength, length: bytes.length }
    blobChunks.push(bytes)
    blobLength += bytes.length
    return slice
  }
  const refs = entries.map((entry) => ({
    title: appendText(entry.title),
    summary: entry.summary == null ? { offset: 0, length: 0 } : appendText(entry.summary),
    reason: appendText(entry.reason)
  }))
  const totalSize = 8 + entries.length * 40 + 4 + blobLength
  const buf = new Uint8Array(totalSize)
  const dv = new DataView(buf.buffer)
  dv.setInt32(0, opts.related.length, true)
  buf[4] = opts.previous ? 1 : 0
  buf[5] = opts.next ? 1 : 0

  let pos = 8
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!
    const ref = refs[i]!
    dv.setInt32(pos, entry.id, true)
    dv.setBigInt64(pos + 4, entry.createTimeMs, true)
    buf[pos + 12] = entry.summary == null ? 0 : 1
    dv.setInt32(pos + 16, ref.title.offset, true)
    dv.setInt32(pos + 20, ref.title.length, true)
    dv.setInt32(pos + 24, ref.summary.offset, true)
    dv.setInt32(pos + 28, ref.summary.length, true)
    dv.setInt32(pos + 32, ref.reason.offset, true)
    dv.setInt32(pos + 36, ref.reason.length, true)
    pos += 40
  }

  dv.setInt32(pos, blobLength, true)
  pos += 4
  for (const chunk of blobChunks) {
    buf.set(chunk, pos)
    pos += chunk.length
  }

  return buf
}

/**
 * Builds a raw binary payload for a single ArticleDetail frame payload.
 *
 * ArticleDetailPod layout (pack=1, little-endian):
 *   offset  0 : id            int32   4 bytes
 *   offset  4 : views         int32   4 bytes
 *   offset  8 : createTimeMs  int64   8 bytes
 *   offset 16 : reserved0     int32   4 bytes  ← only in Detail, not in ListItem
 *   offset 20 : category.id   int32   4 bytes
 *   offset 24 : category.name uint8   128 bytes (null-terminated UTF-8)
 *   offset152 : title         uint8   256 bytes (null-terminated UTF-8)
 *   offset408 : summary       SliceRef(offset int32, length int32)
 *   offset416 : content       SliceRef(offset int32, length int32)
 *   Total     : 424 bytes
 *
 * After the POD:
 *   tag_count     int32
 *   tags[]        TagPod × tag_count  (each 132 bytes: id int32 + name uint8[128])
 *   text_blob_len int32
 *   text_blob     uint8 × text_blob_len
 *   cover_len     int32
 *   cover_blob    uint8 × cover_len
 *   terminator    0x00
 */
function buildArticleDetailPayload(opts: {
  id: number
  views: number
  createTimeMs?: bigint
  reserved0?: number
  categoryId: number
  categoryName: string
  title: string
  summary: string
  content: string
  coverImageUrl?: string
  tags?: Array<{ id: number; name: string }>
}): Uint8Array {
  const {
    id,
    views,
    createTimeMs = 1_715_299_200_000n,
    reserved0 = 0,
    categoryId,
    categoryName,
    title,
    summary,
    content,
    coverImageUrl = '',
    tags = []
  } = opts

  const summaryBytes = enc.encode(summary)
  const contentBytes = enc.encode(content)
  const coverBytes = enc.encode(coverImageUrl)
  const textBlob = new Uint8Array(summaryBytes.length + contentBytes.length)
  textBlob.set(summaryBytes, 0)
  textBlob.set(contentBytes, summaryBytes.length)

  const POD_SIZE = 424
  const tagsSize = tags.length * 132
  const totalSize = POD_SIZE + 4 + tagsSize + 4 + textBlob.length + 4 + coverBytes.length + 1

  const buf = new Uint8Array(totalSize)
  const dv = new DataView(buf.buffer)

  dv.setInt32(0, id, true)
  dv.setInt32(4, views, true)
  dv.setBigInt64(8, createTimeMs, true)
  dv.setInt32(16, reserved0, true)        // reserved0 — must NOT be confused with category.id
  dv.setInt32(20, categoryId, true)        // category.id
  writeStr(buf, 24, categoryName)          // category.name
  writeStr(buf, 152, title)

  // summary SliceRef
  dv.setInt32(408, 0, true)
  dv.setInt32(412, summaryBytes.length, true)

  // content SliceRef
  dv.setInt32(416, summaryBytes.length, true)
  dv.setInt32(420, contentBytes.length, true)

  let pos = POD_SIZE

  // tag count
  dv.setInt32(pos, tags.length, true)
  pos += 4

  for (const tag of tags) {
    dv.setInt32(pos, tag.id, true)
    writeStr(buf, pos + 4, tag.name)
    pos += 132
  }

  // text blob
  dv.setInt32(pos, textBlob.length, true)
  pos += 4
  buf.set(textBlob, pos)
  pos += textBlob.length

  // cover blob
  dv.setInt32(pos, coverBytes.length, true)
  pos += 4
  buf.set(coverBytes, pos)
  pos += coverBytes.length

  // terminator
  buf[pos] = 0x00

  return buf
}

// ---------------------------------------------------------------------------
// ArticleDetail adapter tests
// ---------------------------------------------------------------------------

describe('mapRelatedReadingFromPodPayload', () => {
  it('decodes related, previous, next and nullable summary', () => {
    const firstTime = 1_715_299_200_000n
    const payload = buildRelatedReadingPayload({
      related: [
        {
          id: 10,
          title: 'AEDS public reads',
          summary: 'Binary contract',
          createTimeMs: firstTime,
          reason: '同分类'
        },
        {
          id: 11,
          title: 'Hydration notes',
          summary: null,
          createTimeMs: firstTime + 86_400_000n,
          reason: '全文关键词'
        }
      ],
      previous: {
        id: 9,
        title: 'Previous article',
        summary: 'previous summary',
        createTimeMs: firstTime - 86_400_000n,
        reason: '上一篇'
      },
      next: {
        id: 12,
        title: 'Next article',
        summary: null,
        createTimeMs: firstTime + 172_800_000n,
        reason: '下一篇'
      }
    })

    const result = mapRelatedReadingFromPodPayload(payload)

    expect(result.related).toHaveLength(2)
    expect(result.related[0]).toEqual({
      id: 10,
      title: 'AEDS public reads',
      summary: 'Binary contract',
      createTime: new Date(Number(firstTime)).toISOString(),
      reason: '同分类'
    })
    expect(result.related[1]?.summary).toBeNull()
    expect(result.previous?.reason).toBe('上一篇')
    expect(result.next?.id).toBe(12)
  })

  it('rejects invalid summary flag', () => {
    const payload = buildRelatedReadingPayload({
      related: [
        {
          id: 1,
          title: 'Broken',
          summary: 'bad',
          createTimeMs: 1_715_299_200_000n,
          reason: '同分类'
        }
      ]
    })
    payload[8 + 12] = 2

    expect(() => mapRelatedReadingFromPodPayload(payload)).toThrow()
  })
})

describe('mapArticleDetailFromPodPayload', () => {
  it('reads category.id from offset 20, not from Reserved0 at offset 16', () => {
    // reserved0 = 999 so if the bug is present the test would give id=999 not 7
    const payload = buildArticleDetailPayload({
      id: 1,
      views: 0,
      reserved0: 999,
      categoryId: 7,
      categoryName: 'Frontend',
      title: 'T',
      summary: '',
      content: 'c'
    })

    const result = mapArticleDetailFromPodPayload(payload)

    expect(result.category.id).toBe(7)
    expect(result.category.name).toBe('Frontend')
  })

  it('decodes all scalar fields correctly', () => {
    const createTimeMs = 1_715_299_200_000n // 2024-05-10T00:00:00.000Z
    const payload = buildArticleDetailPayload({
      id: 42,
      views: 100,
      createTimeMs,
      categoryId: 3,
      categoryName: 'Tech',
      title: 'My Article',
      summary: 'Short summary',
      content: 'Full article content'
    })

    const result = mapArticleDetailFromPodPayload(payload)

    expect(result.id).toBe(42)
    expect(result.views).toBe(100)
    expect(result.title).toBe('My Article')
    expect(result.summary).toBe('Short summary')
    expect(result.content).toBe('Full article content')
    expect(result.coverImageUrl).toBe('')
    expect(result.category.id).toBe(3)
    expect(result.category.name).toBe('Tech')
    expect(result.createTime).toBe(new Date(Number(createTimeMs)).toISOString())
  })

  it('decodes cover image url from the trailing cover blob', () => {
    const payload = buildArticleDetailPayload({
      id: 9,
      views: 0,
      categoryId: 2,
      categoryName: 'Images',
      title: 'With cover',
      summary: '',
      content: 'body',
      coverImageUrl: '/uploads/illustration/cover.webp'
    })

    const result = mapArticleDetailFromPodPayload(payload)

    expect(result.coverImageUrl).toBe('/uploads/illustration/cover.webp')
  })

  it('decodes tags correctly', () => {
    const payload = buildArticleDetailPayload({
      id: 1,
      views: 0,
      categoryId: 1,
      categoryName: 'Dev',
      title: 'T',
      summary: '',
      content: 'c',
      tags: [
        { id: 10, name: 'rust' },
        { id: 11, name: 'wasm' }
      ]
    })

    const result = mapArticleDetailFromPodPayload(payload)

    expect(result.tags).toHaveLength(2)
    expect(result.tags[0]).toEqual({ id: 10, name: 'rust' })
    expect(result.tags[1]).toEqual({ id: 11, name: 'wasm' })
  })

  it('handles zero-length summary and content without throwing', () => {
    const payload = buildArticleDetailPayload({
      id: 5,
      views: 0,
      categoryId: 2,
      categoryName: 'Notes',
      title: 'Empty',
      summary: '',
      content: ''
    })

    const result = mapArticleDetailFromPodPayload(payload)

    expect(result.summary).toBe('')
    expect(result.content).toBe('')
  })

  it('handles multibyte UTF-8 category names', () => {
    const payload = buildArticleDetailPayload({
      id: 1,
      views: 0,
      categoryId: 5,
      categoryName: '前端开发',
      title: 'T',
      summary: '',
      content: 'c'
    })

    const result = mapArticleDetailFromPodPayload(payload)

    expect(result.category.id).toBe(5)
    expect(result.category.name).toBe('前端开发')
  })

  it('throws on a payload that is too short', () => {
    expect(() => mapArticleDetailFromPodPayload(new Uint8Array(4))).toThrow()
  })
})

// ---------------------------------------------------------------------------
// ArticlePage adapter — smoke test for compact v2 category fields in list items.
// ---------------------------------------------------------------------------

describe('mapArticlePageFromPodPayload', () => {
  /**
   * Compact ArticleList record (56B):
   * id, views, createTimeMs, categoryId, categoryName slice, title slice,
   * summary slice, tagStart, tagCount, isDeleted, hasIsDeleted, reserved.
   */
  function buildArticleListPayload(items: Array<{
    id: number
    categoryId: number
    categoryName: string
    title: string
  }>): Uint8Array {
    const ITEM_RECORD_SIZE = 56
    const summary = 'sum'
    const blobParts: Uint8Array[] = []
    const slices: Array<{ category: [number, number], title: [number, number], summary: [number, number] }> = []
    let blobLength = 0
    const pushText = (value: string): [number, number] => {
      const bytes = enc.encode(value)
      const slice: [number, number] = [blobLength, bytes.byteLength]
      blobParts.push(bytes)
      blobLength += bytes.byteLength
      return slice
    }

    for (const item of items) {
      slices.push({
        category: pushText(item.categoryName),
        title: pushText(item.title),
        summary: pushText(summary)
      })
    }

    const envelope = new Uint8Array(16 + blobLength + items.length * ITEM_RECORD_SIZE)
    const edv = new DataView(envelope.buffer)
    edv.setInt32(0, items.length, true) // total
    edv.setInt32(4, items.length, true) // count
    edv.setInt32(8, 0, true) // tagRecordCount
    edv.setInt32(12, blobLength, true)
    let pos = 16
    for (const part of blobParts) {
      envelope.set(part, pos)
      pos += part.byteLength
    }
    items.forEach((item, index) => {
      const recordOffset = pos + index * ITEM_RECORD_SIZE
      const slice = slices[index]!
      edv.setInt32(recordOffset, item.id, true)
      edv.setInt32(recordOffset + 4, 0, true)
      edv.setBigInt64(recordOffset + 8, 1_715_299_200_000n, true)
      edv.setInt32(recordOffset + 16, item.categoryId, true)
      edv.setInt32(recordOffset + 20, slice.category[0], true)
      edv.setInt32(recordOffset + 24, slice.category[1], true)
      edv.setInt32(recordOffset + 28, slice.title[0], true)
      edv.setInt32(recordOffset + 32, slice.title[1], true)
      edv.setInt32(recordOffset + 36, slice.summary[0], true)
      edv.setInt32(recordOffset + 40, slice.summary[1], true)
      edv.setInt32(recordOffset + 44, 0, true)
      edv.setInt32(recordOffset + 48, 0, true)
    })
    pos += items.length * ITEM_RECORD_SIZE
    if (pos !== envelope.byteLength) {
      throw new Error('fixture_size_mismatch')
    }
    return envelope
  }

  it('reads category.id and category.name for list items', () => {
    const payload = buildArticleListPayload([
      { id: 1, categoryId: 9, categoryName: 'Backend', title: 'Post A' }
    ])

    const result = mapArticlePageFromPodPayload(payload)

    expect(result.items).toHaveLength(1)
    expect(result.items[0]!.category.id).toBe(9)
    expect(result.items[0]!.category.name).toBe('Backend')
  })
})

describe('mapArticleSearchFromPodPayload', () => {
  function appendU32(bytes: number[], value: number): void {
    bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff)
  }

  function appendI64(bytes: number[], value: bigint): void {
    for (let shift = 0n; shift < 64n; shift += 8n) {
      bytes.push(Number((value >> shift) & 0xffn))
    }
  }

  function pushText(blob: number[], text: string): { offset: number; length: number } {
    const encoded = [...enc.encode(text)]
    const offset = blob.length
    blob.push(...encoded)
    return { offset, length: encoded.length }
  }

  function appendRef(bytes: number[], ref: { offset: number; length: number }): void {
    appendU32(bytes, ref.offset)
    appendU32(bytes, ref.length)
  }

  it('decodes compact search result v3 payload', () => {
    const blob: number[] = []
    const category = pushText(blob, '技术')
    const title = pushText(blob, 'Search v3')
    const summary = pushText(blob, '更小的搜索结果')
    const tag = pushText(blob, 'wasm')
    const records: number[] = []
    appendU32(records, 42)
    appendU32(records, 7)
    appendI64(records, 1_715_299_200_000n)
    appendU32(records, 3)
    appendRef(records, category)
    appendRef(records, title)
    appendRef(records, summary)
    appendU32(records, 0)
    appendU32(records, 1)

    const tagRecords: number[] = []
    appendU32(tagRecords, 9)
    appendRef(tagRecords, tag)

    const header: number[] = []
    const tagOffset = 24 + records.length
    const blobOffset = tagOffset + tagRecords.length
    appendU32(header, 0x33525346)
    appendU32(header, 3)
    appendU32(header, 1)
    appendU32(header, 1)
    appendU32(header, tagOffset)
    appendU32(header, blobOffset)

    const payload = new Uint8Array([...header, ...records, ...tagRecords, ...blob])
    const result = mapArticleSearchFromPodPayload(payload)

    expect(result.total).toBe(1)
    expect(result.items[0]).toMatchObject({
      id: 42,
      views: 7,
      title: 'Search v3',
      summary: '更小的搜索结果',
      category: { id: 3, name: '技术' },
      tags: [{ id: 9, name: 'wasm' }]
    })
  })
})
