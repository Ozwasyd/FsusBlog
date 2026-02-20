import api from './index'

/**
 * 对应后端的 SeoConfigDto
 * 这里我们稍微改个名叫 SiteConfig，因为它其实包含了整个站点的基础信息
 */
export interface SiteConfig {
  title: string       // 网站标题 (例如: "Fsu's Blog")
  description: string // 网站描述 (Meta Description)
  keywords: string    // 关键词
  author: string      // 作者名
  ogImage: string     // 社交分享封面图 URL
}

/**
 * 动态页面内容 (用于 关于、隐私政策 等)
 */
export interface PageData {
  slug: string        // 页面唯一标识 (例如: 'about' 或 'privacy')
  content: string     // Markdown 格式的内容文本
}
// 站点 SEO 配置
export const getSiteConfig = () => api.get<SiteConfig>('/System/seo')
export const updateSiteConfig = (data: SiteConfig) => api.put('/System/seo', data)

// ================= 动态页面管理 =================

// 动态页面内容
export const getPageData = (slug: string) => api.get<PageData>(`/System/page/${slug}`)
export const updatePageData = (data: PageData) => api.put('/System/page', data)

/** * 手动重置页面缓存 (可选)
 * 用于在不修改内容的情况下强制更新 Redis 状态
 */
export const resetPageCache = (slug: string) => {
  return api.post(`/System/page/refresh/${slug}`)
}

// 文件操作 (对应 FileController)
export const uploadImage = (file: File) => {
  const fd = new FormData()
  fd.append('file', file)
  return api.post<{ url: string; relativeUrl: string }>('/File/upload', fd)
}
export const deleteImage = (url: string) => api.delete('/File/delete', { params: { url } })