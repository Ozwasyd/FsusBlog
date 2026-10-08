import { ARTICLE_LIST_WIRE } from '@/generated/aedsArticleListWire'
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
 * Builds the retired ArticleDetail payload. V3 decoder tests keep this only to
 * assert that old payloads fail instead of taking a compatibility branch.
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
function buildLegacyArticleDetailPayload(opts: {
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

const ARTICLE_DETAIL_HEADER_SIZE = 44
const ARTICLE_DETAIL_V3_RECORD_SIZE = 84
const ARTICLE_DETAIL_V4_RECORD_SIZE = 92
const ARTICLE_DETAIL_V5_RECORD_SIZE = 116
const ARTICLE_DETAIL_TAG_V3_RECORD_SIZE = 12
const ARTICLE_RIGHTS_V3_RECORD_SIZE = 112
const ARTICLE_DETAIL_V3_MAGIC = 0x41524433
const ARTICLE_DETAIL_V3_VERSION = 3
const ARTICLE_DETAIL_V4_MAGIC = 0x41524434
const ARTICLE_DETAIL_V4_VERSION = 4
const ARTICLE_DETAIL_V5_MAGIC = 0x41524435
const ARTICLE_DETAIL_V5_VERSION = 5

const ArticleDetailRightsFlags = {
  Enabled: 1 << 0,
  AllowCodeCopy: 1 << 1,
  ShowPublicBadge: 1 << 2,
  ProofBindingEnabled: 1 << 3,
  HasCopyrightYear: 1 << 4,
  HasCopyrightHolder: 1 << 5,
  HasRightsStatement: 1 << 6,
  HasAttributionTemplate: 1 << 7,
  HasCanonicalUrl: 1 << 8,
  HasProofUrl: 1 << 9,
  HasProofStatus: 1 << 10
} as const

function buildArticleDetailV4Payload(opts: {
  id: number
  views: number
  createTimeMs?: bigint
  categoryId: number
  categoryName: string
  title: string
  summary: string
  content: string
  coverImageUrl?: string
  tags?: Array<{ id: number; name: string }>
  status?: number
  scheduledPublishAtMs?: bigint
  publishedAtMs?: bigint
  updatedAtMs?: bigint
  isDeleted?: boolean
  rights?: Partial<{
    snapshotId: bigint
    articleRevisionId: bigint
    revisionNo: number
    enabled: boolean
    licenseType: string
    copyrightHolder: string | null
    copyrightYear: number | null
    rightsStatement: string | null
    attributionTemplate: string | null
    copyPolicy: string
    maxExcerptChars: number
    allowCodeCopy: boolean
    showPublicBadge: boolean
    proofBindingEnabled: boolean
    canonicalUrl: string | null
    policyHash: string
    contentCanonicalHash: string
    proofUrl: string | null
    proofStatus: string | null
  }>
}): Uint8Array {
  const tags = opts.tags ?? []
  const rights = {
    snapshotId: 901n,
    articleRevisionId: 801n,
    revisionNo: 7,
    enabled: true,
    licenseType: 'CC-BY-4.0',
    copyrightHolder: 'Fésus',
    copyrightYear: 2026,
    rightsStatement: 'Line one\nLine two',
    attributionTemplate: '{title} — {holder}',
    copyPolicy: 'append-attribution',
    maxExcerptChars: 300,
    allowCodeCopy: true,
    showPublicBadge: false,
    proofBindingEnabled: true,
    canonicalUrl: 'https://example.test/article/10',
    policyHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    contentCanonicalHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    proofUrl: 'urn:fsus:rights-proof:901',
    proofStatus: 'ready',
    ...opts.rights
  }
  const blobChunks: Uint8Array[] = []
  let blobLength = 0
  const appendText = (text: string | null | undefined) => {
    const bytes = enc.encode(text ?? '')
    const slice = { offset: blobLength, length: bytes.byteLength }
    blobChunks.push(bytes)
    blobLength += bytes.byteLength
    return slice
  }
  const articleSlices = {
    title: appendText(opts.title),
    content: appendText(opts.content),
    summary: appendText(opts.summary),
    coverImageUrl: appendText(opts.coverImageUrl ?? ''),
    categoryName: appendText(opts.categoryName)
  }
  const tagSlices = tags.map((tag) => appendText(tag.name))
  const rightsSlices = {
    licenseType: appendText(rights.licenseType),
    copyrightHolder: appendText(rights.copyrightHolder),
    rightsStatement: appendText(rights.rightsStatement),
    attributionTemplate: appendText(rights.attributionTemplate),
    copyPolicy: appendText(rights.copyPolicy),
    canonicalUrl: appendText(rights.canonicalUrl),
    policyHash: appendText(rights.policyHash),
    contentCanonicalHash: appendText(rights.contentCanonicalHash),
    proofUrl: appendText(rights.proofUrl),
    proofStatus: appendText(rights.proofStatus)
  }

  const articleOffset = ARTICLE_DETAIL_HEADER_SIZE
  const tagOffset = articleOffset + ARTICLE_DETAIL_V4_RECORD_SIZE
  const rightsOffset = tagOffset + tags.length * ARTICLE_DETAIL_TAG_V3_RECORD_SIZE
  const blobOffset = rightsOffset + ARTICLE_RIGHTS_V3_RECORD_SIZE
  const payload = new Uint8Array(blobOffset + blobLength)
  const view = new DataView(payload.buffer)
  view.setUint32(0, ARTICLE_DETAIL_V4_MAGIC, true)
  view.setInt32(4, ARTICLE_DETAIL_V4_VERSION, true)
  view.setUint32(8, 0, true)
  view.setInt32(12, articleOffset, true)
  view.setInt32(16, ARTICLE_DETAIL_V4_RECORD_SIZE, true)
  view.setInt32(20, tagOffset, true)
  view.setInt32(24, tags.length, true)
  view.setInt32(28, rightsOffset, true)
  view.setInt32(32, ARTICLE_RIGHTS_V3_RECORD_SIZE, true)
  view.setInt32(36, blobOffset, true)
  view.setInt32(40, blobLength, true)

  view.setInt32(articleOffset, opts.id, true)
  view.setInt32(articleOffset + 4, opts.views, true)
  view.setBigInt64(articleOffset + 8, opts.createTimeMs ?? 1_715_299_200_000n, true)
  view.setInt32(articleOffset + 16, opts.categoryId, true)
  view.setInt32(articleOffset + 20, opts.status ?? 2, true)
  view.setBigInt64(articleOffset + 24, opts.scheduledPublishAtMs ?? 0n, true)
  view.setBigInt64(articleOffset + 32, opts.publishedAtMs ?? 0n, true)
  view.setBigInt64(articleOffset + 40, opts.updatedAtMs ?? 0n, true)
  payload[articleOffset + 48] = opts.isDeleted ? 1 : 0
  writeSlice(view, articleOffset + 52, articleSlices.title)
  writeSlice(view, articleOffset + 60, articleSlices.content)
  writeSlice(view, articleOffset + 68, articleSlices.summary)
  writeSlice(view, articleOffset + 76, articleSlices.coverImageUrl)
  writeSlice(view, articleOffset + 84, articleSlices.categoryName)

  tags.forEach((tag, index) => {
    const offset = tagOffset + index * ARTICLE_DETAIL_TAG_V3_RECORD_SIZE
    view.setInt32(offset, tag.id, true)
    writeSlice(view, offset + 4, tagSlices[index]!)
  })

  let rightsFlags = 0
  if (rights.enabled) rightsFlags |= ArticleDetailRightsFlags.Enabled
  if (rights.allowCodeCopy) rightsFlags |= ArticleDetailRightsFlags.AllowCodeCopy
  if (rights.showPublicBadge) rightsFlags |= ArticleDetailRightsFlags.ShowPublicBadge
  if (rights.proofBindingEnabled) rightsFlags |= ArticleDetailRightsFlags.ProofBindingEnabled
  if (rights.copyrightYear != null) rightsFlags |= ArticleDetailRightsFlags.HasCopyrightYear
  if (rights.copyrightHolder) rightsFlags |= ArticleDetailRightsFlags.HasCopyrightHolder
  if (rights.rightsStatement) rightsFlags |= ArticleDetailRightsFlags.HasRightsStatement
  if (rights.attributionTemplate) rightsFlags |= ArticleDetailRightsFlags.HasAttributionTemplate
  if (rights.canonicalUrl) rightsFlags |= ArticleDetailRightsFlags.HasCanonicalUrl
  if (rights.proofUrl) rightsFlags |= ArticleDetailRightsFlags.HasProofUrl
  if (rights.proofStatus) rightsFlags |= ArticleDetailRightsFlags.HasProofStatus

  view.setBigInt64(rightsOffset, rights.snapshotId, true)
  view.setBigInt64(rightsOffset + 8, rights.articleRevisionId, true)
  view.setInt32(rightsOffset + 16, rights.revisionNo, true)
  view.setInt32(rightsOffset + 20, rightsFlags, true)
  view.setInt32(rightsOffset + 24, rights.copyrightYear ?? 0, true)
  view.setInt32(rightsOffset + 28, rights.maxExcerptChars, true)
  writeSlice(view, rightsOffset + 32, rightsSlices.licenseType)
  writeSlice(view, rightsOffset + 40, rightsSlices.copyrightHolder)
  writeSlice(view, rightsOffset + 48, rightsSlices.rightsStatement)
  writeSlice(view, rightsOffset + 56, rightsSlices.attributionTemplate)
  writeSlice(view, rightsOffset + 64, rightsSlices.copyPolicy)
  writeSlice(view, rightsOffset + 72, rightsSlices.canonicalUrl)
  writeSlice(view, rightsOffset + 80, rightsSlices.policyHash)
  writeSlice(view, rightsOffset + 88, rightsSlices.contentCanonicalHash)
  writeSlice(view, rightsOffset + 96, rightsSlices.proofUrl)
  writeSlice(view, rightsOffset + 104, rightsSlices.proofStatus)

  let blobCursor = blobOffset
  for (const chunk of blobChunks) {
    payload.set(chunk, blobCursor)
    blobCursor += chunk.byteLength
  }

  return payload
}

type ArticleDetailV4FixtureOptions = Parameters<typeof buildArticleDetailV4Payload>[0]

function buildArticleDetailV5Payload(
  opts: ArticleDetailV4FixtureOptions & {
    currentRevisionId: bigint
    revisionNo: number
    currentPublicationId: bigint
    publicationNo: number
  }
): Uint8Array {
  const v4 = buildArticleDetailV4Payload(opts)
  const articleOffset = ARTICLE_DETAIL_HEADER_SIZE
  const coordinateOffset = articleOffset + 48
  const v5 = new Uint8Array(v4.byteLength + 24)
  v5.set(v4.subarray(0, coordinateOffset), 0)
  v5.set(v4.subarray(coordinateOffset), coordinateOffset + 24)

  const view = new DataView(v5.buffer)
  view.setUint32(0, ARTICLE_DETAIL_V5_MAGIC, true)
  view.setInt32(4, ARTICLE_DETAIL_V5_VERSION, true)
  view.setInt32(16, ARTICLE_DETAIL_V5_RECORD_SIZE, true)
  view.setInt32(20, view.getInt32(20, true) + 24, true)
  view.setInt32(28, view.getInt32(28, true) + 24, true)
  view.setInt32(36, view.getInt32(36, true) + 24, true)
  view.setBigInt64(coordinateOffset, opts.currentRevisionId, true)
  view.setInt32(coordinateOffset + 8, opts.revisionNo, true)
  view.setBigInt64(coordinateOffset + 12, opts.currentPublicationId, true)
  view.setInt32(coordinateOffset + 20, opts.publicationNo, true)
  return v5
}

/** Builds the checked legacy ARD3 record by removing V4's UpdatedAt int64. */
function buildArticleDetailV3Payload(opts: ArticleDetailV4FixtureOptions): Uint8Array {
  const v4 = buildArticleDetailV4Payload(opts)
  const articleOffset = ARTICLE_DETAIL_HEADER_SIZE
  const updatedAtOffset = articleOffset + 40
  const afterUpdatedAtOffset = updatedAtOffset + 8
  const v3 = new Uint8Array(v4.byteLength - 8)
  v3.set(v4.subarray(0, updatedAtOffset), 0)
  v3.set(v4.subarray(afterUpdatedAtOffset), updatedAtOffset)

  const view = new DataView(v3.buffer)
  view.setUint32(0, ARTICLE_DETAIL_V3_MAGIC, true)
  view.setInt32(4, ARTICLE_DETAIL_V3_VERSION, true)
  view.setInt32(16, ARTICLE_DETAIL_V3_RECORD_SIZE, true)
  view.setInt32(20, view.getInt32(20, true) - 8, true)
  view.setInt32(28, view.getInt32(28, true) - 8, true)
  view.setInt32(36, view.getInt32(36, true) - 8, true)
  return v3
}

function writeSlice(view: DataView, offset: number, slice: { offset: number; length: number }): void {
  view.setInt32(offset, slice.offset, true)
  view.setInt32(offset + 4, slice.length, true)
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
  it('rejects retired ArticleDetail payloads without the V3 envelope', () => {
    const payload = buildLegacyArticleDetailPayload({
      id: 1,
      views: 0,
      reserved0: 999,
      categoryId: 7,
      categoryName: 'Frontend',
      title: 'T',
      summary: '',
      content: 'c'
    })

    expect(() => mapArticleDetailFromPodPayload(payload)).toThrow()
  })

  it('reads V4 category fields, updatedAt, and required rights from the V4 envelope', () => {
    const updatedAtMs = 1_715_385_600_000n
    const payload = buildArticleDetailV4Payload({
      id: 1,
      views: 0,
      categoryId: 7,
      categoryName: 'Frontend',
      title: 'T',
      summary: '',
      content: 'c',
      updatedAtMs
    })

    const result = mapArticleDetailFromPodPayload(payload)

    expect(result.category.id).toBe(7)
    expect(result.category.name).toBe('Frontend')
    expect(result.rights.snapshotId).toBe('901')
    expect(result.rights.articleRevisionId).toBe('801')
    expect(result.rights.revisionNo).toBe(7)
    expect(result.updatedAt).toBe(new Date(Number(updatedAtMs)).toISOString())
  })

  it('reads exact revision and publication coordinates from the V5 envelope', () => {
    const payload = buildArticleDetailV5Payload({
      id: 42,
      views: 7,
      categoryId: 3,
      categoryName: 'Protocol',
      title: 'Published revision',
      summary: 'Immutable coordinates',
      content: 'v5',
      currentRevisionId: 801n,
      revisionNo: 7,
      currentPublicationId: 1201n,
      publicationNo: 4
    })

    expect(mapArticleDetailFromPodPayload(payload)).toMatchObject({
      id: 42,
      currentRevisionId: '801',
      revisionNo: 7,
      currentPublicationId: '1201',
      publicationNo: 4
    })
  })

  it('keeps the 84-byte ARD3 fixture readable with updatedAt absent', () => {
    const payload = buildArticleDetailV3Payload({
      id: 3,
      views: 12,
      categoryId: 7,
      categoryName: 'Legacy',
      title: 'Legacy V3',
      summary: 'v3',
      content: 'compatible'
    })

    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    expect(view.getUint32(0, true)).toBe(ARTICLE_DETAIL_V3_MAGIC)
    expect(view.getInt32(4, true)).toBe(ARTICLE_DETAIL_V3_VERSION)
    expect(view.getInt32(16, true)).toBe(ARTICLE_DETAIL_V3_RECORD_SIZE)
    expect(mapArticleDetailFromPodPayload(payload)).toMatchObject({
      id: 3,
      title: 'Legacy V3',
      updatedAt: null
    })
  })

  it('decodes all scalar fields correctly', () => {
    const createTimeMs = 1_715_299_200_000n // 2024-05-10T00:00:00.000Z
    const payload = buildArticleDetailV4Payload({
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
    expect(result.rights.licenseType).toBe('CC-BY-4.0')
    expect(result.rights.copyPolicy).toBe('append-attribution')
    expect(result.rights.policyHash).toBe('sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
    expect(result.rights.contentCanonicalHash).toBe('sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
  })

  it('maps ArticleDetail V4 rights fields completely', () => {
    const payload = buildArticleDetailV4Payload({
      id: 10,
      views: 0,
      categoryId: 2,
      categoryName: 'Rights',
      title: 'Rights article',
      summary: 'summary',
      content: 'body',
      rights: {
        enabled: false,
        copyrightHolder: null,
        copyrightYear: null,
        rightsStatement: null,
        attributionTemplate: null,
        allowCodeCopy: false,
        showPublicBadge: true,
        proofBindingEnabled: false,
        canonicalUrl: null,
        proofUrl: null,
        proofStatus: null
      }
    })

    const result = mapArticleDetailFromPodPayload(payload)

    expect(result.rights).toEqual({
      snapshotId: '901',
      articleRevisionId: '801',
      revisionNo: 7,
      enabled: false,
      licenseType: 'CC-BY-4.0',
      copyrightHolder: null,
      copyrightYear: null,
      rightsStatement: null,
      attributionTemplate: null,
      copyPolicy: 'append-attribution',
      maxExcerptChars: 300,
      allowCodeCopy: false,
      showPublicBadge: true,
      proofBindingEnabled: false,
      canonicalUrl: null,
      policyHash: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      contentCanonicalHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      proofUrl: null,
      proofStatus: null
    })
  })

  it('accepts structurally valid rights records before proof metadata is generated', () => {
    const payload = buildArticleDetailV4Payload({
      id: 910002,
      views: 18,
      categoryId: 1,
      categoryName: 'Operations Notes',
      title: 'AEDS And Public AOT Notes',
      summary: 'A fictional operations note for testing public reading paths.',
      content: 'Body',
      rights: {
        snapshotId: 0n,
        articleRevisionId: 0n,
        revisionNo: 0,
        licenseType: 'all-rights-reserved',
        copyPolicy: 'append-attribution',
        policyHash: '',
        contentCanonicalHash: '',
        proofUrl: null,
        proofStatus: null
      }
    })

    const result = mapArticleDetailFromPodPayload(payload)

    expect(result.rights.snapshotId).toBe('0')
    expect(result.rights.articleRevisionId).toBe('0')
    expect(result.rights.revisionNo).toBe(0)
    expect(result.rights.licenseType).toBe('all-rights-reserved')
    expect(result.rights.copyPolicy).toBe('append-attribution')
    expect(result.rights.policyHash).toBe('')
    expect(result.rights.contentCanonicalHash).toBe('')
  })

  it('decodes cover image url from the trailing cover blob', () => {
    const payload = buildArticleDetailV4Payload({
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
    const payload = buildArticleDetailV4Payload({
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
    const payload = buildArticleDetailV4Payload({
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
    const payload = buildArticleDetailV4Payload({
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

  it('rejects mismatched version, truncation, and trailing bytes', () => {
    const payload = buildArticleDetailV4Payload({
      id: 1,
      views: 0,
      categoryId: 1,
      categoryName: 'Dev',
      title: 'T',
      summary: '',
      content: 'c'
    })
    const invalidVersion = payload.slice()
    new DataView(invalidVersion.buffer).setInt32(4, ARTICLE_DETAIL_V3_VERSION, true)
    const trailing = new Uint8Array(payload.byteLength + 1)
    trailing.set(payload)

    expect(() => mapArticleDetailFromPodPayload(invalidVersion)).toThrow()
    expect(() => mapArticleDetailFromPodPayload(payload.subarray(0, payload.byteLength - 1))).toThrow()
    expect(() => mapArticleDetailFromPodPayload(trailing)).toThrow()
  })

  it('throws when the V4 envelope is missing the rights record', () => {
    const payload = buildArticleDetailV4Payload({
      id: 1,
      views: 0,
      categoryId: 1,
      categoryName: 'Dev',
      title: 'T',
      summary: '',
      content: 'c'
    })
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    view.setInt32(32, 0, true)

    expect(() => mapArticleDetailFromPodPayload(payload)).toThrow()
  })

  it('throws when a V4 slice points outside the shared blob', () => {
    const payload = buildArticleDetailV4Payload({
      id: 1,
      views: 0,
      categoryId: 1,
      categoryName: 'Dev',
      title: 'T',
      summary: '',
      content: 'c'
    })
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength)
    view.setInt32(ARTICLE_DETAIL_HEADER_SIZE + 52, 999_999, true)

    expect(() => mapArticleDetailFromPodPayload(payload)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// ArticlePage adapter — smoke test for compact v2 category fields in list items.
// ---------------------------------------------------------------------------

describe('mapArticlePageFromPodPayload', () => {
  /**
   * Current ArticleList record (100B):
   * id, views, createTimeMs, categoryId, categoryName slice, title slice,
   * summary slice, tagStart, tagCount, isDeleted, hasIsDeleted, reserved.
   */
  function buildArticleListPayload(items: Array<{
    id: number
    categoryId: number
    categoryName: string
    title: string
  }>, nextCursor: string | null = null): Uint8Array {
    const ITEM_RECORD_SIZE = ARTICLE_LIST_WIRE.recordBytes
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
      edv.setInt32(recordOffset + 56, 2, true)
      edv.setBigInt64(recordOffset + 76, 99n, true)
      edv.setInt32(recordOffset + 84, 3, true)
      edv.setBigInt64(recordOffset + 88, 88n, true)
      edv.setInt32(recordOffset + 96, 2, true)
    })
    pos += items.length * ITEM_RECORD_SIZE
    if (pos !== envelope.byteLength) {
      throw new Error('fixture_size_mismatch')
    }
    const cursorBytes = enc.encode(nextCursor ?? '')
    const payload = new Uint8Array(17 + cursorBytes.byteLength + envelope.byteLength - 4)
    const view = new DataView(payload.buffer)
    view.setInt32(0, 0x41535046, true)
    view.setInt32(4, 2, true)
    payload[8] = nextCursor ? 1 : 0
    view.setInt32(9, items.length, true)
    view.setInt32(13, cursorBytes.byteLength, true)
    payload.set(cursorBytes, 17)
    payload.set(envelope.subarray(4), 17 + cursorBytes.byteLength)
    return payload
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

  it('rejects the retired article list cursor envelope v1', () => {
    const payload = new Uint8Array(8)
    const view = new DataView(payload.buffer)
    view.setInt32(0, 0x41535046, true)
    view.setInt32(4, 1, true)

    expect(() => mapArticlePageFromPodPayload(payload)).toThrow('article_page_cursor_version_invalid')
  })

  it('rejects article list payloads without the cursor envelope', () => {
    const payload = new Uint8Array(12)

    expect(() => mapArticlePageFromPodPayload(payload)).toThrow('article_page_cursor_envelope_missing')
  })

  it('preserves opaque cursor metadata from article list envelope v2', () => {
    const cursor = 'AQIDBA_cursor-filter-checksum'
    const payload = buildArticleListPayload([
      { id: 1, categoryId: 9, categoryName: 'Backend', title: 'Post A' }
    ], cursor)

    const result = mapArticlePageFromPodPayload(payload)

    expect(result.nextCursor).toBe(cursor)
    expect(result.hasMore).toBe(true)
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

  it('rejects complete retired compact search result v3 payload', () => {
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
    expect(() => mapArticleSearchFromPodPayload(payload)).toThrow('search_result_version_invalid')
  })

  it('decodes exact publication coordinates from compact search result v4', () => {
    const blob: number[] = []
    const category = pushText(blob, '技术')
    const title = pushText(blob, 'Search v4')
    const summary = pushText(blob, '版本坐标')
    const records: number[] = []
    appendU32(records, 42)
    appendU32(records, 7)
    appendI64(records, 1_715_299_200_000n)
    appendU32(records, 3)
    appendRef(records, category)
    appendRef(records, title)
    appendRef(records, summary)
    appendU32(records, 0)
    appendU32(records, 0)
    appendI64(records, 801n)
    appendU32(records, 7)
    appendI64(records, 1201n)
    appendU32(records, 4)

    const header: number[] = []
    const tagOffset = 24 + records.length
    appendU32(header, 0x34525346)
    appendU32(header, 4)
    appendU32(header, 1)
    appendU32(header, 1)
    appendU32(header, tagOffset)
    appendU32(header, tagOffset)

    const payload = new Uint8Array([...header, ...records, ...blob])
    const result = mapArticleSearchFromPodPayload(payload)
    for (const offset of [52, 60, 72]) {
      const invalid = payload.slice()
      new DataView(invalid.buffer).setInt32(24 + offset, 0, true)
      expect(() => mapArticleSearchFromPodPayload(invalid)).toThrow('article_version_coordinates_invalid')
    }
    const oldSize = payload.slice()
    new DataView(oldSize.buffer).setInt32(16, 24 + 52, true)
    expect(() => mapArticleSearchFromPodPayload(oldSize)).toThrow()
    expect(() => mapArticleSearchFromPodPayload(payload.subarray(8))).toThrow('search_result_version_invalid')
    expect(() => mapArticleSearchFromPodPayload(new Uint8Array([...payload, 0]))).toThrow('search_result_trailing_bytes_invalid')

    expect(result.items[0]).toMatchObject({
      id: 42,
      currentRevisionId: '801',
      revisionNo: 7,
      currentPublicationId: '1201',
      publicationNo: 4
    })
  })
})
