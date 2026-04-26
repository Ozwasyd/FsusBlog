import type { AxiosRequestConfig } from 'axios'
import api from './index'

export interface SeoConfigPublic {
  title: string       // 网站标题 (例如: "Fsu's Blog")
  description: string // 网站描述 (Meta Description)
  keywords: string    // 关键词
  author: string      // 作者名
  ogImage: string     // 社交分享封面图 URL
  baseUrl : string    // URL
}

export interface SeoConfigAdmin {
  title: string
  description: string
  keywords: string
  author: string
  ogImage: string
  baseUrl: string
}

export interface PageContentPublic {
  slug: string        // 页面唯一标识 (例如: 'about' 或 'privacy')
  content: string     // Markdown 格式的内容文本
}

export interface PageContentAdmin {
  slug: string
  content: string
}

/**
 * [修复 2026-02-23] 逻辑自洽：所有 API 方法增加可选的 config 参数
 * 物理真相：为了支持 AbortController 抢占机制，必须允许外部传入 signal
 */

// 站点 SEO 配置
export const getSiteConfig = (config?: AxiosRequestConfig) =>
  api.get<SeoConfigPublic>('/System/seo', config)

export const getAdminSiteConfig = (config?: AxiosRequestConfig) =>
  api.get<SeoConfigAdmin>('/System/admin/seo', config)

/**
 * 更新站点配置
 * 安全性保障：接入 PoW 算力校验，物理隔离针对全站元数据的恶意篡改尝试
 */
export const updateSiteConfig = (data: SeoConfigAdmin, config?: AxiosRequestConfig) =>
  api.put('/System/seo', data, {
    ...config,
    requiresPow: true
  } as AxiosRequestConfig)

// ================= 动态页面管理 =================

// 动态页面内容
export const getPageData = (slug: string, config?: AxiosRequestConfig) =>
  api.get<PageContentPublic>(`/System/page/${slug}`, config)

export const getAdminPageData = (slug: string, config?: AxiosRequestConfig) =>
  api.get<PageContentAdmin>(`/System/admin/page/${slug}`, config)

/**
 * 更新动态页面
 * 安全性保障：防止自动化脚本利用管理权限进行大规模的 SEO 垃圾信息注入
 */
export const updatePageData = (data: PageContentAdmin, config?: AxiosRequestConfig) =>
  api.put('/System/page', data, {
    ...config,
    requiresPow: true
  } as AxiosRequestConfig)

/**
 * 手动重置页面缓存 (可选)
 * 用于在不修改内容的情况下强制更新 Redis 状态
 * 算法最优：此操作触发后端缓存重载，属于资源消耗型操作，建议接入 PoW 保护
 */
export const resetPageCache = (slug: string, config?: AxiosRequestConfig) => {
  return api.post(`/System/page/refresh/${slug}`, {}, {
    ...config,
    requiresPow: true
  } as AxiosRequestConfig)
}

// ================= 文件操作 (对应 FileController) =================

/**
 * 性能最大化：FormData 传输大数据时，确保 config 能透传以支持上游监听进度
 * 安全性保障：上传接口极易遭受文件碎片或 CC 攻击，强制开启算力挑战以增加攻击成本
 */
export const uploadImage = (file: File, config?: AxiosRequestConfig) => {
  const fd = new FormData()
  fd.append('file', file)
  return api.post<{ url: string; relativeUrl: string }>('/File/upload', fd, {
    ...config,
    requiresPow: true
  } as AxiosRequestConfig)
}

/**
 * 删除文件
 * 安全性保障：物理删除操作接入 PoW 保护，杜绝自动化脚本批量抹除服务器资源
 */
export const deleteImage = (url: string, config?: AxiosRequestConfig) =>
  api.delete('/File/delete', {
    ...config,
    params: { url },
    requiresPow: true
  } as AxiosRequestConfig)
