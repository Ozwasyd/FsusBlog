import api from './index'
import type { PowRequest } from './auth'

// ================= 基础类型 =================

/** 标签 DTO */
export interface Tag {
  id: number
  name: string
}

/** * 文章列表项 (对应后端 ArticleListDto)
 * 用于首页、归档、搜索结果等
 */
export interface ArticleListItem {
  id: number
  title: string
  summary: string 
  snippet?: string
  views: number
  createTime: string
  categoryName: string
  tags: Tag[]
}

/** * 文章详情
 */
export interface ArticleDetail {
  id: number
  title: string
  content: string
  summary: string
  categoryId: number
  views: number
  createTime: string
  category?: { id: number; name: string }
  tags: Tag[]
}

/** 分页包裹对象 */
export interface ArticleListRes {
  items: ArticleListItem[]
  total: number
}

/** 搜索请求参数 (合并业务关键字与 PoW 凭证) */
export interface SearchArticlesParams extends PowRequest {
  keyword: string
}

// ================= API 方法 =================

/** 获取文章列表 */
export const getArticles = (params: { page?: number; size?: number; categoryId?: number; tagId?: number }) => {
  return api.get<ArticleListRes>('/Article', { params })
}

/** 获取详情 */
export const getArticleById = (id: number) => {
  return api.get<ArticleDetail>(`/Article/${id}`)
}

/** 全站搜索接口 
 * 通过 URL 查询参数传递业务关键字与算力证明
 */
export const searchArticles = (params: SearchArticlesParams) => {
  return api.get<ArticleListItem[]>('/Article/search', { params })
}

/** 热门排行 */
export const getHotArticles = (size = 10) => {
  return api.get<ArticleListItem[]>('/Article/hot', { params: { size } })
}

// ================= 管理端 =================

export const createArticle = (data: any) => api.post<{ id: number }>('/Article', data)
export const updateArticle = (id: number, data: any) => api.put<{ id: number }>(`/Article/${id}`, data)
export const deleteArticle = (id: number) => api.delete(`/Article/${id}`)
export const restoreArticle = (id: number) => api.put(`/Article/restore/${id}`)
export const permanentDeleteArticle = (id: number) => api.delete(`/Article/permanent/${id}`)