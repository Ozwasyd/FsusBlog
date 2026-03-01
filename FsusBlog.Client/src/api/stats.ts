import type { AxiosRequestConfig } from 'axios';
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

/**
 * [修复 2026-02-23] 逻辑自洽：所有方法增加可选的 config 参数以支持 AbortSignal 物理中断
 */

/** * 获取后台汇总统计数据 
 * GET /api/Stats
 * 算法最优：透传 config 确保管理员快速刷新仪表盘时，过期的聚合查询能被物理中断
 */
export const getSiteStats = (config?: AxiosRequestConfig) => 
  api.get<SiteStats>('/Stats', config)

/** * 一键清空回收站 
 * DELETE /api/Stats/clear-trash
 * 安全性保障：清空回收站属于不可逆的物理删除操作，强制接入 PoW 算力校验
 * 物理隔离针对敏感管理接口的自动化探测或误操作攻击。
 */
export const clearTrash = (config?: AxiosRequestConfig) => 
  api.delete<string>('/Stats/clear-trash', {
    ...config,
    requiresPow: true
  } as AxiosRequestConfig)