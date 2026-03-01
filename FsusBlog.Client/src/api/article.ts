import type { AxiosRequestConfig } from 'axios';
import api from './index'

// ================= 基础类型 =================

/** 标签 DTO */
export interface Tag {
  id: number
  name: string
}

/** 
 * 文章列表项 (对应后端 ArticleListDto)
 * 修复日期: 2026-02-23 (对齐嵌套 category 结构)
 */
export interface ArticleListItem {
  id: number;
  title: string;
  summary: string; 
  snippet?: string;
  views: number;
  createTime: string; // 后端 UTC 字符串
  category: {
    id: number;
    name: string;
  };
  tags: Tag[];
}

/** 
 * 文章详情 (对应后端 ArticleDetailDto)
 * 修复日期: 2026-02-23 (补全 categoryId 字段)
 */
export interface ArticleDetail {
  id: number;
  title: string;
  content: string;
  summary: string;
  categoryId: number;
  views: number;
  createTime: string; // 后端 UTC 字符串
  category?: { 
    id: number; 
    name: string; 
  };
  tags: Tag[];
}

/** 分页包裹对象 */
export interface ArticleListRes {
  items: ArticleListItem[]
  total: number
}

/** 搜索请求参数 (合并业务关键字与 PoW 凭证) */
export interface SearchArticlesParams {
  keyword: string
}

// ================= API 方法 =================

/**
 * [修复 2026-02-23] 逻辑自洽：所有方法增加可选的 config 参数以支持物理中断 (AbortSignal)
 */

/** 获取文章列表 */
export const getArticles = (
  params: { page?: number; size?: number; categoryId?: number; tagId?: number },
  config?: AxiosRequestConfig
) => {
  return api.get<ArticleListRes>('/Article', { ...config, params })
}

/** 获取详情 */
export const getArticleById = (id: number, config?: AxiosRequestConfig) => {
  return api.get<ArticleDetail>(`/Article/${id}`, config)
}

/** 
 * 全站搜索接口 
 * [修复 2026-02-23] 安全性保障：启用 requiresPow 策略。
 * 拦截器将自动计算算力并将证明注入 X-Fsus-Pow-Proof 请求头。
 */
export const searchArticles = (params: SearchArticlesParams, config?: AxiosRequestConfig) => {
  return api.get<ArticleListItem[]>('/Article/search', { 
    ...config, 
    params, 
    requiresPow: true 
  } as AxiosRequestConfig)
}

/** 热门排行 */
export const getHotArticles = (size = 10, config?: AxiosRequestConfig) => {
  return api.get<ArticleListItem[]>('/Article/hot', { 
    ...config, 
    params: { size } 
  })
}

// ================= 管理端 =================

/** 
 * 创建文章
 * [修复 2026-02-23] 安全性保障：强制算力校验，防止自动化垃圾投稿攻击
 */
export const createArticle = (data: any, config?: AxiosRequestConfig) => 
  api.post<{ id: number }>('/Article', data, { 
    ...config, 
    requiresPow: true 
  } as AxiosRequestConfig)

/** 
 * 更新文章
 */
export const updateArticle = (id: number, data: any, config?: AxiosRequestConfig) => 
  api.put<{ id: number }>(`/Article/${id}`, data, { 
    ...config, 
    requiresPow: true 
  } as AxiosRequestConfig)

export const deleteArticle = (id: number, config?: AxiosRequestConfig) => 
  api.delete(`/Article/${id}`, config)

export const restoreArticle = (id: number, config?: AxiosRequestConfig) => 
  api.put(`/Article/restore/${id}`, {}, config)

export const permanentDeleteArticle = (id: number, config?: AxiosRequestConfig) => 
  api.delete(`/Article/permanent/${id}`, config)