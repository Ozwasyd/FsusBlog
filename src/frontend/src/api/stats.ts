import type { ApiRequestConfig } from './requestConfig';
import { FrameType } from '@wasm/protocol/frame';
import { requestBinaryOnly } from '@/services/binaryTransport';

interface PopularArticleStatItem {
  id: number
  title: string
  views: number
}

export interface RecentCommentStatItem {
  userId: number | null
  userName: string
  content: string
  createTime: string
}

export interface RegionStatItem {
  region: string
  count: number
}

export interface StatsSummary {
  totalArticles: number
  totalComments: number
  trashCount: number
  totalVisits: number
  registeredVisits: number
  anonymousVisits: number
}

export interface AdminStatsOverview {
  summary: StatsSummary
  popularArticles: PopularArticleStatItem[]
}

export interface AdminStatsQuery {
  overview: AdminStatsOverview
  recentComments: RecentCommentStatItem[]
  regions: RegionStatItem[]
}

export interface TrashClearResponse {
  count: number
}

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
