import { describe, it, expect } from 'vitest'
import { mapRecentCommentsFromPodPayload, mapRegionsFromPodPayload, mapSiteStatsFromPodPayload } from '@/adapters/binary/statsAdapter'
import { SITE_STATS_POD_SIZE } from '@/adapters/binary/types'

const POPULAR_ARTICLE_RECORD_SIZE = 16
const RECENT_COMMENT_RECORD_SIZE = 56
const REGION_DISTRIBUTION_RECORD_SIZE = 12

function writeInt32(b: Uint8Array, off: number, v: number): void {
  b[off] = v & 0xff; b[off + 1] = (v >>> 8) & 0xff
  b[off + 2] = (v >>> 16) & 0xff; b[off + 3] = (v >>> 24) & 0xff
}
function enc(t: string): Uint8Array { return new TextEncoder().encode(t) }
function sliceRef(view: DataView, off: number, offset: number, length: number): void {
  view.setInt32(off, offset, true)
  view.setInt32(off + 4, length, true)
}
function buildCompactPayload(prefix: Uint8Array, blob: Uint8Array, suffix: Uint8Array): Uint8Array {
  const bytes = new Uint8Array(prefix.byteLength + 4 + blob.byteLength + suffix.byteLength)
  const view = new DataView(bytes.buffer)
  bytes.set(prefix, 0)
  view.setInt32(prefix.byteLength, blob.byteLength, true)
  bytes.set(blob, prefix.byteLength + 4)
  bytes.set(suffix, prefix.byteLength + 4 + blob.byteLength)
  return bytes
}

describe('mapSiteStatsFromPodPayload', () => {
  it('reads summary fields correctly', () => {
    const pod = new Uint8Array(SITE_STATS_POD_SIZE)
    writeInt32(pod, 0, 10)   // totalArticles
    writeInt32(pod, 4, 20)   // totalComments
    writeInt32(pod, 8, 3)    // trashCount
    writeInt32(pod, 12, 1000) // totalReads
    writeInt32(pod, 16, 980)  // humanVerifiedReads
    writeInt32(pod, 20, 240)  // uniqueViewerKeyEstimate
    writeInt32(pod, 24, 760)  // articleReads
    writeInt32(pod, 28, 240)  // siteReads
    const suffix = new Uint8Array(12)

    const result = mapSiteStatsFromPodPayload(buildCompactPayload(pod, new Uint8Array(), suffix))
    expect(result.overview.summary.totalArticles).toBe(10)
    expect(result.overview.summary.totalComments).toBe(20)
    expect(result.overview.summary.trashCount).toBe(3)
    expect(result.overview.summary.totalReads).toBe(1000)
    expect(result.overview.summary.humanVerifiedReads).toBe(980)
    expect(result.overview.summary.uniqueViewerKeyEstimate).toBe(240)
    expect(result.overview.summary.articleReads).toBe(760)
    expect(result.overview.summary.siteReads).toBe(240)
    expect(result.overview.popularArticles).toEqual([])
    expect(result.recentComments).toEqual([])
    expect(result.regions).toEqual([])
  })

  it('reads popular articles', () => {
    const title = enc('Best Post')
    const pod = new Uint8Array(SITE_STATS_POD_SIZE)
    const suffix = new Uint8Array(4 + POPULAR_ARTICLE_RECORD_SIZE + 4 + 4)
    const view = new DataView(suffix.buffer)
    view.setInt32(0, 1, true)
    view.setInt32(4, 42, true)
    view.setInt32(8, 999, true)
    sliceRef(view, 12, 0, title.byteLength)

    const result = mapSiteStatsFromPodPayload(buildCompactPayload(pod, title, suffix))
    expect(result.overview.popularArticles).toHaveLength(1)
    expect(result.overview.popularArticles[0].id).toBe(42)
    expect(result.overview.popularArticles[0].views).toBe(999)
    expect(result.overview.popularArticles[0].title).toBe('Best Post')
  })

  it('reads embedded recent comments and regions from the aggregate stats frame', () => {
    const authorDisplayName = enc('强匿名评论者')
    const authorMode = enc('zk_anonymous')
    const authorBadge = enc('已验证匿名凭证')
    const authorScopeLabel = enc('article:42')
    const credentialLevel = enc('strong_anonymous')
    const content = enc('Hello')
    const region = enc('EU')
    const blob = joinBytes(authorDisplayName, authorMode, authorBadge, authorScopeLabel, credentialLevel, content, region)
    const offsets = offsetsFor(authorDisplayName, authorMode, authorBadge, authorScopeLabel, credentialLevel, content, region)

    const pod = new Uint8Array(SITE_STATS_POD_SIZE)
    const suffix = new Uint8Array(4 + 4 + RECENT_COMMENT_RECORD_SIZE + 4 + REGION_DISTRIBUTION_RECORD_SIZE)
    const view = new DataView(suffix.buffer)
    view.setInt32(0, 0, true)
    view.setInt32(4, 1, true)
    view.setBigInt64(8, BigInt(Date.UTC(2026, 0, 2)), true)
    sliceRef(view, 16, offsets[0], authorDisplayName.byteLength)
    sliceRef(view, 24, offsets[1], authorMode.byteLength)
    sliceRef(view, 32, offsets[2], authorBadge.byteLength)
    sliceRef(view, 40, offsets[3], authorScopeLabel.byteLength)
    sliceRef(view, 48, offsets[4], credentialLevel.byteLength)
    sliceRef(view, 56, offsets[5], content.byteLength)
    view.setInt32(64, 1, true)
    view.setInt32(68, 11, true)
    sliceRef(view, 72, offsets[6], region.byteLength)

    const result = mapSiteStatsFromPodPayload(buildCompactPayload(pod, blob, suffix))
    expect(result.recentComments).toEqual([{
      authorDisplayName: '强匿名评论者',
      authorMode: 'zk_anonymous',
      authorBadge: '已验证匿名凭证',
      authorScopeLabel: 'article:42',
      credentialLevel: 'strong_anonymous',
      content: 'Hello',
      createTime: new Date(Date.UTC(2026, 0, 2)).toISOString()
    }])
    expect(result.regions).toEqual([{ region: 'EU', count: 11 }])
  })

  it('throws when popularCount is negative', () => {
    const pod = new Uint8Array(SITE_STATS_POD_SIZE)
    const suffix = new Uint8Array(4)
    new DataView(suffix.buffer).setInt32(0, -1, true)
    expect(() => mapSiteStatsFromPodPayload(buildCompactPayload(pod, new Uint8Array(), suffix))).toThrow()
  })

  it('throws when recentCount is negative', () => {
    const pod = new Uint8Array(SITE_STATS_POD_SIZE)
    const suffix = new Uint8Array(8)
    const view = new DataView(suffix.buffer)
    view.setInt32(0, 0, true)
    view.setInt32(4, -1, true)
    expect(() => mapSiteStatsFromPodPayload(buildCompactPayload(pod, new Uint8Array(), suffix))).toThrow()
  })

  it('throws when payload has trailing bytes after regions', () => {
    const pod = new Uint8Array(SITE_STATS_POD_SIZE)
    const suffix = new Uint8Array(13)
    suffix[12] = 1
    expect(() => mapSiteStatsFromPodPayload(buildCompactPayload(pod, new Uint8Array(), suffix))).toThrow()
  })
})

