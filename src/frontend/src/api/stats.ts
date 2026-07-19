import type { ApiRequestConfig } from './requestConfig';
import { FrameType } from '@wasm/protocol/frame';
import { requestBinaryOnly } from '@/composition/binaryTransport';
import type {
  AdminStatsOverview,
  AdminStatsQuery,
  RecentCommentStatItem,
  RegionStatItem,
  StatsSummary,
  TrashClearResponse
} from '@/contracts/binaryApi';

export type { AdminStatsOverview, AdminStatsQuery, RecentCommentStatItem, RegionStatItem, StatsSummary, TrashClearResponse } from '@/contracts/binaryApi'

export const getAdminStatsQuery = (config?: ApiRequestConfig) =>
  requestBinaryOnly<AdminStatsQuery>({
    binaryUrl: '/api/binary/stats',
    frameType: FrameType.AdminStats,
    signal: config?.signal as AbortSignal | undefined
  })

export const getSiteStatsOverview = async (config?: ApiRequestConfig) =>
  (await getAdminStatsQuery(config)).overview

export const getRecentCommentStats = (config?: ApiRequestConfig) =>
  requestBinaryOnly<RecentCommentStatItem[]>({
    binaryUrl: '/api/binary/stats/recent-comments',
    frameType: FrameType.RecentCommentStats,
    signal: config?.signal as AbortSignal | undefined
  })

export const getRegionStats = (config?: ApiRequestConfig) =>
  requestBinaryOnly<RegionStatItem[]>({
    binaryUrl: '/api/binary/stats/regions',
    frameType: FrameType.RegionStats,
    signal: config?.signal as AbortSignal | undefined
  })
