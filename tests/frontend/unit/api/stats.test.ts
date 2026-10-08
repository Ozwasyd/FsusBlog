import { buildFsusBinaryRoute } from '@/generated/fsusBinaryRoutes'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FrameType } from '@wasm/protocol/frame'

vi.mock('@/composition/binaryTransport', () => ({
  requestBinaryOnly: vi.fn()
}))

import { requestBinaryOnly } from '@/composition/binaryTransport'
import { getAdminStatsQuery, getRecentCommentStats, getRegionStats, getSiteStatsOverview } from '@/api/stats'

const mockBinary = vi.mocked(requestBinaryOnly)

describe('stats API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockBinary.mockResolvedValue({ overview: {}, recentComments: [], regions: [] } as never)
  })

  it('getAdminStatsQuery uses single binary stats frame', async () => {
    await getAdminStatsQuery()
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_get_stats' },
      frameType: FrameType.AdminStats
    }))
  })

  it('getSiteStatsOverview maps overview from binary stats query', async () => {
    const overview = { summary: {}, popularArticles: [] }
    mockBinary.mockResolvedValueOnce({ overview, recentComments: [], regions: [] } as never)

    await expect(getSiteStatsOverview()).resolves.toBe(overview)
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_get_stats' },
      frameType: FrameType.AdminStats
    }))
  })

  it('getRecentCommentStats uses binary recent comments frame', async () => {
    await getRecentCommentStats()
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_get_stats_recent_comments' },
      frameType: FrameType.RecentCommentStats
    }))
  })

  it('getRegionStats uses binary region frame', async () => {
    await getRegionStats()
    expect(mockBinary).toHaveBeenCalledWith(expect.objectContaining({
      binaryRoute: { operationId: 'binary_get_stats_regions' },
      frameType: FrameType.RegionStats
    }))
  })

})

function routeUrl(call: Partial<import('@/contracts/binaryTransport').BinaryTransportRequest> | undefined): string | undefined {
  const route = call?.binaryRoute
  return route ? buildFsusBinaryRoute(route.operationId, route.params, route.query) : undefined
}