describe('stats list mappers', () => {
  it('reads recent comments', () => {
    const authorDisplayName = enc('Alice Public')
    const authorMode = enc('public')
    const authorBadge = enc('')
    const authorScopeLabel = enc('')
    const credentialLevel = enc('')
    const content = 'Hello comment'
    const contentBytes = enc(content)
    const blob = joinBytes(authorDisplayName, authorMode, authorBadge, authorScopeLabel, credentialLevel, contentBytes)
    const offsets = offsetsFor(authorDisplayName, authorMode, authorBadge, authorScopeLabel, credentialLevel, contentBytes)

    const prefix = new Uint8Array(4)
    writeInt32(prefix, 0, 1)
    const records = new Uint8Array(RECENT_COMMENT_RECORD_SIZE)
    const view = new DataView(records.buffer)
    view.setBigInt64(0, BigInt(Date.UTC(2026, 0, 1)), true)
    sliceRef(view, 8, offsets[0], authorDisplayName.byteLength)
    sliceRef(view, 16, offsets[1], authorMode.byteLength)
    sliceRef(view, 24, offsets[2], authorBadge.byteLength)
    sliceRef(view, 32, offsets[3], authorScopeLabel.byteLength)
    sliceRef(view, 40, offsets[4], credentialLevel.byteLength)
    sliceRef(view, 48, offsets[5], contentBytes.byteLength)

    expect(mapRecentCommentsFromPodPayload(buildCompactPayload(prefix, blob, records))).toEqual([{
      authorDisplayName: 'Alice Public',
      authorMode: 'public',
      authorBadge: null,
      authorScopeLabel: null,
      credentialLevel: null,
      content,
      createTime: new Date(Date.UTC(2026, 0, 1)).toISOString()
    }])
  })

  it('reads regions', () => {
    const region = enc('US')
    const prefix = new Uint8Array(4)
    writeInt32(prefix, 0, 1)
    const records = new Uint8Array(REGION_DISTRIBUTION_RECORD_SIZE)
    const view = new DataView(records.buffer)
    view.setInt32(0, 9, true)
    sliceRef(view, 4, 0, region.byteLength)

    expect(mapRegionsFromPodPayload(buildCompactPayload(prefix, region, records))).toEqual([{ region: 'US', count: 9 }])
  })
})

function joinBytes(...parts: Uint8Array[]): Uint8Array {
  const bytes = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    bytes.set(part, offset)
    offset += part.byteLength
  }
  return bytes
}

function offsetsFor(...parts: Uint8Array[]): number[] {
  const offsets: number[] = []
  let offset = 0
  for (const part of parts) {
    offsets.push(offset)
    offset += part.byteLength
  }
  return offsets
}
