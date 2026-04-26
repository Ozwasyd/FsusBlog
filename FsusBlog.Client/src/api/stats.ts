import type { AxiosRequestConfig } from 'axios';
import api from './index';
import { FrameType } from '@wasm/protocol/frame';
import { requestBinaryOnly } from '@/services/binaryTransport';

export interface PopularArticleStatItem {
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

export interface TrashClearResponse {
  count: number
}

export const getSiteStatsOverview = (config?: AxiosRequestConfig) =>
  requestBinaryOnly<AdminStatsOverview>({
    binaryUrl: '/api/binary/stats',
    frameType: FrameType.AdminStats,
    signal: config?.signal as AbortSignal | undefined
  })

export const getRecentCommentStats = (config?: AxiosRequestConfig) =>
  api.get<RecentCommentStatItem[]>('/Stats/recent-comments', config)

export const getRegionStats = (config?: AxiosRequestConfig) =>
  api.get<RegionStatItem[]>('/Stats/regions', config)

export const clearTrash = (config?: AxiosRequestConfig) =>
  api.delete<TrashClearResponse>('/Article/trash', {
    ...config,
    requiresPow: true
  } as AxiosRequestConfig)
