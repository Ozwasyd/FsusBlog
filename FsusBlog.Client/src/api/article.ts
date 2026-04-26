import type { AxiosRequestConfig } from 'axios';
import api from './index'
import { FrameType } from '@wasm/protocol/frame';
import { requestBinaryOnly } from '@/services/binaryTransport';
import type { PublicAotShellBundleContract } from '@/helpers/publicAotBundle';

// ================= 基础类型 =================

/** 标签响应 */
export interface Tag {
  id: number
  name: string
}

export interface PopularArticleSummaryResponse {
  id: number
  title: string
  views: number
}

/** 
 * 文章列表项响应
 */
export interface ArticleListItemResponse {
  id: number;
  title: string;
  summary: string; 
  views: number;
  createTime: string; // 后端 UTC 字符串
  category: {
    id: number;
    name: string;
  };
  tags: Tag[];
}

/** 
 * 文章详情响应
 */
export interface ArticleDetailResponse {
  id: number;
  title: string;
  content: string;
  summary: string;
  views: number;
  createTime: string; // 后端 UTC 字符串
  category: {
    id: number; 
    name: string; 
  };
  tags: Tag[];
}

/** 分页响应 */
export interface PageResponse<T> {
  items: T[]
  total: number
}

export interface ArticleWriteRequest {
  title: string
  content: string
  summary: string
  categoryId: number | undefined
  tagIds: number[]
  aotBundle?: PublicAotShellBundleContract | null
}

// ================= API 方法 =================

/**
 * [修复 2026-02-23] 逻辑自洽：所有方法增加可选的 config 参数以支持物理中断 (AbortSignal)
 */

/** 获取文章列表 */
export const getArticles = (
  params: { page?: number; size?: number; categoryId?: number; tagId?: number; isDeleted?: boolean },
  config?: AxiosRequestConfig
) => {
  const normalized = {
    page: params.page ?? 1,
    size: params.size ?? 10,
    categoryId: params.categoryId,
    tagId: params.tagId,
    isDeleted: params.isDeleted ?? false
  };

  const search = new URLSearchParams();
  search.set('page', String(normalized.page));
  search.set('size', String(normalized.size));
  search.set('isDeleted', String(normalized.isDeleted));
  if (normalized.categoryId !== undefined) search.set('categoryId', String(normalized.categoryId));
  if (normalized.tagId !== undefined) search.set('tagId', String(normalized.tagId));

  return requestBinaryOnly<PageResponse<ArticleListItemResponse>>({
    binaryUrl: `/api/binary/article?${search.toString()}`,
    frameType: FrameType.ArticleList,
    signal: config?.signal as AbortSignal | undefined
  });
}

/** 获取详情 */
export const getArticleById = (id: number, config?: AxiosRequestConfig) => {
  return requestBinaryOnly<ArticleDetailResponse>({
    binaryUrl: `/api/binary/article/${id}`,
    frameType: FrameType.ArticleDetail,
    signal: config?.signal as AbortSignal | undefined
  });
}

/** 热门排行 */
export const getHotArticles = (size = 10, config?: AxiosRequestConfig) => {
  return requestBinaryOnly<PopularArticleSummaryResponse[]>({
    binaryUrl: `/api/binary/article/hot?size=${size}`,
    frameType: FrameType.ArticleHot,
    signal: config?.signal as AbortSignal | undefined
  });
}

// ================= 管理端 =================

/** 
 * 创建文章
 * [修复 2026-02-23] 安全性保障：强制算力校验，防止自动化垃圾投稿攻击
 */
export const createArticle = (data: ArticleWriteRequest, config?: AxiosRequestConfig) => 
  api.post<{ id: number }>('/Article', data, { 
    ...config, 
    requiresPow: true 
  } as AxiosRequestConfig)

/** 
 * 更新文章
 */
export const updateArticle = (id: number, data: ArticleWriteRequest, config?: AxiosRequestConfig) => 
  api.put<{ id: number }>(`/Article/${id}`, data, { 
    ...config, 
    requiresPow: true 
  } as AxiosRequestConfig)

export const uploadArticleAotBundle = (
  id: number,
  bundle: PublicAotShellBundleContract,
  config?: AxiosRequestConfig
) =>
  api.post(`/Article/${id}/aot-bundle`, bundle, {
    ...config,
    requiresPow: true
  } as AxiosRequestConfig)

export const deleteArticle = (id: number, config?: AxiosRequestConfig) => 
  api.delete(`/Article/${id}`, {
    ...config,
    requiresPow: true
  } as AxiosRequestConfig)

export const restoreArticle = (id: number, config?: AxiosRequestConfig) => 
  api.put(`/Article/restore/${id}`, {}, {
    ...config,
    requiresPow: true
  } as AxiosRequestConfig)

export const permanentDeleteArticle = (id: number, config?: AxiosRequestConfig) => 
  api.delete(`/Article/permanent/${id}`, {
    ...config,
    requiresPow: true
  } as AxiosRequestConfig)
