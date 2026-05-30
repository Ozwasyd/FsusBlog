import { describe, it, expect } from 'vitest'
import { mapRecentCommentsFromPodPayload, mapRegionsFromPodPayload, mapSiteStatsFromPodPayload } from '@/adapters/binary/statsAdapter'
import { SITE_STATS_POD_SIZE } from '@/adapters/binary/types'

const POPULAR_ARTICLE_RECORD_SIZE = 16
const RECENT_COMMENT_RECORD_SIZE = 32
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
    writeInt32(pod, 12, 1000) // totalVisits
    writeInt32(pod, 16, 400)  // registeredVisits
    writeInt32(pod, 20, 600)  // anonymousVisits
    const suffix = new Uint8Array(12)

    const result = mapSiteStatsFromPodPayload(buildCompactPayload(pod, new Uint8Array(), suffix))
    expect(result.overview.summary.totalArticles).toBe(10)
    expect(result.overview.summary.totalComments).toBe(20)
    expect(result.overview.summary.trashCount).toBe(3)
    expect(result.overview.summary.totalVisits).toBe(1000)
    expect(result.overview.summary.registeredVisits).toBe(400)
    expect(result.overview.summary.anonymousVisits).toBe(600)
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
    const userName = enc('Alice')
    const content = enc('Hello')
    const region = enc('EU')
    const blob = new Uint8Array(userName.byteLength + content.byteLength + region.byteLength)
    blob.set(userName, 0)
    blob.set(content, userName.byteLength)
    blob.set(region, userName.byteLength + content.byteLength)

    const pod = new Uint8Array(SITE_STATS_POD_SIZE)
    const suffix = new Uint8Array(4 + 4 + RECENT_COMMENT_RECORD_SIZE + 4 + REGION_DISTRIBUTION_RECORD_SIZE)
    const view = new DataView(suffix.buffer)
    view.setInt32(0, 0, true)
    view.setInt32(4, 1, true)
    view.setInt32(8, 7, true)
    suffix[12] = 1
    view.setBigInt64(16, BigInt(Date.UTC(2026, 0, 2)), true)
    sliceRef(view, 24, 0, userName.byteLength)
    sliceRef(view, 32, userName.byteLength, content.byteLength)
    view.setInt32(40, 1, true)
    view.setInt32(44, 11, true)
    sliceRef(view, 48, userName.byteLength + content.byteLength, region.byteLength)

    const result = mapSiteStatsFromPodPayload(buildCompactPayload(pod, blob, suffix))
    expect(result.recentComments).toEqual([{
      userId: 7,
      userName: 'Alice',
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
    const userName = enc('Alice')
    const content = 'Hello comment'
    const contentBytes = enc(content)
    const blob = new Uint8Array(userName.byteLength + contentBytes.byteLength)
    blob.set(userName, 0)
    blob.set(contentBytes, userName.byteLength)

    const prefix = new Uint8Array(4)
    writeInt32(prefix, 0, 1)
    const records = new Uint8Array(RECENT_COMMENT_RECORD_SIZE)
    const view = new DataView(records.buffer)
    view.setInt32(0, 5, true)
    records[4] = 1
    view.setBigInt64(8, BigInt(Date.UTC(2026, 0, 1)), true)
    sliceRef(view, 16, 0, userName.byteLength)
    sliceRef(view, 24, userName.byteLength, contentBytes.byteLength)

    expect(mapRecentCommentsFromPodPayload(buildCompactPayload(prefix, blob, records))).toEqual([{
      userId: 5,
      userName: 'Alice',
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
