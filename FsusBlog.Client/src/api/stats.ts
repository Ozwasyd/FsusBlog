import api from './index'

/** 1. 热门文章 DTO */
export interface PopularArticleDto {
  id: number
  title: string
  views: number
}

/** 2. 最新评论 DTO */
export interface RecentCommentDto {
  userId: number | null
  userName: string
  content: string
  createTime: string // 后端 DateTime 序列化后为字符串
}

/** 3. 地域分布项 DTO */
export interface RegionDistributionDto {
  region: string // 格式: 国家-省份-城市
  count: number
}

/** 4. 后台管理概览统计数据 (主 DTO) */
export interface SiteStats {
  // 内容指标
  totalArticles: number
  totalComments: number
  trashCount: number

  // 访问指标
  totalVisits: number
  registeredVisits: number
  anonymousVisits: number

  // 深度数据
  popularArticles: PopularArticleDto[]
  recentComments: RecentCommentDto[]
  regionDistributions: RegionDistributionDto[]
}

/** * 获取后台汇总统计数据 
 * GET /api/Stats
 */
export const getSiteStats = () => api.get<SiteStats>('/Stats')

/** * 一键清空回收站 
 * DELETE /api/Stats/clear-trash
 */
export const clearTrash = () => api.delete<string>('/Stats/clear-trash')